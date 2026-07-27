/*
 * Generates print-menu.html — a customer-facing paper menu — from menu.json.
 * Run: node scripts/build-print-menu.js
 *
 * The POS shows every option; a paper menu should not. The rules below keep
 * the choices that describe the food (flavors, meats, styles) and drop the
 * ones that are just order-taking mechanics (opt-outs, topping checklists).
 */
var fs = require('fs');
var path = require('path');
var QRCode = require('qrcode');

var ROOT = path.join(__dirname, '..');
var menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'menu.json'), 'utf8'));

var SECTIONS = [
  { key: 'onBread', label: 'On Bread' },
  { key: 'onTortilla', label: 'On Tortilla' },
  { key: 'onFry', label: 'On Fry' },
  { key: 'combos', label: 'Combos', note: 'Served with your choice of side and a drink' },
  { key: 'drinks', label: 'Drinks & Snacks' },
  { key: 'lateNight', label: 'Late Night', hours: '9pm – 1am' }
];

/* Groups that only exist to take an order, not to describe the dish.
   Sides and drinks are skipped on combos because the section note covers them. */
var SKIP_GROUP = /^(toppings|pick toppings|exclusions|fries add on's|dipping sauce|choose your veggies|side choice|drink|drink choice)$/i;
var SAUCE_GROUP = /sauce/i;
/* Labels that add nothing next to the item name — print the choices bare. */
var BARE_LABEL = /^(energy drink|drink|chips|candy)$/i;
/* Wing flavors carry their prep in the option name; split them onto their own lines. */
var WET = /^wet sauce\s*-\s*/i;
var DRY = /^dry rub\s*-\s*/i;
var isNegative = function (name) { return /^(no\b|none\b)/i.test(name); };
var optName = function (o) { return typeof o === 'object' ? o.name : o; };
var optPrice = function (o) { return typeof o === 'object' ? o.price : 0; };
/* "Toppings 1" / "Drink 2" are per-person copies of one group. */
var baseLabel = function (l) { return l.replace(/\s*\d+$/, ''); };

var esc = function (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

/* "Pick Your Cheese" -> "Cheese", "Bread/Roll Choice" -> "Bread/Roll" */
function groupNoun(label) {
  return baseLabel(label)
    .replace(/^(pick your|choose your|pick|choose)\s+/i, '')
    .replace(/\s+(choice|options)$/i, '')
    .trim();
}

/* One line per choice, e.g. "Flavor: Plain, Cajun Hot, BBQ" — each starts at the
   left edge so the bold labels line up down the item. Sauces and dressing go last. */
function describe(item) {
  var seen = {};
  var parts = [];
  var hasDressing = false;
  var hasCheese = false;

  (item.optionGroups || []).forEach(function (g) {
    var label = baseLabel(g.label);
    var noun = groupNoun(label);
    if (seen[noun] || SKIP_GROUP.test(label)) return;
    if (g.type !== 'radio') return;
    seen[noun] = true;

    var names = g.options.map(optName).filter(function (n) { return !isNegative(n); });
    if (names.length < 2) return;

    /* Wings: keep wet vs dry visible, one line each, instead of one flat list. */
    var wet = names.filter(function (n) { return WET.test(n); }).map(function (n) { return n.replace(WET, ''); });
    var dry = names.filter(function (n) { return DRY.test(n); }).map(function (n) { return n.replace(DRY, ''); });
    if (wet.length || dry.length) {
      var plain = names.filter(function (n) { return !WET.test(n) && !DRY.test(n); });
      if (wet.length) parts.push('<b>Wet Sauce:</b> ' + esc(wet.join(', ')));
      if (dry.length) parts.push('<b>Dry Rub:</b> ' + esc(dry.join(', ')));
      /* The lone "Plain" option means no sauce at all — say so rather than
         labelling a one-item list "Style/Flavor: Plain". */
      if (plain.length === 1 && /^plain$/i.test(plain[0])) parts.push('<b>Plain:</b> no sauce');
      else if (plain.length) parts.push('<b>' + esc(noun) + ':</b> ' + esc(plain.join(', ')));
      return;
    }
    /* Dressings and cheeses, like sauces, are listed in full in the band at the bottom. */
    if (/dressing/i.test(label)) { hasDressing = true; return; }
    if (/cheese/i.test(label)) { hasCheese = true; return; }
    /* "Crinkle Fries or Tots" already names its own choices — don't repeat them. */
    var inTitle = names.every(function (n) {
      return item.name.toLowerCase().indexOf(n.toLowerCase()) >= 0;
    });
    if (inTitle) return;
    if (BARE_LABEL.test(noun)) { parts.push(esc(names.join(', '))); return; }
    parts.push('<b>' + esc(noun) + ':</b> ' + esc(names.join(', ')));
  });

  /* Sauces are a long free list on most items — summarize rather than list. */
  var hasSauce = (item.optionGroups || []).some(function (g) {
    return g.type === 'checkbox' && SAUCE_GROUP.test(g.label);
  });
  if (hasCheese) parts.push('<b>Cheese:</b> your choice');
  if (hasSauce) parts.push('<b>Sauces:</b> your choice');
  if (hasDressing) parts.push('<b>Dressing:</b> your choice');

  return parts;
}

/* Paid extras, deduped across the numbered per-person copies. */
function addOns(item) {
  var seen = {};
  var out = [];
  (item.optionGroups || []).forEach(function (g) {
    g.options.forEach(function (o) {
      var p = optPrice(o);
      if (!p || seen[optName(o)]) return;
      seen[optName(o)] = true;
      out.push(esc(optName(o)) + ' $' + p);
    });
  });
  return out.join(' &nbsp;•&nbsp; ');
}

/* "(For One)" is kept whole (never split across lines) and set a little smaller,
   so short names hold it on the same line and long ones drop it to its own. */
function itemName(name) {
  return esc(name).replace(/\s+\((For (?:One|Two))\)/i, function (_, inner) {
    return ' <span class="serves">(' + inner + ')</span>';
  });
}

function renderItem(item) {
  var price = item.price ? '$' + item.price : '';
  var desc = describe(item);
  var extras = addOns(item);
  return '<li class="item">' +
    '<div class="item-head">' +
      '<span class="item-name">' + itemName(item.name) + '</span>' +
      '<span class="leader"></span>' +
      '<span class="item-price">' + price + '</span>' +
    '</div>' +
    desc.map(function (line) { return '<div class="item-desc">' + line + '</div>'; }).join('') +
    (extras ? '<div class="item-extras">Add ' + extras + '</div>' : '') +
  '</li>';
}

/* Every sauce / dressing offered anywhere, for the reference band at the bottom.
   Wing flavors are skipped (they print under Chicken Wings), and anything that
   also appears in a toppings group — Pico, Jalapenos — is a topping, not a sauce. */
function condiments() {
  var sauces = [], dressings = [], cheeses = [], toppings = {};

  function eachGroup(fn) {
    Object.keys(menu).forEach(function (key) {
      (menu[key] || []).forEach(function (item) {
        (item.optionGroups || []).forEach(fn);
      });
    });
  }

  eachGroup(function (g) {
    if (!/topping/i.test(g.label) || /sauce/i.test(g.label)) return;
    g.options.map(optName).forEach(function (n) { toppings[n] = true; });
  });

  eachGroup(function (g) {
    var names = g.options.map(optName).filter(function (n) { return !isNegative(n); });
    if (/dressing/i.test(g.label)) {
      names.forEach(function (n) { if (dressings.indexOf(n) < 0) dressings.push(n); });
    } else if (/cheese/i.test(g.label)) {
      names.forEach(function (n) { if (cheeses.indexOf(n) < 0) cheeses.push(n); });
    } else if (/sauce/i.test(g.label) && !/wing/i.test(g.label)) {
      names.forEach(function (n) {
        if (!toppings[n] && sauces.indexOf(n) < 0) sauces.push(n);
      });
    }
  });

  return '<section class="condiments">' +
    '<div class="condiment-row"><span class="condiment-label">Cheese</span>' +
      esc(cheeses.join('  •  ')) + '</div>' +
    '<div class="condiment-row"><span class="condiment-label">Sauces</span>' +
      esc(sauces.join('  •  ')) + '</div>' +
    '<div class="condiment-row"><span class="condiment-label">Dressings</span>' +
      esc(dressings.join('  •  ')) + '</div>' +
  '</section>';
}

/* Grid rows are as tall as their tallest cell, so a short item sitting beside a
   wordy one wastes the difference. Ordering each section tallest-first pushes the
   short entries into the final row, where they pad nothing. Menu order in the POS
   is untouched — this is a print-layout concern only. */
var CHARS_PER_LINE = 26;      /* rough fit for a 127px cell at 7.5pt */
function estimateLines(item) {
  var lines = Math.ceil(item.name.length / 17);            /* name is bold, 9.5pt */
  describe(item).forEach(function (d) {
    lines += Math.ceil(d.replace(/<[^>]+>/g, '').length / CHARS_PER_LINE);
  });
  var extras = addOns(item).replace(/<[^>]+>|&nbsp;/g, '');
  if (extras) lines += Math.ceil((extras.length + 4) / CHARS_PER_LINE);
  return lines;
}

function renderSection(sec) {
  var items = (menu[sec.key] || []).slice()
    .sort(function (a, b) { return estimateLines(b) - estimateLines(a); });
  if (!items.length) return '';
  return '<section class="section">' +
    '<h2>' + esc(sec.label) +
      (sec.hours ? '<span class="section-hours">' + esc(sec.hours) + '</span>' : '') +
    '</h2>' +
    (sec.note ? '<p class="section-note">' + esc(sec.note) + '</p>' : '') +
    '<ul class="items">' + items.map(renderItem).join('') + '</ul>' +
  '</section>';
}

var logo = '';
try {
  logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'logo.png')).toString('base64');
} catch (e) { /* logo is optional */ }

