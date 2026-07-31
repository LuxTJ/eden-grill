(function () {
  'use strict';

  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const CMD = {
    INIT:        [ESC, 0x40],
    ALIGN_LEFT:  [ESC, 0x61, 0],
    ALIGN_CENTER:[ESC, 0x61, 1],
    ALIGN_RIGHT: [ESC, 0x61, 2],
    BOLD_ON:     [ESC, 0x45, 1],
    BOLD_OFF:    [ESC, 0x45, 0],
    SIZE_NORMAL: [GS, 0x21, 0x00],
    SIZE_DOUBLE: [GS, 0x21, 0x11],
    SIZE_TALL:   [GS, 0x21, 0x01],
    CUT:         [ESC, 0x64, 0x02],
  };

  const WIDTH_KEY = 'edenGrillPaperCols';
  function cols() {
    const n = parseInt(localStorage.getItem(WIDTH_KEY) || '48', 10);
    if (n === 32) return 32;
    if (n === 64) return 64;
    return 48;
  }
  function setCols(n) { localStorage.setItem(WIDTH_KEY, String(n === 32 ? 32 : n === 64 ? 64 : 48)); }

  /* How big the food item names print on the kitchen ticket. GS ! n packs a
     width multiplier in the high nibble and height in the low nibble, so
     0x11 = 2x/2x and 0x22 = 3x/3x. Adjustable from Printer settings because
     what's readable depends on the printer and how far away the cook stands. */
  const TEXT_SIZE_KEY = 'edenGrillItemTextSize';
  const ITEM_SIZES = {
    normal: { cmd: [GS, 0x21, 0x01], scale: 1 },   /* tall only, full width  */
    large:  { cmd: [GS, 0x21, 0x11], scale: 2 },   /* 2x wide, 2x tall       */
    xl:     { cmd: [GS, 0x21, 0x22], scale: 3 },   /* 3x wide, 3x tall       */
  };
  function textSize() {
    const v = localStorage.getItem(TEXT_SIZE_KEY);
    return ITEM_SIZES[v] ? v : 'large';
  }
  function setTextSize(v) { localStorage.setItem(TEXT_SIZE_KEY, ITEM_SIZES[v] ? v : 'large'); }
  function itemSize() { return ITEM_SIZES[textSize()]; }

  function sanitize(s) {
    return String(s)
      .replace(/[—–]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[·•]/g, '*')
      .replace(/[^\x20-\x7E]/g, '');
  }

  function Buffer() {
    let bytes = [];
    return {
      raw(arr) { for (let i = 0; i < arr.length; i++) bytes.push(arr[i] & 0xff); return this; },
      text(s) { const t = sanitize(s); for (let i = 0; i < t.length; i++) bytes.push(t.charCodeAt(i) & 0xff); return this; },
      line(s) { if (s) this.text(s); bytes.push(LF); return this; },
      feed(n) { for (let i = 0; i < (n || 1); i++) bytes.push(LF); return this; },
      row(left, right) {
        const w = cols();
        left = sanitize(left); right = sanitize(right);
        const space = w - left.length - right.length;
        if (space >= 1) return this.line(left + ' '.repeat(space) + right);
        this.line(left);
        return this.line(' '.repeat(Math.max(0, w - right.length)) + right);
      },
      rule() { return this.line('-'.repeat(cols())); },
      toBytes() { return new Uint8Array(bytes); },
    };
  }

  function fmtMoney(n) { return '$' + Number(n).toFixed(2); }

  /* Double/triple-width characters fit proportionally fewer per line, so long
     item names have to be broken by hand — left to the printer they wrap
     mid-word, which is exactly what the kitchen struggles to read. */
  function wrapText(s, width) {
    const words = sanitize(s).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    words.forEach(function (w) {
      while (w.length > width) {           /* a single word longer than the line */
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  const SIDE_RE = /side/i, DRINK_RE = /drink/i, TOPPING_RE = /topping/i;

  /* Combos come with a side and a drink, and the kitchen wants those called
     out by name and read in a fixed order — toppings, then side, then drink.
     Plain items keep the bare "what was picked" list with no labels at all. */
  function buildEntries(pairs, isCombo) {
    if (!isCombo) return [{ label: null, values: pairs.map(function (p) { return p.value; }) }];
    var toppings = [], other = [], side = [], drink = [];
    pairs.forEach(function (p) {
      if (SIDE_RE.test(p.label)) side.push(p.value);
      else if (DRINK_RE.test(p.label)) drink.push(p.value);
      else if (TOPPING_RE.test(p.label)) toppings.push(p.value);
      else other.push(p.value);
    });
    var entries = [];
    if (toppings.length) entries.push({ label: 'Toppings', values: toppings });
    if (other.length) entries.push({ label: null, values: other });
    if (side.length) entries.push({ label: 'Side', values: side });
    if (drink.length) entries.push({ label: 'Drink', values: drink });
    return entries;
  }

  // Group item options: "For Two" combos split into Item 1 / Item 2 sections.
  function formatItemOptions(options) {
    if (!options || options.length === 0) return [];
    var pairs = options.map(function (opt) {
      var ci = opt.indexOf(': ');
      return ci === -1 ? { label: '', value: opt }
                       : { label: opt.substring(0, ci).trim(), value: opt.substring(ci + 2).trim() };
    });
    /* Only items that actually come with a side or a drink get the labelled,
       reordered treatment — i.e. the combos. */
    var isCombo = pairs.some(function (p) { return SIDE_RE.test(p.label) || DRINK_RE.test(p.label); });

    var hasNumberedOptions = pairs.some(function (p) { return /\s\d+$/.test(p.label); });
    if (hasNumberedOptions) {
      var numberedBaseLabels = {};
      pairs.forEach(function (p) {
        var m = p.label.match(/^(.+)\s(\d+)$/);
        if (m) numberedBaseLabels[m[1]] = true;
      });
      var shared = [], g1 = [], g2 = [];
      pairs.forEach(function (p) {
        var m = p.label.match(/^(.+)\s(\d+)$/);
        var entry = { label: m ? m[1] : p.label, value: p.value };
        if (m && (m[2] === '1' || m[2] === '2')) (m[2] === '1' ? g1 : g2).push(entry);
        else if (numberedBaseLabels[p.label]) g1.push(entry);
        else shared.push(entry);
      });
      return [
        { section: 'Item 1', entries: buildEntries(shared.concat(g1), isCombo) },
        { section: 'Item 2', entries: buildEntries(shared.concat(g2), isCombo) }
      ];
    }
    return [{ section: null, entries: buildEntries(pairs, isCombo) }];
  }

  // Write formatted options to a Buffer for thermal printer (ESC/POS): one
  // short "- value" line per selection, no label.
  function writeOptionsToBuffer(b, options, indent) {
    indent = indent || '  ';
    var sections = formatItemOptions(options);
    sections.forEach(function(sec, si) {
      /* Blank line between the two people's halves of a "For Two" combo, so
         they don't read as one continuous list. */
      /* Bold state is left to the caller: the kitchen ticket runs bold from
         top to bottom, the store receipt stays regular. */
      if (sec.section) {
        if (si > 0) b.line('');
        b.line(indent + '[ ' + sec.section + ' ]');
      }
      sec.entries.forEach(function(e) {
        if (!e.label) { e.values.forEach(function(v) { b.line(indent + '- ' + v); }); return; }
        /* One pick sits on the label's own line ("Side: Crinkle Fries");
           several get the label as a heading so the line stays short. */
        if (e.values.length === 1) { b.line(indent + '- ' + e.label + ': ' + e.values[0]); return; }
        b.line(indent + '- ' + e.label + ':');
        e.values.forEach(function(v) { b.line(indent + '    ' + v); });
      });
    });
  }

  // Format options as HTML for browser print receipts — same as the thermal
  // path above, just label-free bullet lines.
  function formatItemOptionsHtml(options) {
    var s = formatItemOptions(options);
    return s.map(function(sec, si) {
      /* Extra gap above the second half of a "For Two" combo — same separation
         the thermal ticket gets from its blank line. */
      var h = sec.section
        ? '<div class="r-item-section"' + (si > 0 ? ' style="margin-top:14px"' : '') + '>[ ' + sec.section + ' ]</div>'
        : '';
      h += sec.entries.map(function(e) {
        if (!e.label) return e.values.map(function(v) { return '<div class="r-item-line">- ' + v + '</div>'; }).join('');
        if (e.values.length === 1) return '<div class="r-item-line">- ' + e.label + ': ' + e.values[0] + '</div>';
        return '<div class="r-item-line">- ' + e.label + ':</div>' +
          e.values.map(function(v) { return '<div class="r-item-line" style="padding-left:24px">' + v + '</div>'; }).join('');
      }).join('');
      return h;
    }).join('');
  }

  // ----- Customer Receipt (detailed with pricing) -----
  function buildCustomerReceipt(order) {
    const b = Buffer();
    const when = new Date(order.timestamp);
    const dateStr = when.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeStr = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    b.raw(CMD.INIT);
    b.raw(CMD.ALIGN_CENTER).raw(CMD.SIZE_DOUBLE).raw(CMD.BOLD_ON).line('EDEN GRILL').raw(CMD.BOLD_OFF);
    /* SIZE_TALL doubles character height only, not width, so it reads much
       bigger without changing how many characters fit per line — row()'s
       column-padding math (based on character count) still lines up. */
    b.raw(CMD.SIZE_TALL).line('OKC');
    b.raw(CMD.BOLD_ON).line('STORE RECEIPT').raw(CMD.BOLD_OFF);
    b.raw(CMD.ALIGN_LEFT).rule();
    b.row('Order #', order.id.replace('ORD-', ''));
    b.row('Date', dateStr);
    b.row('Time', timeStr);
    b.row('Name', order.customer && order.customer.name ? order.customer.name : '-');
    b.rule();

    /* Store copy prints regular weight — it's a customer-facing receipt, not
       something read across the kitchen. */
    order.items.forEach(function (it, idx) {
      if (idx > 0) b.line('');            /* separate one food item from the next */
      b.row(it.quantity + 'x ' + it.name, fmtMoney(it.total));
      if (it.options && it.options.length) writeOptionsToBuffer(b, it.options);
      if (it.note) { b.line('  -> ' + it.note); }
    });
    b.rule();

    const sub = order.subtotal != null ? order.subtotal : order.total;
    b.row('Subtotal', fmtMoney(sub));
    if (order.discount) {
      b.row('Discount' + (order.promoCode ? ' (' + order.promoCode + ')' : ''), '-' + fmtMoney(order.discount));
    }
    b.raw(CMD.BOLD_ON).row('TOTAL', fmtMoney(order.total)).raw(CMD.BOLD_OFF);
    b.row('Paid', 'CASH');
    b.rule();
    b.raw(CMD.ALIGN_CENTER).line('Made to order - Thank you!');
    b.line(dateStr + '  ' + timeStr);
    b.raw(CMD.ALIGN_LEFT).feed(4).raw(CMD.CUT);
    return b.toBytes();
  }

  // ----- Kitchen Ticket (simplified, no pricing) -----
  function buildKitchenTicket(order) {
    const b = Buffer();
    const when = new Date(order.timestamp);
    const timeStr = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    /* Bold goes on once here and stays on for the whole ticket — the cook
       reads this from across the line. Only the character size changes below. */
    b.raw(CMD.INIT).raw(CMD.BOLD_ON);
    b.raw(CMD.ALIGN_CENTER).raw(CMD.SIZE_DOUBLE).line('KITCHEN TICKET');
    b.raw(CMD.SIZE_TALL).raw(CMD.ALIGN_LEFT).rule();
    b.row('Order #', order.id.replace('ORD-', ''));
    b.row('Time', timeStr);
    b.row('Name', order.customer && order.customer.name ? order.customer.name : '-');
    b.rule();

    /* Food names print at the configured size (default 2x wide/tall); the
       options underneath stay at normal width so a long list of toppings
       doesn't run to five lines each. */
    const size = itemSize();
    order.items.forEach(function (it) {
      b.raw(size.cmd);
      wrapText(it.quantity + 'x ' + it.name, Math.floor(cols() / size.scale)).forEach(function (l) { b.line(l); });
      b.raw(CMD.SIZE_TALL);
      if (it.options && it.options.length) writeOptionsToBuffer(b, it.options);
      if (it.note) { b.line('  -> ' + it.note); }
      b.line('');
    });
    b.rule();
    b.raw(CMD.ALIGN_CENTER).line('Fire when ready!');
    b.raw(CMD.BOLD_OFF).raw(CMD.ALIGN_LEFT).feed(4).raw(CMD.CUT);
    return b.toBytes();
  }

  // ----- native/capacitor bridge detection -----
  var bridge = window.EdenBridge;
  var isNative = bridge && bridge.isNative;

  // ----- connection state (single printer, two jobs) -----
  let conn = null;
  const listeners = [];

  function status() {
    if (!conn && isNative) return bridge.status();
    return { connected: !!conn, kind: conn ? conn.kind : null, name: conn ? conn.name : null };
  }
  function notify() { listeners.forEach(function (fn) { try { fn(status()); } catch (e) {} }); }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ----- connection helpers (reused for both targets) -----
  function isSup() {
    if (isNative) return { usb: false, bluetooth: true };
    return { usb: 'usb' in navigator, bluetooth: 'bluetooth' in navigator };
  }

  async function openUSBDevice(device) {
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    let endpoint = null;
    for (const cfg of device.configurations) {
      for (const i of cfg.interfaces) {
        for (const alt of i.alternates) {
          const out = alt.endpoints.find(function (e) { return e.direction === 'out' && e.type === 'bulk'; });
          if (out) endpoint = out;
          if (endpoint) break;
        }
        if (endpoint) break;
      }
      if (endpoint) break;
    }
    if (!endpoint) { await device.close(); throw new Error('No compatible USB endpoint.'); }
    try { await device.claimInterface(0); } catch (e) { await device.close(); throw new Error('Could not claim interface. Try Zadig for WinUSB driver.'); }
    return {
      kind: 'usb',
      name: device.productName || 'USB printer',
      send: async function (bytes) {
        for (let i = 0; i < bytes.length; i += 4096) { await device.transferOut(endpoint.endpointNumber, bytes.slice(i, i + 4096)); }
      },
      close: async function () { try { await device.close(); } catch (e) {} },
    };
  }

  async function connectUSB() {
    if (!('usb' in navigator)) throw new Error('WebUSB not supported.');
    const device = await navigator.usb.requestDevice({ filters: [] });
    return openUSBDevice(device);
  }

  // Reconnect to a previously-authorized USB device without a picker/user gesture.
  // Returns null if none is available (caller should fall back to connectUSB()).
  async function reconnectUSB() {
    if (!('usb' in navigator)) throw new Error('WebUSB not supported.');
    const devices = await navigator.usb.getDevices();
    if (!devices.length) return null;
    return openUSBDevice(devices[0]);
  }

  const BT_SERVICES = [
    0x18f0, 0xff00, 0xffe0, 0xff12,
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    '0000fee7-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '00001101-0000-1000-8000-00805f9b34fb',
    '00001800-0000-1000-8000-00805f9b34fb',
    '00001801-0000-1000-8000-00805f9b34fb',
  ];

  async function connectBluetooth(address) {
    // Native mode: use Capacitor bridge
    if (isNative) {
      await bridge.connectBluetooth(address || '');
      return {
        kind: 'bluetooth',
        name: bridge.status().name || 'Thermal Printer',
        send: async function (bytes) { await bridge.send(bytes); },
        close: async function () { await bridge.disconnect(); },
      };
    }
    // Browser mode: use Web Bluetooth API
    if (!('bluetooth' in navigator)) throw new Error('Web Bluetooth not supported.');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BT_SERVICES });
    const server = await device.gatt.connect();
    let characteristic = null;
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) { characteristic = ch; break; }
      }
      if (characteristic) break;
    }
    if (!characteristic) { try { device.gatt.disconnect(); } catch (e) {} throw new Error('No writable characteristic found.'); }
    const withoutResponse = characteristic.properties.writeWithoutResponse;
    return {
      kind: 'bluetooth',
      name: device.name || 'Bluetooth printer',
      send: async function (bytes) {
        for (let i = 0; i < bytes.length; i += 180) {
          const slice = bytes.slice(i, i + 180);
          if (withoutResponse && characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(slice);
          else await characteristic.writeValue(slice);
          await delay(20);
        }
      },
      close: async function () { try { device.gatt.disconnect(); } catch (e) {} },
    };
  }

  // ----- connect / disconnect (single printer) -----
  async function connectPrinter(kind) {
    const p = kind === 'usb' ? await connectUSB() : await connectBluetooth();
    if (conn) { try { conn.close(); } catch (e) {} }
    conn = p;
    notify();
    return p;
  }

  function disconnectPrinter() {
    if (conn) { conn.close(); conn = null; }
    notify();
  }

  // Silent reconnect to a previously-authorized USB device, no picker/gesture required.
  // Returns true if reconnected, false if no previously-authorized device was found.
  async function tryReconnectUSB() {
    const p = await reconnectUSB();
    if (!p) return false;
    if (conn) { try { conn.close(); } catch (e) {} }
    conn = p;
    notify();
    return true;
  }

  // ----- print order: both receipts as a single job -----
  async function printOrder(order) {
    if (!conn) return;
    const custData = buildCustomerReceipt(order);
    const kitchData = buildKitchenTicket(order);
    const combined = new Uint8Array(custData.length + kitchData.length);
    combined.set(custData, 0);
    combined.set(kitchData, custData.length);
    await conn.send(combined);
  }

  async function printCustomerReceipt(bytes) {
    if (!conn) return;
    await conn.send(bytes);
  }

  async function printKitchenTicket(bytes) {
    if (!conn) return;
    await conn.send(bytes);
  }

  // ----- browser print fallback templates -----
  function customerReceiptHtml(order) {
    var when = new Date(order.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    var items = order.items.map(function (i) {
      return '<div class="r-item">' +
        '<div class="r-row r-item-name"><span>' + i.quantity + 'x ' + i.name + '</span><span>$' + Number(i.total).toFixed(2) + '</span></div>' +
        (i.options && i.options.length ? '<div class="r-opts">' + formatItemOptionsHtml(i.options) + '</div>' : '') +
        (i.note ? '<div class="r-note">' + i.note + '</div>' : '') +
      '</div>';
    }).join('');
    var sub = order.subtotal != null ? order.subtotal : order.total;
    return '<div class="receipt size-' + textSize() + '">' +
      '<div class="r-center r-title">EDEN GRILL</div><div class="r-center">OKC</div><div class="r-center r-copy">STORE RECEIPT</div><hr>' +
      '<div class="r-row"><span>Order #</span><span>' + order.id.replace('ORD-', '') + '</span></div>' +
      '<div class="r-row"><span>Date</span><span>' + when + '</span></div>' +
      '<div class="r-row"><span>Name</span><span>' + order.customer.name + '</span></div><hr>' +
      items + '<hr>' +
      '<div class="r-row"><span>Subtotal</span><span>$' + Number(sub).toFixed(2) + '</span></div>' +
      (order.discount ? '<div class="r-row"><span>Discount</span><span>-$' + Number(order.discount).toFixed(2) + '</span></div>' : '') +
      '<div class="r-row r-total"><span>TOTAL</span><span>$' + Number(order.total).toFixed(2) + '</span></div>' +
      '<div class="r-row"><span>Paid</span><span>CASH</span></div><hr>' +
      '<div class="r-foot">Made to order - Thank you!</div></div>';
  }

  function kitchenTicketHtml(order) {
    var when = new Date(order.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var items = order.items.map(function (i) {
      return '<div class="r-item">' +
        '<div class="r-row r-item-name"><span>' + i.quantity + 'x ' + i.name + '</span></div>' +
        (i.options && i.options.length ? '<div class="r-opts">' + formatItemOptionsHtml(i.options) + '</div>' : '') +
        (i.note ? '<div class="r-note">' + i.note + '</div>' : '') +
      '</div>';
    }).join('');
    /* Size class mirrors the thermal printer's food-size setting so the two
       print paths (system/AirPrint dialog vs direct ESC/POS) look the same. */
    return '<div class="receipt kitchen-ticket size-' + textSize() + '">' +
      '<div class="r-center r-title">KITCHEN TICKET</div><hr>' +
      '<div class="r-row"><span>Order #</span><span>' + order.id.replace('ORD-', '') + '</span></div>' +
      '<div class="r-row"><span>Time</span><span>' + when + '</span></div>' +
      '<div class="r-row"><span>Name</span><span>' + order.customer.name + '</span></div><hr>' +
      items + '<hr>' +
      '<div class="r-foot">Fire when ready!</div></div>';
  }

  // In native mode, scan for BT printers and connect to first found
  async function connectBluetoothNative() {
    if (!isNative) throw new Error('Not in native mode.');
    var devices = await bridge.scanPrinters();
    if (!devices || devices.length === 0) throw new Error('No Bluetooth printers found nearby. Make sure the printer is on and in pairing mode.');
    // Connect to first printer
    return connectBluetooth(devices[0].address);
  }

  window.EdenPrinter = {
    isSupported: isSup,
    status: status,
    connectUSB: function () { return connectPrinter('usb'); },
    reconnectUSB: tryReconnectUSB,
    connectBluetooth: function () { return isNative ? connectBluetoothNative() : connectPrinter('bluetooth'); },
    disconnect: disconnectPrinter,
    printOrder: printOrder,
    customerReceiptHtml: customerReceiptHtml,
    kitchenTicketHtml: kitchenTicketHtml,
    onChange: function (fn) { listeners.push(fn); },
    getCols: cols,
    setCols: function (n) { setCols(n); notify(); },
    getTextSize: textSize,
    setTextSize: function (v) { setTextSize(v); notify(); },
    /* Exposed so the exact ESC/POS byte stream can be inspected without a
       physical printer attached. */
    buildCustomerReceipt: buildCustomerReceipt,
    buildKitchenTicket: buildKitchenTicket,
    getBridge: function () { return bridge; },
    isNativePlatform: function () { return isNative; },
  };
})();
