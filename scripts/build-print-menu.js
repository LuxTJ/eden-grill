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

/* One line describing the real choices, e.g. "Flavor: Plain, Cajun Hot, BBQ" */
function describe(item) {
  var seen = {};
  var parts = [];

  (item.optionGroups || []).forEach(function (g) {
    var label = baseLabel(g.label);
    var noun = groupNoun(label);
    if (seen[noun] || SKIP_GROUP.test(label)) return;
    if (g.type !== 'radio') return;
    seen[noun] = true;

    var names = g.options.map(optName)
      .filter(function (n) { return !isNegative(n); })
      /* "Wet Sauce - Cajun Hot" reads fine on a POS button, not on a menu. */
      .map(function (n) { return n.replace(/^(wet sauce|dry rub)\s*-\s*/i, ''); });
    if (names.length < 2) return;
    parts.push('<b>' + esc(noun) + ':</b> ' + esc(names.join(', ')));
  });

  /* Sauces are a long free list on most items — summarize rather than list. */
  var hasSauce = (item.optionGroups || []).some(function (g) {
    return g.type === 'checkbox' && SAUCE_GROUP.test(g.label);
  });
  if (hasSauce) parts.push('<b>Sauces:</b> your choice');

  return parts.join(' &nbsp;•&nbsp; ');
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

function renderItem(item) {
  var price = item.price ? '$' + item.price : '';
  var desc = describe(item);
  var extras = addOns(item);
  return '<li class="item">' +
    '<div class="item-head">' +
      '<span class="item-name">' + esc(item.name) + '</span>' +
      '<span class="leader"></span>' +
      '<span class="item-price">' + price + '</span>' +
    '</div>' +
    (desc ? '<div class="item-desc">' + desc + '</div>' : '') +
    (extras ? '<div class="item-extras">Add ' + extras + '</div>' : '') +
  '</li>';
}

/* Every sauce / dressing offered anywhere, for the reference band at the bottom.
   Wing flavors are skipped (they print under Chicken Wings), and anything that
   also appears in a toppings group — Pico, Jalapenos — is a topping, not a sauce. */
function condiments() {
  var sauces = [], dressings = [], toppings = {};

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
    } else if (/sauce/i.test(g.label) && !/wing/i.test(g.label)) {
      names.forEach(function (n) {
        if (!toppings[n] && sauces.indexOf(n) < 0) sauces.push(n);
      });
    }
  });

  return '<section class="condiments">' +
    '<div class="condiment-row"><span class="condiment-label">Sauces</span>' +
      esc(sauces.join('  •  ')) + '</div>' +
    '<div class="condiment-row"><span class="condiment-label">Dressings</span>' +
      esc(dressings.join('  •  ')) + '</div>' +
  '</section>';
}

function renderSection(sec) {
  var items = menu[sec.key] || [];
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

var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
'<meta charset="utf-8">\n' +
'<title>Eden Grill OKC — Menu</title>\n' +
'<style>\n' +
'  @page { size: letter portrait; margin: 0.5in; }\n' +
'  * { box-sizing: border-box; }\n' +
'  body { margin: 0; padding: 0.5in; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;\n' +
'         color: #111; background: #fff; font-size: 10.5pt; line-height: 1.3; }\n' +
'  header { text-align: center; border-bottom: 3px double #111; padding-bottom: 10px; margin-bottom: 16px; }\n' +
'  header img { max-height: 90px; margin-bottom: 6px; }\n' +
'  header h1 { font-size: 26pt; letter-spacing: 3px; margin: 0; text-transform: uppercase; }\n' +
'  header .tagline { font-size: 9pt; letter-spacing: 2px; text-transform: uppercase; color: #555; margin-top: 4px; }\n' +
'  .columns { column-count: 2; column-gap: 28px; }\n' +
'  .section { break-inside: avoid-column; margin-bottom: 16px; }\n' +
'  .section h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 2px;\n' +
'                border-bottom: 1.5px solid #111; padding-bottom: 3px;\n' +
'                display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n' +
'  .section-hours { font-size: 8.5pt; letter-spacing: 1px; font-weight: 400; text-transform: none; color: #555; }\n' +
'  .section-note { font-size: 8pt; font-style: italic; color: #555; margin: 3px 0 6px; }\n' +
'  .items { list-style: none; margin: 6px 0 0; padding: 0; }\n' +
'  .item { break-inside: avoid; margin-bottom: 7px; }\n' +
'  .item-head { display: flex; align-items: baseline; gap: 4px; }\n' +
'  .item-name { font-weight: 700; }\n' +
'  .leader { flex: 1; border-bottom: 1px dotted #999; transform: translateY(-3px); }\n' +
'  .item-price { font-weight: 700; font-variant-numeric: tabular-nums; }\n' +
'  .item-desc { font-size: 8pt; color: #444; margin-top: 1px; }\n' +
'  .item-extras { font-size: 8pt; color: #666; font-style: italic; margin-top: 1px; }\n' +
'  .condiments { margin-top: 14px; border: 1.5px solid #111; border-radius: 4px; padding: 8px 10px; }\n' +
'  .condiment-row { font-size: 8.5pt; line-height: 1.5; }\n' +
'  .condiment-row + .condiment-row { margin-top: 4px; padding-top: 4px; border-top: 1px dotted #999; }\n' +
'  .condiment-label { font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-size: 8pt; }\n' +
'  .condiment-label::after { content: ":"; margin-right: 5px; }\n' +
'  footer { margin-top: 12px; border-top: 3px double #111; padding-top: 8px;\n' +
'           text-align: center; font-size: 8.5pt; color: #555; }\n' +
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
'  <h1>Eden Grill OKC</h1>\n' +
'  <div class="tagline">Kitchen &amp; Late Night</div>\n' +
'</header>\n' +
'<div class="columns">\n' +
SECTIONS.map(renderSection).join('\n') +
'\n</div>\n' +
condiments() +
'<footer>All items made to order &nbsp;•&nbsp; Ask your server about daily specials</footer>\n' +
'</body>\n</html>\n';

fs.writeFileSync(path.join(ROOT, 'print-menu.html'), html);
console.log('Wrote print-menu.html (' + (html.length / 1024).toFixed(1) + ' KB)');