/* Scanning the printed sheet pulls this same page up on a phone. The QR is
   inlined as SVG so the file stays self-contained and prints crisply. */
var MENU_URL = 'https://eden-grill.vercel.app/print-menu.html';

function buildHtml(qrSvg) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<meta charset="utf-8">\n' +
'<title>Eden Grill OKC — Menu</title>\n' +
'<style>\n' +
'  @page { size: letter portrait; margin: 0.5in; }\n' +
'  * { box-sizing: border-box; }\n' +
'  body { margin: 0; padding: 0.5in; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;\n' +
'         color: #111; background: #fff; font-size: 9pt; line-height: 1.25; }\n' +
/* Logo sits beside the title rather than above it — the stacked version cost
   roughly an inch and a half of the first page. */
'  header { display: flex; align-items: center; justify-content: center; gap: 14px;\n' +
'           border-bottom: 3px double #111; padding-bottom: 6px; margin-bottom: 10px; }\n' +
'  header img { max-height: 40px; }\n' +
'  header > div { text-align: center; }\n' +
'  header h1 { font-size: 19pt; letter-spacing: 3px; margin: 0; text-transform: uppercase; }\n' +
'  header .tagline { font-size: 8pt; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-top: 1px; }\n' +
'  .section { break-inside: avoid; margin-bottom: 13px; }\n' +
'  .section h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 2px;\n' +
'                border-bottom: 1.5px solid #111; padding-bottom: 3px;\n' +
'                display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n' +
'  .section-hours { font-size: 8.5pt; letter-spacing: 1px; font-weight: 400; text-transform: none; color: #555; }\n' +
'  .section-note { font-size: 8pt; font-style: italic; color: #555; margin: 3px 0 6px; }\n' +
/* Every section runs the full page width, items side by side. */
'  .items { list-style: none; margin: 6px 0 0; padding: 0;\n' +
'           display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px 22px; }\n' +
'  .item { break-inside: avoid; margin-bottom: 6px; }\n' +
'  .item-head { display: flex; align-items: baseline; gap: 4px; }\n' +
'  .item-name { font-weight: 700; }\n' +
'  .serves { font-size: 7pt; font-weight: 400; white-space: nowrap; }\n' +
'  .leader { flex: 1; border-bottom: 1px dotted #999; transform: translateY(-3px); }\n' +
'  .item-price { font-weight: 700; font-variant-numeric: tabular-nums; }\n' +
'  .item-desc { font-size: 7pt; color: #444; margin-top: 1px; }\n' +
'  .item-extras { font-size: 7pt; color: #666; font-style: italic; margin-top: 1px; }\n' +
'  .condiments { margin-top: 9px; border: 1px solid #111; border-radius: 4px; padding: 5px 8px; }\n' +
'  .condiment-row { font-size: 7.5pt; line-height: 1.32; }\n' +
'  .condiment-row + .condiment-row { margin-top: 3px; padding-top: 3px; border-top: 1px dotted #999; }\n' +
'  .condiment-label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; font-size: 7pt; }\n' +
'  .condiment-label::after { content: ":"; margin-right: 5px; }\n' +
'  footer { margin-top: 12px; border-top: 3px double #111; padding-top: 8px;\n' +
'           text-align: center; font-size: 8.5pt; color: #555; }\n' +
'  .qr { line-height: 0; position: relative; display: inline-block; }\n' +
'  .qr svg { width: 70px; height: 70px; }\n' +
/* The logo covers the middle modules; error correction level H (30%) carries
   the loss. Keep the white pad — the logo is black-on-black otherwise. */
