import { kv } from '@vercel/kv';
import {
  applyCors, isAllowedOrigin, verifyToken,
  MAX_MCAP_PER_SEC, MAX_HEIGHT_PER_SEC, MAX_TOKEN_AGE_MS, BEAT_GAP_CAP_MS,
} from './_lib.js';

// Heartbeat: client posts current mcap/height every ~2s while alive + visible.
// Server tracks effective play time (capped per-gap so alt-tab can't extend it),
// max-seen values, and validates per-beat growth rate. /api/score then cross-checks
// the final submission against this trajectory.
export default async function handler(req, res) {
  const origin = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!isAllowedOrigin(origin)) return res.status(403).json({ error: 'forbidden' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { token, mcap, height } = body || {};
    const v = await verifyToken(token);
    if (!v.ok) return res.status(403).json({ error: 'bad token' });

    const now = Date.now();
    const age = now - v.ts;
    if (age > MAX_TOKEN_AGE_MS) return res.status(400).json({ error: 'token expired' });

    const cleanMcap   = Math.max(0, Math.floor(Number(mcap) || 0));
    const cleanHeight = Math.max(0, Math.floor(Number(height) || 0));

    const sessionKey = `chungus:session:${v.nonce}`;
    let session = await kv.get(sessionKey);
    if (!session) {
      session = {
        firstBeatTime: now,
        lastBeatTime:  now,
        effectiveMs:   0,
        maxMcap:       0,
        maxHeight:     0,
        lastBeatMcap:  0,
        lastBeatHeight:0,
        beats:         0,
      };
    }

    // monotonicity: mcap/height never go backwards in a real run
    if (cleanMcap   < session.lastBeatMcap)   return res.status(400).json({ error: 'mcap regressed' });
    if (cleanHeight < session.lastBeatHeight) return res.status(400).json({ error: 'height regressed' });

    const sinceLastMs = Math.min(now - session.lastBeatTime, BEAT_GAP_CAP_MS);
    const sinceLastSec = Math.max(0.05, sinceLastMs / 1000);
    const mcapDelta   = cleanMcap   - session.lastBeatMcap;
    const heightDelta = cleanHeight - session.lastBeatHeight;

    // 2x slack on mcap to allow MAGA bursts; 1.5x on height to allow IDF giga-bounce
    if (mcapDelta   > sinceLastSec * MAX_MCAP_PER_SEC   * 2.0) return res.status(400).json({ error: 'mcap rate' });
    if (heightDelta > sinceLastSec * MAX_HEIGHT_PER_SEC * 1.5) return res.status(400).json({ error: 'height rate' });

    session.effectiveMs    += sinceLastMs;
    session.lastBeatTime    = now;
    session.lastBeatMcap    = cleanMcap;
    session.lastBeatHeight  = cleanHeight;
    if (cleanMcap   > session.maxMcap)   session.maxMcap   = cleanMcap;
    if (cleanHeight > session.maxHeight) session.maxHeight = cleanHeight;
    session.beats++;

    // expire ~1 minute after token max age
    await kv.set(sessionKey, session, { ex: Math.ceil(MAX_TOKEN_AGE_MS / 1000) + 60 });

    return res.status(200).json({ ok: true, effectiveMs: session.effectiveMs, beats: session.beats });
  } catch (e) {
    console.error('beat error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
