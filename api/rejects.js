import { kv } from '@vercel/kv';

// View the last ~100 score rejections, newest first.
// Usage: curl -H "x-admin: <SECRET>" https://chungus-jumper.vercel.app/api/rejects
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  try {
    const provided = req.headers['x-admin'];
    const stored = await kv.get('chungus:admin-secret');
    if (!stored || !provided || provided !== stored) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const raw = await kv.lrange('chungus:rejects', 0, 99);
    const items = (raw || []).map(s => {
      try { return typeof s === 'string' ? JSON.parse(s) : s; }
      catch { return { raw: String(s) }; }
    });
    return res.status(200).json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error('rejects error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
