import crypto from 'node:crypto';
import { applyCors, isAllowedOrigin, signToken } from './_lib.js';

export default async function handler(req, res) {
  const origin = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const ts = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    const token = await signToken({ ts, nonce });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token, ts });
  } catch (e) {
    console.error('start error:', e);
    return res.status(500).json({ error: 'server error' });
  }
}
