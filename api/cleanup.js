import { kv } from '@vercel/kv';
import crypto from 'node:crypto';
import { MAX_MCAP } from './_lib.js';

// One-shot cleanup: removes leaderboard entries whose mcap exceeds MAX_MCAP.
// Usage:
//   curl -X POST -H "x-admin: <SECRET>" https://chungus-jumper.vercel.app/api/cleanup
// SECRET is stored at chungus:admin-secret on first call without the header
// (rotate by deleting that KV key).
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  try {
    const provided = req.headers['x-admin'];
    const stored = await kv.get('chungus:admin-secret');
    if (!stored) {
      // bootstrap: first call sets the secret and returns it ONCE
      const fresh = process.env.ADMIN_SECRET || crypto.randomBytes(24).toString('hex');
      await kv.set('chungus:admin-secret', fresh);
      return res.status(200).json({
        ok: true,
        bootstrapped: true,
        admin_secret: fresh,
        note: 'save this secret; future calls require x-admin header. did NOT clean up — call again with the header.',
      });
    }
    if (!provided || provided !== stored) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // remove entries with absurd mcap by score (sorted-set range)
    const removedByScore = await kv.zremrangebyscore('chungus:lb', MAX_MCAP + 1, '+inf');

    // also walk the rest and prune any malformed JSON or out-of-bounds height
    const all = await kv.zrange('chungus:lb', 0, -1, { rev: true });
    let removedJunk = 0;
    for (const member of all || []) {
      try {
        const e = typeof member === 'string' ? JSON.parse(member) : member;
        if (!e || !Number.isFinite(e.mcap) || e.mcap < 0 || e.mcap > MAX_MCAP) {
          await kv.zrem('chungus:lb', member);
          removedJunk++;
        }
      } catch {
        await kv.zrem('chungus:lb', member);
        removedJunk++;
      }
    }

    return res.status(200).json({ ok: true, removedByScore, removedJunk });
  } catch (e) {
    console.error('cleanup error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
