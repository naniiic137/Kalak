'use strict';
// Node host: Express serves public/, the `ws` package carries the game. Each room code gets one
// lib/room.js instance; the same module runs inside the Cloudflare Durable Object (worker/index.js).
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createRoom, makeConn, genCode, normalizeCode, MAX_MESSAGE_BYTES } = require('./lib/room');

const MAX_ROOMS = 10_000;

/**
 * Builds the HTTP + WebSocket server. Options are passed to every room (see lib/room.js):
 * graceMs, advanceDelayMs, disconnectSettleMs, log.
 */
function createGameServer(opts = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  app.use(express.static(path.join(__dirname, 'public')));

  const rooms = new Map();

  function roomFor(code) {
    let room = rooms.get(code);
    if (!room) {
      room = createRoom(code, {
        ...opts,
        // Forget a room once nobody is in it, connected to it, or about to create it.
        onIdle: () => { if (rooms.get(code) === room && room.idle()) { rooms.delete(code); room.dispose(); } },
      });
      rooms.set(code, room);
    }
    return room;
  }

  // Hands out an unused code; the creator then connects to /ws?room=CODE and sends room:create.
  app.post('/api/rooms', (req, res) => {
    if (rooms.size < MAX_ROOMS) {
      for (let i = 0; i < 20; i++) {
        const code = genCode();
        if (roomFor(code).reserve()) return res.json({ code });
      }
    }
    res.status(503).json({ error: 'busy' });
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { url = null; }
    const code = url && url.pathname === '/ws' ? normalizeCode(url.searchParams.get('room')) : null;
    if (!code) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const room = roomFor(code);
      const conn = makeConn(ws);
      room.open(conn);
      ws.on('message', (raw, isBinary) => room.message(conn, isBinary ? null : raw.toString()));
      ws.on('close', () => room.disconnect(conn));
      ws.on('error', () => { /* 'close' follows */ });
    });
  });

  function close() {
    for (const room of rooms.values()) room.dispose();
    rooms.clear();
    for (const ws of wss.clients) ws.terminate();
    return new Promise(resolve => { wss.close(() => server.close(() => resolve())); });
  }

  return { app, server, wss, rooms, close };
}

module.exports = { createGameServer };

if (require.main === module) {
  const { server } = createGameServer();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
