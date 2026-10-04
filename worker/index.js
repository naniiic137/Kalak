// Cloudflare host: the Worker serves public/ (assets binding), hands out room codes and routes
// /ws?room=CODE to one Durable Object per room. The game itself is lib/room.js, shared with server.js.
import { DurableObject } from 'cloudflare:workers';
import roomLib from '../lib/room.js';

const { createRoom, makeConn, genCode, normalizeCode } = roomLib;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      // Pick a random code and ask that room's Durable Object to hold it; retry if it is in use.
      for (let i = 0; i < 10; i++) {
        const code = genCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const r = await stub.fetch(`https://room/reserve?room=${code}`, { method: 'POST' });
        if (r.ok) return json({ code });
      }
      return json({ error: 'busy' }, 503);
    }

    if (url.pathname === '/ws') {
      const code = normalizeCode(url.searchParams.get('room'));
      if (!code) return new Response('Bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(`https://room/ws?room=${code}`, { headers: request.headers });
    }

    return env.ASSETS.fetch(request);
  },
};

/**
 * One Durable Object per room code. It uses ws.accept() (not the hibernation API) so the
 * in-memory game, its setTimeout/setInterval phase timers and the 60 s seat hold keep running
 * while players are connected.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = normalizeCode(url.searchParams.get('room'));
    if (!code) return new Response('Bad room code', { status: 400 });
    if (!this.room) this.room = createRoom(code);
    const room = this.room;

    if (url.pathname === '/reserve') return new Response(null, { status: room.reserve() ? 204 : 409 });

    if (url.pathname !== '/ws' || request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Not found', { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const conn = makeConn(server);
    room.open(conn);
    server.addEventListener('message', e => room.message(conn, typeof e.data === 'string' ? e.data : null));
    server.addEventListener('close', () => {
      room.disconnect(conn);
      try { server.close(1000); } catch { /* already closed */ }
    });
    server.addEventListener('error', () => room.disconnect(conn));
    return new Response(null, { status: 101, webSocket: client });
  }
}
