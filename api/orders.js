const STORAGE_KEY = 'edenGrillOrders';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

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

/* Browsers the POS runs in: the site itself, plus the Capacitor webview origins.
   Note CORS only restrains browser JS — the POS_API_KEY below is what actually
   stops curl. */
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Eden-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  /* Fails closed: without POS_API_KEY set in the Vercel env nothing is served,
     so a missing config can't quietly leave order history public. */
  const expectedKey = process.env.POS_API_KEY || '';
  if (!expectedKey) {
    return res.status(503).json({ error: 'POS_API_KEY not configured on the server' });
  }
  const sentKey = req.headers['x-eden-key'] || '';
  if (sentKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (!KV_URL || !KV_TOKEN) {
      return res.status(200).json({ ok: false, error: 'KV not configured', storage: 'local' });
    }

    if (req.method === 'POST') {
      const order = req.body;
      if (!order || !order.id) return res.status(400).json({ error: 'Invalid order' });

      const orders = JSON.parse((await kvCommand('GET', STORAGE_KEY)) || '[]');
      orders.push(order);
      await kvCommand('SET', STORAGE_KEY, JSON.stringify(orders));

      return res.status(200).json({ ok: true, count: orders.length });
    }

    if (req.method === 'GET') {
      const orders = JSON.parse((await kvCommand('GET', STORAGE_KEY)) || '[]');
      return res.status(200).json(orders);
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (id === 'all') {
        await kvCommand('SET', STORAGE_KEY, '[]');
        return res.status(200).json({ ok: true, count: 0 });
      }
      const orders = JSON.parse((await kvCommand('GET', STORAGE_KEY)) || '[]');
      const filtered = orders.filter(function (o) { return o.id !== id; });
      await kvCommand('SET', STORAGE_KEY, JSON.stringify(filtered));
      return res.status(200).json({ ok: true, count: filtered.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('orders API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
