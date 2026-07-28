const STORAGE_KEY = 'edenGrillOrders';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const RESEND_KEY = process.env.RESEND_API_KEY;
const REPORT_EMAIL = process.env.REPORT_EMAIL || '';

/* The restaurant's local timezone. Vercel Cron only accepts UTC schedules, so
   vercel.json fires this at both UTC hours that could be 2am here (7 and 8,
   depending on DST) — whichever one isn't actually 2am locally right now is
   a no-op below. */
const TZ = 'America/Chicago';
const DAYS_SHOWN = 30;   /* cap the per-day breakdown so the email can't grow forever */

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

/* 'YYYY-MM-DD' in the restaurant's local timezone, not the server's (Vercel
   functions run in UTC, so grouping by raw Date() would put a 9pm CDT order
   into the wrong day). */
function localDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function localHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(date));
}
function friendlyDate(dateKey) {
  /* dateKey is a plain YYYY-MM-DD with no time — parse as noon local to avoid
     the UTC-midnight rollover shifting it a day when formatted. */
  var d = new Date(dateKey + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function money(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }

function buildReport(orders) {
  var byDate = {};
  orders.forEach(function (o) {
    var key = localDateKey(new Date(o.timestamp));
    (byDate[key] = byDate[key] || []).push(o);
  });
  var allDates = Object.keys(byDate).sort().reverse();   /* most recent first */
  var shownDates = allDates.slice(0, DAYS_SHOWN);

  var allTimeRevenue = orders.reduce(function (sum, o) { return sum + (o.total || 0); }, 0);

  var dayTables = shownDates.map(function (dateKey) {
    var dayOrders = byDate[dateKey];
    var items = {};
    dayOrders.forEach(function (o) {
      (o.items || []).forEach(function (it) {
        items[it.name] = (items[it.name] || 0) + (it.quantity || 1);
      });
    });
    var revenue = dayOrders.reduce(function (sum, o) { return sum + (o.total || 0); }, 0);
    var itemRows = Object.keys(items).sort(function (a, b) { return items[b] - items[a]; })
      .map(function (k) { return '<tr><td>' + k + '</td><td style="text-align:center">' + items[k] + '</td></tr>'; })
      .join('');

    return '<h2>' + friendlyDate(dateKey) + '</h2>' +
      '<p style="color:#555;margin:0 0 6px">' + dayOrders.length + ' order' + (dayOrders.length === 1 ? '' : 's') +
      ' &middot; ' + money(revenue) + '</p>' +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:18px">' +
      '<tr><th>Item</th><th>Qty</th></tr>' +
      (itemRows || '<tr><td colspan="2">No items</td></tr>') +
      '</table>';
  }).join('');

  var rangeNote = allDates.length > shownDates.length
    ? '<p style="color:#888;font-size:0.85em">Showing the most recent ' + DAYS_SHOWN + ' of ' + allDates.length + ' days on record.</p>'
    : '';

  var subjectDate = shownDates.length ? friendlyDate(shownDates[0]) : friendlyDate(localDateKey(new Date()));

  return {
    subject: 'Eden Grill Daily Report - ' + subjectDate,
    html: '<h1>Eden Grill Daily Report</h1>' +
      '<h2>All-Time Summary</h2>' +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:18px">' +
      '<tr><th>Total Orders</th><th>Total Revenue</th><th>Days on Record</th></tr>' +
      '<tr><td style="text-align:center">' + orders.length + '</td>' +
      '<td style="text-align:center">' + money(allTimeRevenue) + '</td>' +
      '<td style="text-align:center">' + allDates.length + '</td></tr>' +
      '</table>' +
      rangeNote +
      dayTables,
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

    /* GET = Vercel Cron. POST = the POS's "Email Report" button, which should
       always send on demand. Two cron entries exist (one per possible DST
       offset); the one that doesn't land on local 2am no-ops here. */
    if (req.method === 'GET') {
      var now = new Date();
      var hour = localHour(now);
      if (hour !== 2) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'not the scheduled local hour (currently ' + hour + ')' });
      }

      /* Guard against a duplicate send if Vercel retries the invocation, or
         both cron entries somehow land on hour 2 around a DST transition. */
      var dedupeKey = 'edenGrillReportSent:' + localDateKey(now);
      var claimed = await kvCommand('SET', dedupeKey, '1', 'NX', 'EX', 82800);
      if (!claimed) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'already sent for today' });
      }
    }

    const orders = JSON.parse((await kvCommand('GET', STORAGE_KEY)) || '[]');
    const report = buildReport(orders);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Eden Grill Reports <reports@littlethingsnow.com>',
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
