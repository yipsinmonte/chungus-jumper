import { kv } from '@vercel/kv';
import { applyCors, MAX_MCAP } from './_lib.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const raw = await kv.zrange('chungus:lb', 0, 49, { rev: true });
    const parsed = (raw || []).map(e => {
      try {
        if (typeof e === 'string') return JSON.parse(e);
        return e;
      } catch { return null; }
    }).filter(e => e && Number.isFinite(e.mcap) && e.mcap >= 0 && e.mcap <= MAX_MCAP);

    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('leaderboard error:', e);
    return res.status(500).json({ error: 'server error', list: [] });
  }
}
