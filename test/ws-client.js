'use strict';
// Minimal WebSocket client for the tests, with the small socket.io-like API they use:
// emit(event, data, ack), on/off, an `events` log, raw(text) and disconnect().
const WebSocket = require('ws');

function connect(url) {
  const ws = new WebSocket(url);
  const handlers = new Map();
  const acks = new Map();
  let nextId = 1;
  const c = {
    ws, events: [], closeCode: null,
    on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return c; },
    off(ev, fn) { handlers.get(ev)?.delete(fn); return c; },
    emit(ev, data, ack) {
      if (typeof data === 'function') { ack = data; data = undefined; }
      const msg = { t: ev };
      if (data !== undefined && typeof data !== 'function') msg.d = data;
      if (typeof ack === 'function') { msg.id = nextId++; acks.set(msg.id, ack); }
      c.raw(JSON.stringify(msg));
      return c;
    },
    raw(text) { if (ws.readyState === WebSocket.OPEN) ws.send(text); },
    disconnect() { ws.close(); },
  };
  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(buf.toString());
    if ('ack' in m) { const cb = acks.get(m.ack); acks.delete(m.ack); if (cb) cb(m.d); return; }
    c.events.push({ ev: m.t, data: m.d });
    for (const fn of [...(handlers.get(m.t) || [])]) fn(m.d);
  });
  ws.on('close', code => { c.closeCode = code; for (const fn of [...(handlers.get('close') || [])]) fn(code); });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(c));
    ws.on('error', reject); // no-op once open; keeps later errors from being unhandled
  });
}

module.exports = { connect };
