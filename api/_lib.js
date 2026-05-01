import { kv } from '@vercel/kv';
import crypto from 'node:crypto';

export const MAX_NAME = 14;
export const MAX_MCAP = 25_000_000;          // loose paranoia ceiling — real bound comes from heartbeat-effective time
export const MAX_MCAP_PER_SEC = 35_000;      // realistic AVG rate over EFFECTIVE play time (top legit ~25-30k/s)
export const MAX_HEIGHT_PER_SEC = 80;        // sustained avg incl. rocket / pumpcandle / idf bursts
export const MIN_PLAY_MS = 5_000;            // shortest plausible run
export const MAX_TOKEN_AGE_MS = 6 * 60 * 1000;   // 6 min — way longer than any realistic single run
export const BEAT_GAP_CAP_MS = 4_000;        // alt-tab gaps beyond this don't add to effective time
export const LB_SIZE = 100;
export const RATE_LIMIT_PER_HOUR = 60;

const ALLOWED_ORIGINS = [
  'https://chungus-jumper.vercel.app',
  'https://chungus.site',
  'https://www.chungus.site',
];

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    // allow any *.vercel.app preview deploy of this repo
    if (u.hostname.endsWith('.vercel.app')) return true;
    // allow localhost dev
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch {}
  return false;
}

export function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin');
  }
  return origin;
}

let cachedSecret = null;
export async function getSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.SCORE_SECRET && process.env.SCORE_SECRET.length >= 16) {
    return cachedSecret = process.env.SCORE_SECRET;
  }
  const stored = await kv.get('chungus:score-secret');
  if (stored) return cachedSecret = stored;
  const fresh = crypto.randomBytes(32).toString('hex');
  await kv.set('chungus:score-secret', fresh);
  return cachedSecret = fresh;
}

export async function signToken({ ts, nonce }) {
  const secret = await getSecret();
  const payload = `${ts}.${nonce}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export async function verifyToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'no token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'bad token' };
  const [tsStr, nonce, sig] = parts;
  const secret = await getSecret();
  const expected = crypto.createHmac('sha256', secret).update(`${tsStr}.${nonce}`).digest('hex');
  if (expected.length !== sig.length) return { ok: false, reason: 'bad signature' };
  let bufA, bufB;
  try {
    bufA = Buffer.from(sig, 'hex');
    bufB = Buffer.from(expected, 'hex');
  } catch { return { ok: false, reason: 'bad signature' }; }
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { ok: false, reason: 'bad signature' };
  }
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad ts' };
  return { ok: true, ts, nonce };
}

export function sanitizeName(name) {
  return String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^\w\s.\-]/g, '')
    .slice(0, MAX_NAME) || 'ANON';
}

export function sanitizeZone(zone) {
  return String(zone || '').replace(/[<>"'`]/g, '').slice(0, 32);
}

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim() || 'unknown';
  return req.socket?.remoteAddress || 'unknown';
}
