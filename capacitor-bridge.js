/**
 * Capacitor Bridge — Native Bluetooth Printer Adapter
 *
 * Detects if running inside Capacitor native app vs browser.
 * In native mode: communicates with EdenPrinterPlugin (Android SPP / iOS BLE).
 * In browser mode: everything is handled by the existing Web Bluetooth/USB code in printer.js.
 *
 * Exposes window.EdenBridge with the same connect/disconnect/send pattern as the printer module.
 */
(function () {
  'use strict';

  var Cap = null;
  var plugin = null;

  // ----- detect Capacitor native runtime -----
  try {
    if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform) {
      Cap = Capacitor;
      // Dynamically register our plugin if it exists in the native scope
      var Plugins = Cap.Plugins || (Cap.Plugins = {});
      if (Plugins.EdenPrinterPlugin) {
        plugin = Plugins.EdenPrinterPlugin;
      }
    }
  } catch (e) { /* not in Capacitor */ }

  var isNative = !!plugin;

  var nativeConn = null;  // { kind, name }

  var listeners = [];

  function notify() {
    var st = status();
    listeners.forEach(function (fn) {
      try { fn(st); } catch (e) {}
    });
  }

  function status() {
    if (!isNative) return { connected: false, kind: null, name: null, native: false };
    return {
      connected: !!nativeConn,
      kind: nativeConn ? nativeConn.kind : null,
      name: nativeConn ? nativeConn.name : null,
      native: true
    };
  }

  function isSupported() {
    return { usb: false, bluetooth: isNative || 'bluetooth' in navigator };
  }

  /** Scan for nearby Bluetooth printers (Android native only) */
  async function scanPrinters() {
    if (!isNative) return [];
    try {
      var result = await plugin.scan({ timeout: 10 });
      return (result.devices || []).map(function (d) {
        return { address: d.address, name: d.name || 'Unknown' };
      });
    } catch (e) {
      return [];
    }
  }

  /** Connect to a printer by address (Android native) or open system picker (browser) */
  async function connectBluetooth(addressOrKind) {
    if (isNative && nativeConn) {
      await disconnect();
    }

    if (isNative) {
      try {
        var result = await plugin.connect({ address: addressOrKind || '' });
        nativeConn = {
          kind: 'bluetooth',
          name: result.name || 'Thermal Printer'
        };
        notify();
        return nativeConn;
      } catch (e) {
        nativeConn = null;
        notify();
        throw new Error(e.message || 'Could not connect to printer.');
      }
    }

    // Browser mode — handled by printer.js, just signal availability
    throw new Error('Use browser Web Bluetooth (handled by printer.js)');
  }

  /** Disconnect */
  async function disconnect() {
    if (isNative && plugin) {
      try { await plugin.disconnect(); } catch (e) {}
    }
    nativeConn = null;
    notify();
  }

  /** Send raw ESC/POS bytes */
  async function send(data) {
    if (!isNative || !nativeConn) throw new Error('Not connected');
    // Convert Uint8Array to base64 for plugin transport
    var binary = '';
    for (var i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    var base64 = btoa(binary);
    await plugin.write({ data: base64 });
  }

  window.EdenBridge = {
    get isNative() { return isNative; },
    get plugin() { return plugin; },
    isSupported: isSupported,
    status: status,
    scanPrinters: scanPrinters,
    connectBluetooth: connectBluetooth,
    connectUSB: function () { throw new Error('USB not available on mobile. Use Bluetooth.'); },
    disconnect: disconnect,
    send: send,
    onChange: function (fn) { listeners.push(fn); }
  };

})();
