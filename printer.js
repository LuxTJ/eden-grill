/*
 * Eden Grill — thermal receipt printing.
 *
 * Sends real ESC/POS commands to a receipt printer over either:
 *   - USB      (WebUSB)        — Chrome/Edge on desktop & Android
 *   - Bluetooth (Web Bluetooth) — Chrome/Edge on desktop & Android
 *
 * iOS Safari exposes neither API; index.html falls back to window.print()
 * (the browser print dialog) automatically when no thermal printer is connected.
 *
 * Public surface (window.EdenPrinter):
 *   isSupported()            -> { usb, bluetooth }
 *   status()                 -> { connected, kind, name }
 *   connectUSB()             -> connect a USB printer (must be a user gesture)
 *   connectBluetooth()       -> connect a BT printer (must be a user gesture)
 *   disconnect()
 *   printOrder(order)        -> print customer + kitchen copies as ESC/POS
 *   onChange(fn)             -> subscribe to connection-status changes
 */
(function () {
  'use strict';

  // ----- ESC/POS command bytes -----
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const CMD = {
    INIT:        [ESC, 0x40],
    ALIGN_LEFT:  [ESC, 0x61, 0],
    ALIGN_CENTER:[ESC, 0x61, 1],
    ALIGN_RIGHT: [ESC, 0x61, 2],
    BOLD_ON:     [ESC, 0x45, 1],
    BOLD_OFF:    [ESC, 0x45, 0],
    SIZE_NORMAL: [GS, 0x21, 0x00],
    SIZE_DOUBLE: [GS, 0x21, 0x11], // double width + height
    SIZE_TALL:   [GS, 0x21, 0x01], // double height only
    FEED_CUT:    [GS, 0x56, 0x42, 0x03], // feed 3 then partial cut (ignored by cheap printers)
  };

  // Paper columns: 58mm rolls ~32 chars, 80mm rolls ~48 chars (Font A).
  const WIDTH_KEY = 'edenGrillPaperCols';
  function cols() {
    const n = parseInt(localStorage.getItem(WIDTH_KEY) || '48', 10);
    if (n === 32) return 32;
    if (n === 64) return 64;
    return 48;
  }
  function setCols(n) { localStorage.setItem(WIDTH_KEY, String(n === 32 ? 32 : n === 64 ? 64 : 48)); }

  // ----- text -> bytes (CP437-ish; strip anything the printer can't render) -----
  function sanitize(s) {
    return String(s)
      .replace(/[—–]/g, '-')  // em/en dash
      .replace(/[‘’]/g, "'")  // curly single quotes
      .replace(/[“”]/g, '"')  // curly double quotes
      .replace(/[·•]/g, '*')  // middot / bullet
      .replace(/[^\x20-\x7E]/g, '');    // drop remaining non-printable ASCII
  }

  // Growable byte buffer, so callers can compose a receipt line by line.
  function Buffer() {
    let bytes = [];
    const api = {
      raw(arr) { for (let i = 0; i < arr.length; i++) bytes.push(arr[i] & 0xff); return api; },
      text(s) { const t = sanitize(s); for (let i = 0; i < t.length; i++) bytes.push(t.charCodeAt(i) & 0xff); return api; },
      line(s) { if (s) api.text(s); bytes.push(LF); return api; },
      feed(n) { for (let i = 0; i < (n || 1); i++) bytes.push(LF); return api; },
      // Two-column row: left-justified label, right-justified value, on one line.
      row(left, right) {
        const w = cols();
        left = sanitize(left); right = sanitize(right);
        const space = w - left.length - right.length;
        if (space >= 1) return api.line(left + ' '.repeat(space) + right);
        // Too long for one line: put the value on its own right-aligned line.
        api.line(left);
        const pad = Math.max(0, w - right.length);
        return api.line(' '.repeat(pad) + right);
      },
      rule() { return api.line('-'.repeat(cols())); },
      toBytes() { return new Uint8Array(bytes); },
    };
    return api;
  }

  function fmtMoney(n) { return '$' + Number(n).toFixed(2); }

  // Build one receipt copy as ESC/POS bytes.
  function buildCopy(order, copyLabel) {
    const b = Buffer();
    const when = new Date(order.timestamp);
    const dateStr = when.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeStr = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    b.raw(CMD.INIT);

    // Header
    b.raw(CMD.ALIGN_CENTER).raw(CMD.SIZE_DOUBLE).raw(CMD.BOLD_ON).line('EDEN GRILL').raw(CMD.SIZE_NORMAL).raw(CMD.BOLD_OFF);
    b.line('OKC');
    b.raw(CMD.BOLD_ON).line(copyLabel).raw(CMD.BOLD_OFF);
    b.raw(CMD.ALIGN_LEFT).rule();

    // Order meta — the timestamp prints clearly here (date + time).
    b.row('Order #', order.id.replace('ORD-', ''));
    b.row('Date', dateStr);
    b.row('Time', timeStr);
    b.row('Name', order.customer && order.customer.name ? order.customer.name : '-');
    b.rule();

    // Items
    order.items.forEach(function (it) {
      b.row(it.quantity + 'x ' + it.name, fmtMoney(it.total));
      if (it.options && it.options.length) {
        // Wrap options under the item, indented.
        const w = cols() - 2;
        let lineBuf = '';
        it.options.forEach(function (opt) {
          const piece = (lineBuf ? ', ' : '') + opt;
          if ((lineBuf + piece).length > w) { b.line('  ' + lineBuf); lineBuf = opt; }
          else { lineBuf += piece; }
        });
        if (lineBuf) b.line('  ' + lineBuf);
      }
      if (it.note) { b.line('  -> ' + it.note); }
    });
    b.rule();

    // Totals
    const sub = order.subtotal != null ? order.subtotal : order.total;
    b.row('Subtotal', fmtMoney(sub));
    if (order.discount) {
      b.row('Discount' + (order.promoCode ? ' (' + order.promoCode + ')' : ''), '-' + fmtMoney(order.discount));
    }
    b.raw(CMD.BOLD_ON).raw(CMD.SIZE_TALL).row('TOTAL', fmtMoney(order.total)).raw(CMD.SIZE_NORMAL).raw(CMD.BOLD_OFF);
    b.row('Paid', 'CASH');
    b.rule();

    b.raw(CMD.ALIGN_CENTER).line('Made to order - Thank you!');
    b.line(dateStr + '  ' + timeStr);
    b.raw(CMD.ALIGN_LEFT).feed(8).raw([0x0c]);
    return b.toBytes();
  }

  function buildOrderBytes(order) {
    // Customer copy + kitchen copy = 2 copies.
    const a = buildCopy(order, 'CUSTOMER COPY');
    const c = buildCopy(order, 'KITCHEN COPY');
    const out = new Uint8Array(a.length + c.length);
    out.set(a, 0); out.set(c, a.length);
    return out;
  }

  // ----- connection state -----
  let conn = null; // { kind:'usb'|'bluetooth', name, send(bytes), close() }
  const listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(status()); } catch (e) {} }); }
  function status() {
    return conn
      ? { connected: true, kind: conn.kind, name: conn.name }
      : { connected: false, kind: null, name: null };
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ----- WebUSB -----
  async function connectUSB() {
    if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser. Use Chrome or Edge on desktop/Android.');
    const device = await navigator.usb.requestDevice({ filters: [] });
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    // Find an interface with a bulk OUT endpoint (printer class 7, or any vendor iface).
    let iface = null, endpoint = null;
    for (const cfg of device.configurations) {
      for (const i of cfg.interfaces) {
        for (const alt of i.alternates) {
          const out = alt.endpoints.find(function (e) { return e.direction === 'out' && e.type === 'bulk'; });
          if (out) { iface = i; endpoint = out; break; }
        }
        if (endpoint) break;
      }
      if (endpoint) break;
    }
    if (!endpoint) { await device.close(); throw new Error('No compatible USB printer endpoint found on this device.'); }

    try { await device.claimInterface(iface.interfaceNumber); }
    catch (e) { await device.close(); throw new Error('Could not claim the USB printer. On Windows you may need to install a WinUSB driver (e.g. via Zadig).'); }

    conn = {
      kind: 'usb',
      name: (device.productName || 'USB printer'),
      async send(bytes) {
        const CHUNK = 4096;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          await device.transferOut(endpoint.endpointNumber, bytes.slice(i, i + CHUNK));
        }
      },
      async close() { try { await device.close(); } catch (e) {} },
    };
    device.addEventListener && navigator.usb.addEventListener('disconnect', function (ev) {
      if (conn && conn.kind === 'usb' && ev.device === device) { conn = null; notify(); }
    });
    notify();
    return status();
  }

  // ----- Web Bluetooth -----
  // Service UUIDs used by common generic thermal/label printers.
  const BT_SERVICES = [
    0x18f0, 0xff00, 0xffe0, 0xff12,
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC transparent UART
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
    '0000fee7-0000-1000-8000-00805f9b34fb', // Common Chinese label printers
    '0000fff0-0000-1000-8000-00805f9b34fb', // Another generic UUID
    '00001101-0000-1000-8000-00805f9b34fb', // SPP serial port profile
    '00001800', '00001801',                  // Generic Access / Attribute
  ];

  async function connectBluetooth() {
    if (!('bluetooth' in navigator)) throw new Error('Web Bluetooth is not supported in this browser. Use Chrome or Edge on desktop/Android.');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BT_SERVICES,
    });
    const server = await device.gatt.connect();

    // Find any writable characteristic across the printer's services.
    let characteristic = null;
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) { characteristic = ch; break; }
      }
      if (characteristic) break;
    }
    if (!characteristic) { try { device.gatt.disconnect(); } catch (e) {} throw new Error('No writable characteristic found on this Bluetooth printer.'); }

    const withoutResponse = characteristic.properties.writeWithoutResponse;
    conn = {
      kind: 'bluetooth',
      name: (device.name || 'Bluetooth printer'),
      async send(bytes) {
        // BLE MTU is small — send in ~180-byte chunks with a short pause.
        const CHUNK = 180;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const slice = bytes.slice(i, i + CHUNK);
          if (withoutResponse && characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(slice);
          else await characteristic.writeValue(slice);
          await delay(20);
        }
      },
      async close() { try { device.gatt.disconnect(); } catch (e) {} },
    };
    device.addEventListener('gattserverdisconnected', function () {
      if (conn && conn.kind === 'bluetooth') { conn = null; notify(); }
    });
    notify();
    return status();
  }

  async function disconnect() {
    if (conn) { await conn.close(); conn = null; notify(); }
  }

  async function printOrder(order) {
    if (!conn) throw new Error('No printer connected.');
    const customer = buildCopy(order, 'CUSTOMER COPY');
    await conn.send(customer);
    await delay(1500);
    const kitchen = buildCopy(order, 'KITCHEN COPY');
    await conn.send(kitchen);
  }

  window.EdenPrinter = {
    isSupported: function () { return { usb: 'usb' in navigator, bluetooth: 'bluetooth' in navigator }; },
    status: status,
    connectUSB: connectUSB,
    connectBluetooth: connectBluetooth,
    disconnect: disconnect,
    printOrder: printOrder,
    onChange: function (fn) { listeners.push(fn); },
    getCols: cols,
    setCols: function (n) { setCols(n); notify(); },
    // Exposed for testing the byte builder.
    _buildOrderBytes: buildOrderBytes,
  };
})();
