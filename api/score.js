import { kv } from '@vercel/kv';
import {
  applyCors, isAllowedOrigin, verifyToken,
  sanitizeName, sanitizeZone, getClientIp,
  MAX_MCAP, MAX_MCAP_PER_SEC, MIN_PLAY_MS, MAX_TOKEN_AGE_MS,
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

    // ── single-use check ────────────────────────────────────
    const claimed = await kv.set(`chungus:nonce:${v.nonce}`, '1', { nx: true, ex: 60 * 60 });
    if (!claimed) return res.status(409).json({ error: 'token already used' });

    // ── per-IP rate limit ───────────────────────────────────
    const ip = getClientIp(req);
    const ipKey = `chungus:ip:${ip}`;
    const ipCount = await kv.incr(ipKey);
    if (ipCount === 1) await kv.expire(ipKey, 60 * 60);
    if (ipCount > RATE_LIMIT_PER_HOUR) return res.status(429).json({ error: 'rate limited' });

    // ── value sanitization ──────────────────────────────────
    const cleanName   = sanitizeName(name);
    const cleanMcap   = Math.max(0, Math.floor(Number(mcap) || 0));
    const cleanHeight = Math.max(0, Math.floor(Number(height) || 0));
    const cleanZone   = sanitizeZone(zone);

    if (!Number.isFinite(cleanMcap) || cleanMcap > MAX_MCAP) {
      return res.status(400).json({ error: 'mcap out of range' });
    }

    // mcap-per-second sanity: realistic top ~$1.6M per ~30s = ~53k/s; cap at 50k/s
    const elapsedSec = age / 1000;
    if (cleanMcap > elapsedSec * MAX_MCAP_PER_SEC) {
      return res.status(400).json({ error: 'fishy mcap rate' });
    }

    // mcap must at least cover height contribution (mcap = h*1000 + coins*1000*combo)
    if (cleanMcap > 0 && cleanMcap < cleanHeight * 1000) {
      return res.status(400).json({ error: 'mcap below floor' });
    }
    // upper structural bound: max combo is 5x, max coin contribution ≈ 5x height contribution
    // so mcap should never exceed ~6x height*1000 unless they pumpcandle a ton (allow 20x slack)
    if (cleanHeight > 0 && cleanMcap > cleanHeight * 1000 * 30) {
      return res.status(400).json({ error: 'mcap/height mismatch' });
    }

    const entry = { name: cleanName, mcap: cleanMcap, height: cleanHeight, zone: cleanZone, t: now };

    await kv.zadd('chungus:lb', { score: entry.mcap, member: JSON.stringify(entry) });
    await kv.zremrangebyrank('chungus:lb', 0, -1 - LB_SIZE);

    return res.status(200).json({ ok: true, entry });
  } catch (e) {
    console.error('score error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
