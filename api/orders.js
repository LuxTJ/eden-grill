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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

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
