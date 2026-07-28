/*
 * Authoritative daily-limit check for promo codes, backed by the shared Redis
 * order store rather than any one device's localStorage. Multiple tablets hit
 * this same endpoint, so a code used up on one device is correctly seen as
 * used up on every other device — a client-only count can't do that.
 */
const STORAGE_KEY = 'edenGrillOrders';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

/* Server is the source of truth for the actual threshold; the client only
   needs to know which codes require this round-trip at all (see index.html). */
const PROMO_DAILY_LIMIT = { 'MGR69': 3 };

const TZ = 'America/Chicago';
function localDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

async function kvCommand(command) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured');
  const args = Array.prototype.slice.call(arguments, 1);
  const body = JSON.stringify([command].concat(args));
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error('KV error: ' + (text || res.status));
  const data = JSON.parse(text);
  return data.result;
}

const ALLOWED_ORIGINS = [
  'https://eden-grill.vercel.app',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Eden-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expectedKey = process.env.POS_API_KEY || '';
  if (!expectedKey) return res.status(503).json({ error: 'POS_API_KEY not configured on the server' });
  if ((req.headers['x-eden-key'] || '') !== expectedKey) return res.status(401).json({ error: 'Unauthorized' });

  const code = String(req.query.code || '').toUpperCase();
  const name = String(req.query.name || '').trim().toLowerCase();
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });

  const limit = PROMO_DAILY_LIMIT[code];
  if (limit === undefined) {
    /* Nothing caps this code — always allowed, no need to look at order history. */
    return res.status(200).json({ allowed: true, uses: 0, limit: null });
  }

  try {
    if (!KV_URL || !KV_TOKEN) {
      /* No shared store configured — fail closed on a limited code rather
         than let it be used with no way to enforce the cap. */
      return res.status(200).json({ allowed: false, uses: null, limit: limit, error: 'KV not configured' });
    }

    const orders = JSON.parse((await kvCommand('GET', STORAGE_KEY)) || '[]');
    const today = localDateKey(new Date());
    const uses = orders.filter(function (o) {
      return o.promoCode === code &&
        ((o.customer && o.customer.name) || '').trim().toLowerCase() === name &&
        localDateKey(new Date(o.timestamp)) === today;
    }).length;

    return res.status(200).json({ allowed: uses < limit, uses: uses, limit: limit });
  } catch (err) {
    console.error('promo-usage API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
