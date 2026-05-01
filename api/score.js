import { kv } from '@vercel/kv';
import {
  applyCors, isAllowedOrigin, verifyToken,
  sanitizeName, sanitizeZone, getClientIp,
  MAX_MCAP, MAX_MCAP_PER_SEC, MAX_HEIGHT_PER_SEC,
  MIN_PLAY_MS, MAX_TOKEN_AGE_MS, BEAT_GAP_CAP_MS,
  LB_SIZE, RATE_LIMIT_PER_HOUR,
} from './_lib.js';

export default async function handler(req, res) {
  const origin = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'forbidden' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { name, mcap, height, zone, token } = body || {};

    // ── token validation ────────────────────────────────────
    const v = await verifyToken(token);
    if (!v.ok) return res.status(403).json({ error: 'bad token' });

    const now = Date.now();
    const age = now - v.ts;
    if (age < MIN_PLAY_MS)        return res.status(400).json({ error: 'too quick' });
    if (age > MAX_TOKEN_AGE_MS)   return res.status(400).json({ error: 'token expired' });

    // ── single-use ─────────────────────────────────────────
    const claimed = await kv.set(`chungus:nonce:${v.nonce}`, '1', { nx: true, ex: 60 * 60 });
    if (!claimed) return res.status(409).json({ error: 'token already used' });

    // ── per-IP rate limit ──────────────────────────────────
    const ip = getClientIp(req);
    const ipKey = `chungus:ip:${ip}`;
    const ipCount = await kv.incr(ipKey);
    if (ipCount === 1) await kv.expire(ipKey, 60 * 60);
    if (ipCount > RATE_LIMIT_PER_HOUR) return res.status(429).json({ error: 'rate limited' });

    // ── value sanitization ─────────────────────────────────
    const cleanName   = sanitizeName(name);
    const cleanMcap   = Math.max(0, Math.floor(Number(mcap) || 0));
    const cleanHeight = Math.max(0, Math.floor(Number(height) || 0));
    const cleanZone   = sanitizeZone(zone);

    if (!Number.isFinite(cleanMcap) || cleanMcap > MAX_MCAP) {
      return res.status(400).json({ error: 'mcap out of range' });
    }

    // ── heartbeat-based trajectory check ───────────────────
    // Real protection: the client must have been heartbeating during the run.
    // Effective play time = sum of per-beat gaps (each capped at BEAT_GAP_CAP_MS),
    // so alt-tabbing for 5 minutes contributes ~0 effective seconds.
    const session = await kv.get(`chungus:session:${v.nonce}`);
    if (!session || session.beats < 2) {
      // no/insufficient heartbeats: cap submitted mcap at a tiny "no-trace" allowance
      if (cleanMcap > 50_000) {
        return res.status(400).json({ error: 'no heartbeat trace' });
      }
    } else {
      // 1) final must not diverge crazily from last heartbeat (catches late-edit cheats)
      //    generous burst allowance: alon pump can add ~192k mcap in 1s, rocket can sustain
      //    96 m/s = 96k/s, MAGA doubles. Allow up to ~10x the avg rate per second of gap.
      const sinceLastMs = Math.min(now - session.lastBeatTime, BEAT_GAP_CAP_MS);
      const sinceLastSec = sinceLastMs / 1000;
      const allowedMcapGrowth   = Math.max(300_000, sinceLastSec * MAX_MCAP_PER_SEC   * 10);
      const allowedHeightGrowth = Math.max(300,     sinceLastSec * MAX_HEIGHT_PER_SEC * 5);
      if (cleanMcap   > session.lastBeatMcap   + allowedMcapGrowth)   return res.status(400).json({ error: 'mcap diverges from heartbeat' });
      if (cleanHeight > session.lastBeatHeight + allowedHeightGrowth) return res.status(400).json({ error: 'height diverges from heartbeat' });

      // 2) overall avg-rate cap on effective play time (alt-tab doesn't extend this).
      //    Legit base rate ~25-30k mcap/sec, but stacked bursts (multiple alon pumps
      //    + MAGA doubling + rocket carrots) can sustain ~200k/s for short windows.
      //    Cap at effectiveSec * 35k * 6 = 210k/s avg, plus a flat 2M burst allowance
      //    so short burst-heavy games post correctly. Cheaters with near-zero
      //    effective time still capped at ~2.8M (4s gap × 210k + 2M).
      const totalEffectiveSec = (session.effectiveMs + sinceLastMs) / 1000;
      if (cleanMcap > totalEffectiveSec * MAX_MCAP_PER_SEC * 6 + 2_000_000) {
        return res.status(400).json({ error: 'mcap exceeds effective rate' });
      }
      if (cleanHeight > totalEffectiveSec * MAX_HEIGHT_PER_SEC * 6 + 2_000) {
        return res.status(400).json({ error: 'height exceeds effective rate' });
      }
    }

    // structural: mcap can't be lower than the height contribution alone
    if (cleanMcap > 0 && cleanMcap < cleanHeight * 1000) {
      return res.status(400).json({ error: 'mcap below floor' });
    }

    const entry = { name: cleanName, mcap: cleanMcap, height: cleanHeight, zone: cleanZone, t: now };

    await kv.zadd('chungus:lb', { score: entry.mcap, member: JSON.stringify(entry) });
    await kv.zremrangebyrank('chungus:lb', 0, -1 - LB_SIZE);

    // session no longer needed
    try { await kv.del(`chungus:session:${v.nonce}`); } catch {}

    return res.status(200).json({ ok: true, entry });
  } catch (e) {
    console.error('score error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