'  .qr-logo { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);\n' +
'             width: 20%; background: #fff; padding: 1.5px; border-radius: 1px; }\n' +
'  .qr-caption { font-size: 7pt; letter-spacing: 0.5px; text-transform: uppercase; margin: 2px 0 4px; }\n' +
/* On a phone the print grid is unreadable — one column, larger type, and the
   QR is pointless on the page it links to. */
'  @media screen and (max-width: 700px) {\n' +
'    body { padding: 16px; font-size: 12pt; }\n' +
'    .items { grid-template-columns: 1fr; gap: 0; }\n' +
'    .item { margin-bottom: 10px; }\n' +
'    .item-desc, .item-extras, .serves { font-size: 10pt; }\n' +
'    .section h2 { font-size: 14pt; }\n' +
'    .condiment-row, .condiment-label { font-size: 10pt; }\n' +
'    header h1 { font-size: 22pt; }\n' +
'    .qr, .qr-caption { display: none; }\n' +
'  }\n' +
'  @media print { body { padding: 0; } .noprint { display: none; } }\n' +
'  .noprint { text-align: center; margin-bottom: 14px; }\n' +
'  .noprint button { font: inherit; padding: 8px 20px; border: 1px solid #111; background: #111;\n' +
'                    color: #fff; border-radius: 4px; cursor: pointer; }\n' +
'</style>\n</head>\n<body>\n' +
'<div class="noprint" id="print-bar"><button onclick="window.print()">Print this menu</button></div>\n' +
/* Inside the POS modal the panel has its own Print button, so hide this one. */
'<script>if (window.top !== window.self) document.getElementById("print-bar").style.display = "none";<\/script>\n' +
'<header>\n' +
(logo ? '  <img src="' + logo + '" alt="Eden Grill">\n' : '') +
'  <div>\n' +
'    <h1>Eden Grill OKC</h1>\n' +
'    <div class="tagline">Kitchen &amp; Late Night</div>\n' +
'  </div>\n' +
'</header>\n' +
SECTIONS.map(renderSection).join('\n') + '\n' +
condiments() +
'<footer>\n' +
'  <div class="qr">' + qrSvg +
     (logo ? '<img class="qr-logo" src="' + logo + '" alt="">' : '') + '</div>\n' +
'  <div class="qr-caption">Scan for this menu on your phone</div>\n' +
'  <div>All items made to order</div>\n' +
'</footer>\n' +
'</body>\n</html>\n';
}

QRCode.toString(MENU_URL, { type: 'svg', errorCorrectionLevel: 'H', margin: 0 })
  .then(function (qrSvg) {
    var html = buildHtml(qrSvg);
    fs.writeFileSync(path.join(ROOT, 'print-menu.html'), html);
    console.log('Wrote print-menu.html (' + (html.length / 1024).toFixed(1) + ' KB)');
    console.log('QR points at ' + MENU_URL);
  })
  .catch(function (err) {
    console.error('QR generation failed: ' + err.message);
    process.exit(1);
  });
