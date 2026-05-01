import { kv } from '@vercel/kv';
import {
  applyCors, isAllowedOrigin, verifyToken,
  sanitizeName, sanitizeZone, getClientIp,
  MAX_MCAP, MAX_MCAP_PER_SEC, MAX_HEIGHT_PER_SEC,
  MIN_PLAY_MS, MAX_TOKEN_AGE_MS, BEAT_GAP_CAP_MS,
  LB_SIZE, RATE_LIMIT_PER_HOUR,
} from './_lib.js';

// Push a reject event to a small KV ring (keeps last ~100) so we can see
// exactly which legit-looking runs are getting rejected and why.
async function logRejection(nonce, reason, ctx = {}) {
  try {
    const entry = JSON.stringify({ t: Date.now(), nonce, reason, ...ctx });
    await kv.lpush('chungus:rejects', entry);
    await kv.ltrim('chungus:rejects', 0, 99);
  } catch {}
}

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
        await logRejection(v.nonce, 'no heartbeat trace', { cleanMcap, beats: session?.beats || 0 });
        return res.status(400).json({ error: 'no heartbeat trace' });
      }
    } else {
      const sinceLastMs = Math.min(now - session.lastBeatTime, BEAT_GAP_CAP_MS);
      const sinceLastSec = sinceLastMs / 1000;

      // 1) final must not diverge crazily from last heartbeat (catches late-edit cheats).
      //    Generous: stacked alon+MAGA+pumpcandle can spike 300k+ in a 2s window;
      //    coin combos with the new 5k base also stack. Allow ~7x avg per second.
      const allowedMcapGrowth   = Math.max(400_000, sinceLastSec * MAX_MCAP_PER_SEC   * 7);
      const allowedHeightGrowth = Math.max(400,     sinceLastSec * MAX_HEIGHT_PER_SEC * 5);
      if (cleanMcap   > session.lastBeatMcap   + allowedMcapGrowth)   {
        await logRejection(v.nonce, 'mcap diverges from heartbeat', { cleanMcap, lastBeatMcap: session.lastBeatMcap, sinceLastSec, allowedMcapGrowth });
        return res.status(400).json({ error: 'mcap diverges from heartbeat' });
      }
      if (cleanHeight > session.lastBeatHeight + allowedHeightGrowth) {
        await logRejection(v.nonce, 'height diverges from heartbeat', { cleanHeight, lastBeatHeight: session.lastBeatHeight, sinceLastSec, allowedHeightGrowth });
        return res.status(400).json({ error: 'height diverges from heartbeat' });
      }

      // 2) overall avg-rate cap on EFFECTIVE play time (alt-tab doesn't extend this).
      //    Legit base ~25-30k mcap/sec, bursts to ~200k/s briefly. Cap at
      //    effectiveSec * 35k * 5 = 175k/s avg + 1.5M flat burst allowance.
      //    A 5s fake gets ≤2.4M; legit 30s burst-heavy lands ≤6.75M.
      const totalEffectiveSec = (session.effectiveMs + sinceLastMs) / 1000;
      const mcapCap = totalEffectiveSec * MAX_MCAP_PER_SEC * 5 + 1_500_000;
      if (cleanMcap > mcapCap) {
        await logRejection(v.nonce, 'mcap exceeds effective rate', { cleanMcap, totalEffectiveSec, mcapCap });
        return res.status(400).json({ error: 'mcap exceeds effective rate' });
      }
      const heightCap = totalEffectiveSec * MAX_HEIGHT_PER_SEC * 5 + 1_500;
      if (cleanHeight > heightCap) {
        await logRejection(v.nonce, 'height exceeds effective rate', { cleanHeight, totalEffectiveSec, heightCap });
        return res.status(400).json({ error: 'height exceeds effective rate' });
      }

      // 3) beats-per-effective-second sanity: legit clients beat every ~2s.
      //    Require 1 beat per 6s minimum (3x slack on a 2s cadence) — only
      //    catches truly degenerate bots that submit with almost no beats.
      const minBeats = Math.floor(session.effectiveMs / 6_000);
      if (session.beats < minBeats) {
        await logRejection(v.nonce, 'beat cadence too sparse', { beats: session.beats, effectiveMs: session.effectiveMs, minBeats });
        return res.status(400).json({ error: 'beat cadence too sparse' });
      }
    }

    // structural: mcap shouldn't be wildly below the height contribution.
    // Allow a tolerance for casino losses (-250k per blackjack loss) — a player
    // can realistically dump several million in mcap at the casino while still
    // climbing high. Cheating in this direction only hurts the cheater's score.
    const CASINO_LOSS_TOLERANCE = 5_000_000;
    if (cleanMcap > 0 && cleanMcap < cleanHeight * 1000 - CASINO_LOSS_TOLERANCE) {
      await logRejection(v.nonce, 'mcap below floor', { cleanMcap, cleanHeight });
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
