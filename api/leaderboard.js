import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    // top 50 by mcap descending
    const raw = await kv.zrange('chungus:lb', 0, 49, { rev: true });
    const parsed = (raw || []).map(e => {
      try {
        // members may come back as objects already (depending on KV client version)
        if (typeof e === 'string') return JSON.parse(e);
        return e;
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('leaderboard error:', e);
    return res.status(500).json({ error: 'server error', list: [] });
  }
}
