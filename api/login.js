/*
 * Staff login for the POS.
 *
 * The POS is a static page, so it can't hold a secret — anyone can read what is
 * served to the browser. Instead the password is checked here against the server
 * env, and only on success does the device receive POS_API_KEY, which it stores
 * locally and sends on every /api/orders call.
 */
const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://eden-grill.vercel.app',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
];

/* Length-safe comparison so a wrong password can't be narrowed by timing. */
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const password = process.env.POS_PASSWORD || '';
  const apiKey = process.env.POS_API_KEY || '';
  if (!password || !apiKey) {
    return res.status(503).json({ error: 'Login not configured — set POS_PASSWORD and POS_API_KEY' });
  }

  const sent = (req.body && req.body.password) || '';
  if (!sent || !sameSecret(sent, password)) {
    /* Slow down guessing a little without holding the function open long. */
    await new Promise(function (r) { setTimeout(r, 400); });
    return res.status(401).json({ error: 'Wrong password' });
  }

  return res.status(200).json({ ok: true, key: apiKey });
};
