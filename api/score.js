import { kv } from '@vercel/kv';

const MAX_NAME = 14;
const MAX_MCAP = 1_000_000_000;     // $1B sanity cap
const LB_SIZE = 100;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { name, mcap, height, zone } = body || {};

    const cleanName = String(name || '').trim().toUpperCase().slice(0, MAX_NAME) || 'ANON';
    const cleanMcap = Math.max(0, Math.floor(Number(mcap) || 0));
    if (cleanMcap > MAX_MCAP) {
      return res.status(400).json({ error: 'fishy mcap' });
    }
    const entry = {
      name: cleanName,
      mcap: cleanMcap,
      height: Math.max(0, Math.floor(Number(height) || 0)),
      zone: String(zone || '').slice(0, 32),
      t: Date.now(),
    };

    // store in sorted set: score = mcap (so ZRANGE with rev=true returns top)
    await kv.zadd('chungus:lb', { score: entry.mcap, member: JSON.stringify(entry) });
    // trim to top LB_SIZE
    await kv.zremrangebyrank('chungus:lb', 0, -1 - LB_SIZE);

    return res.status(200).json({ ok: true, entry });
  } catch (e) {
    console.error('score error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
