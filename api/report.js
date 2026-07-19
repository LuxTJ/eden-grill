const STORAGE_KEY = 'edenGrillOrders';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const REPORT_EMAIL = process.env.REPORT_EMAIL || '';

async function kvCommand(command) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured');
  const args = Array.prototype.slice.call(arguments, 1);
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: command, args: args }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function buildReport(orders) {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var todayOrders = orders.filter(function (o) { return new Date(o.timestamp) >= today; });

  var itemMap = {};
  orders.forEach(function (o) {
    (o.items || []).forEach(function (it) {
      var key = it.name;
      if (!itemMap[key]) itemMap[key] = 0;
      itemMap[key] += it.quantity || 1;
    });
  });
  var sorted = Object.keys(itemMap).sort(function (a, b) { return itemMap[b] - itemMap[a]; });

  var todayItems = {};
  todayOrders.forEach(function (o) {
    (o.items || []).forEach(function (it) {
      var key = it.name;
      if (!todayItems[key]) todayItems[key] = 0;
      todayItems[key] += it.quantity || 1;
    });
  });

  var todayItemRows = Object.keys(todayItems).sort(function (a, b) { return todayItems[b] - todayItems[a]; })
    .map(function (k) { return '<tr><td>' + k + '</td><td style="text-align:center">' + todayItems[k] + '</td></tr>'; }).join('');

  var rows = sorted.map(function (k) { return '<tr><td>' + k + '</td><td style="text-align:center">' + itemMap[k] + '</td></tr>'; }).join('');

  var todayRows = todayOrders.map(function (o) {
    var when = new Date(o.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var items = (o.items || []).map(function (it) { return it.quantity + 'x ' + it.name; }).join(', ');
    return '<tr><td>#' + o.id.slice(-6) + '</td><td>' + (o.customer.name || '-') + '</td><td>' + when + '</td><td>' + items + '</td></tr>';
  }).join('');

  var dateStr = new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return {
    subject: 'Eden Grill Daily Report - ' + dateStr,
    html: '<h1>Eden Grill Daily Report</h1>' +
      '<p><strong>' + dateStr + '</strong></p>' +
      '<h2>Summary</h2>' +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">' +
      '<tr><th>Total Orders (All Time)</th><th>Today Orders</th></tr>' +
      '<tr><td style="text-align:center">' + orders.length + '</td><td style="text-align:center">' + todayOrders.length + '</td></tr>' +
      '</table>' +
      '<h2>Items Sold Today</h2>' +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">' +
      '<tr><th>Item</th><th>Qty</th></tr>' +
      (todayItemRows || '<tr><td colspan="2">No orders today</td></tr>') +
      '</table>' +
      '<h2>All-Time Items Sold</h2>' +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">' +
      '<tr><th>Item</th><th>Qty</th></tr>' +
      rows +
      '</table>' +
      '<h2>Today Orders</h2>' +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">' +
      '<tr><th>Order</th><th>Name</th><th>Time</th><th>Items</th></tr>' +
      (todayRows || '<tr><td colspan="4">No orders today</td></tr>') +
      '</table>',
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!KV_URL || !KV_TOKEN) {
      return res.status(200).json({ error: 'KV not configured' });
    }

    var keySent = req.query.key || (req.body && req.body.key) || '';
    var expectedKey = process.env.REPORT_KEY || '';

    if (!RESEND_KEY || !REPORT_EMAIL) {
      return res.status(200).json({ error: 'Report email not configured — set RESEND_API_KEY and REPORT_EMAIL env vars.' });
    }

    if (expectedKey && keySent !== expectedKey) {
      return res.status(403).json({ error: 'Invalid key' });
    }

    const orders = JSON.parse((await kvCommand('GET', STORAGE_KEY)) || '[]');
    const report = buildReport(orders);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Eden Grill Reports <onboarding@resend.dev>',
        to: [REPORT_EMAIL],
        subject: report.subject,
        html: report.html,
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error('Resend error:', emailData);
      return res.status(200).json({ error: 'Email send failed: ' + (emailData.message || emailRes.status) });
    }

    return res.status(200).json({ ok: true, emailId: emailData.id, orderCount: orders.length });
  } catch (err) {
    console.error('report API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
