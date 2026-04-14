// Skribby webhook HMAC — https://skribby.io/docs/guides/webhook-security
const crypto = require('crypto');

const TOLERANCE_SEC = 300;

function verifySkribbySignature(req) {
  const secret = (process.env.SKRIBBY_WEBHOOK_SECRET || '').trim();
  if (!secret) return { ok: true, skipped: true };

  const signature = req.headers['x-skribby-signature'];
  const timestamp = req.headers['x-skribby-timestamp'];
  const rawBody   = req.rawBody;

  if (!signature || timestamp == null || rawBody === undefined) {
    return { ok: false, reason: 'Missing signature headers or raw body' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'Invalid timestamp' };
  }

  const nowSec = Date.now() / 1000;
  if (Math.abs(nowSec - ts) > TOLERANCE_SEC) {
    return { ok: false, reason: 'Timestamp outside tolerance window' };
  }

  const payload = `${timestamp}.${rawBody}`;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  const got = String(signature).trim();
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return { ok: false, reason: 'Invalid signature' };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'Invalid signature' };
  } catch {
    return { ok: false, reason: 'Invalid signature' };
  }

  return { ok: true };
}

module.exports = { verifySkribbySignature };
