'use strict';
// One game room, independent of the transport. The Node server (server.js) and the Cloudflare
// Durable Object (worker/index.js) both hand it connections and raw messages; all game logic
// lives here so the two hosts behave the same.
//
// A connection ("conn") is any object made by makeConn():
//   send(event, data)    push an event to that client
//   reply(id, data)      answer an ack
//   close(code, reason)  end the connection
//   playerId             set by the room while the conn holds a seat
const L = require('./logic');

const PICK_TIME = 15;
const DEFAULT_GRACE_MS = 60_000;
const RESERVE_MS = 60_000; // a code handed out by POST /api/rooms stays free for its creator this long
const IDLE_CUTOFF_MS = 80_000; // clients ping every 25 s; drop a connection that went silent
const MAX_MESSAGE_BYTES = 4096;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;
const CODE_RE = new RegExp(`^[${CODE_CHARS}]{${CODE_LEN}}$`);
// Close codes 4000-4099 mean "ended on purpose": the client must not reconnect.
const CLOSE_REPLACED = 4001;
const CLOSE_KICKED = 4002;

// Web Crypto exists both in Node 18+ and in Workers, so no Node-only import is needed.
function randomInt(n) {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] % n;
}
const newId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');

function genCode() {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return code;
}

/** Returns the canonical room code, or null if `raw` is not a valid code. */
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

const validToken = t => typeof t === 'string' && TOKEN_RE.test(t);

/** Wraps a server-side WebSocket (the `ws` package or a Workers WebSocket) for the room. */
function makeConn(ws) {
  const out = msg => {
    if (ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(msg)); } catch { /* socket is closing */ }
  };
  return {
    playerId: null, seen: Date.now(),
    send: (t, d) => out(d === undefined ? { t } : { t, d }),
    reply: (id, d) => out({ ack: id, d }),
    close: (code = 1000, reason = '') => { try { ws.close(code, reason); } catch { /* already closed */ } },
  };
}

/**
 * Creates the room with this code. Options (mostly for tests):
 *   graceMs          how long a disconnected player keeps their seat (default 60 s)
 *   advanceDelayMs   pause before moving on once everyone has answered/voted (default 500 ms)
 *   disconnectSettleMs  after a disconnect, wait this long (a page reload usually comes back
 *                    within it) before re-checking whether the round can move on (default 3 s)
 *   log              logger for handler errors (default console.error)
 *   onIdle           called when the room may have become idle (no game, no connections, no reservation)
 */
function createRoom(code, opts = {}) {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const advanceDelayMs = opts.advanceDelayMs ?? 500;
  const settleMs = opts.disconnectSettleMs ?? 3000;
  const log = opts.log || ((...a) => console.error('[kalak]', ...a));
  const onIdle = opts.onIdle || (() => {});

  const conns = new Set();
  let current = null; // the game while the room is live (at least one seat)
  let reserveTimer = null;
  let sweepTimer = null;
  let disposed = false;

  // Every async callback goes through this so one bad event can't take the process down.
  const safe = (label, fn) => (...args) => {
    if (disposed) return undefined;
    try { return fn(...args); } catch (e) { log(`${label} failed:`, e); return undefined; }
  };

  function newGame(lang) {
    const settings = L.sanitizeSettings(L.DEFAULT_SETTINGS, { lang });
    return {
      code, hostId: null, players: new Map(), state: 'lobby', settings,
      round: 0, pickerIndex: 0, pickerId: null, pickCats: [], question: null,
      answers: new Map(), votes: new Map(), options: null, names: new Map(),
      usedQuestions: new Set(), timer: null, advanceTimer: null, timeLeft: 0, timeMax: 0,
      kicked: new Set(), chat: [], lastResults: null, lastEnd: null,
    };
  }

  const connected = room => [...room.players.values()].filter(p => p.connected);

  function emitAll(room, ev, data) { for (const p of room.players.values()) emitTo(p, ev, data); }
  function emitTo(player, ev, data) { if (player.connected && player.conn) player.conn.send(ev, data); }
  function sys(room, key, name) {
    const m = { t: 'sys', key, name };
    room.chat.push(m); if (room.chat.length > 100) room.chat.shift();
    emitAll(room, 'chat:msg', m);
  }

  function roomState(room) {
    const players = [...room.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score, connected: p.connected,
    }));
    return {
      code: room.code, hostId: room.hostId, state: room.state, settings: room.settings,
      players: L.rankPlayers(players), round: room.round, totalRounds: room.settings.rounds,
      pickerId: room.state === 'picking' ? room.pickerId : null,
    };
  }
  const broadcast = room => emitAll(room, 'room:state', roomState(room));

  // ---------- timers ----------
  function clearTimers(room) {
    clearInterval(room.timer); room.timer = null;
    clearTimeout(room.advanceTimer); room.advanceTimer = null;
  }

  function setTimer(room, seconds, onEnd) {
    clearTimers(room);
    room.timeLeft = seconds; room.timeMax = seconds;
    emitAll(room, 'timer:update', { left: seconds, max: seconds });
    room.timer = setInterval(safe('timer', () => {
      room.timeLeft--;
      emitAll(room, 'timer:update', { left: room.timeLeft, max: room.timeMax });
      if (room.timeLeft <= 0) { clearTimers(room); onEnd(); }
    }), 1000);
  }

  // Move on shortly once everyone connected has acted (lets the last client see its tick).
  function advanceSoon(room, fromState, fn) {
    if (room.advanceTimer) return;
    clearInterval(room.timer); room.timer = null;
    room.advanceTimer = setTimeout(safe('advance', () => {
      room.advanceTimer = null;
      if (room.state === fromState) fn();
    }), advanceDelayMs);
  }

  // ---------- phase payloads (also re-sent to players who reconnect) ----------
  const questionText = room => (room.settings.lang === 'ar' ? room.question.q : room.question.qE);
  const realText = room => (room.settings.lang === 'ar' ? room.question.a : room.question.aE);

  function pickPayload(room) {
    const picker = room.players.get(room.pickerId);
    return {
      pickerId: room.pickerId, pickerName: picker?.name ?? null, pickerAvatar: picker?.avatar ?? null,
      categories: room.pickCats, round: room.round, totalRounds: room.settings.rounds,
    };
  }

  function questionPayload(room, pid) {
    return {
      question: questionText(room), category: room.question.category,
      round: room.round, totalRounds: room.settings.rounds,
      answered: room.answers.has(pid), myAnswer: room.answers.get(pid) ?? null,
    };
  }

  function votePayload(room, pid) {
    return {
      question: questionText(room), round: room.round, totalRounds: room.settings.rounds,
      options: room.options.map((o, i) => ({ id: i, text: o.text, own: o.authors.includes(pid) })),
      voted: room.votes.has(pid) ? room.votes.get(pid) : null,
    };
  }

  function progressCounts(room, map) {
    const conn = connected(room);
    return { count: conn.filter(p => map.has(p.id)).length, total: conn.length };
  }

  function sendPhase(room, player) {
    if (room.state === 'picking') emitTo(player, 'game:pick', pickPayload(room));
    else if (room.state === 'question') {
      emitTo(player, 'game:question', questionPayload(room, player.id));
      emitTo(player, 'game:answered', progressCounts(room, room.answers));
    } else if (room.state === 'voting') {
      emitTo(player, 'game:vote', votePayload(room, player.id));
      emitTo(player, 'game:voted', progressCounts(room, room.votes));
    } else if (room.state === 'results' && room.lastResults) emitTo(player, 'game:results', room.lastResults);
    else if (room.state === 'finished' && room.lastEnd) emitTo(player, 'game:end', room.lastEnd);
    if (['picking', 'question', 'voting'].includes(room.state) && room.timer) {
      emitTo(player, 'timer:update', { left: room.timeLeft, max: room.timeMax });
    }
  }

  // ---------- game flow ----------
  function startRound(room) {
    clearTimers(room);
    const cats = L.availableCategories(room.usedQuestions, room.settings.categories);
    if (room.round >= room.settings.rounds || cats.length === 0) return endGame(room, cats.length ? 'rounds' : 'no_questions');
    room.round++;
    room.answers.clear(); room.votes.clear(); room.options = null; room.question = null; room.lastResults = null;
    room.state = 'picking';
    room.pickCats = cats;
    const conn = connected(room);
    const picker = conn.length ? conn[room.pickerIndex % conn.length] : null;
    room.pickerIndex++;
    room.pickerId = picker ? picker.id : null;
    broadcast(room);
    emitAll(room, 'game:pick', pickPayload(room));
    if (!picker) return startQuestion(room, cats[Math.floor(Math.random() * cats.length)]);
    setTimer(room, PICK_TIME, () => startQuestion(room, cats[Math.floor(Math.random() * cats.length)]));
  }

  function startQuestion(room, category) {
    clearTimers(room);
    const q = L.pickQuestion(room.usedQuestions, room.settings.categories, category);
    if (!q) return endGame(room, 'no_questions');
    room.question = q;
    room.state = 'question';
    broadcast(room);
    for (const p of connected(room)) emitTo(p, 'game:question', questionPayload(room, p.id));
    emitAll(room, 'game:answered', progressCounts(room, room.answers));
    setTimer(room, room.settings.answerTime, () => startVoting(room));
  }

  function startVoting(room) {
    clearTimers(room);
    room.state = 'voting';
    const groups = L.groupAnswers(room.answers, room.question);
    room.options = L.shuffle([{ text: realText(room), correct: true, authors: [] },
      ...groups.map(g => ({ text: g.text, correct: false, authors: g.authors }))]);
    broadcast(room);
    for (const p of connected(room)) emitTo(p, 'game:vote', votePayload(room, p.id));
    emitAll(room, 'game:voted', progressCounts(room, room.votes));
    setTimer(room, room.settings.voteTime, () => showResults(room));
  }

  function showResults(room) {
    clearTimers(room);
    room.state = 'results';
    const ids = [...room.players.keys()];
    const rs = L.scoreRound(ids, room.options, room.votes);
    for (const [id, r] of rs) {
      const p = room.players.get(id);
      if (p) p.score += r.points;
      r.answer = room.answers.get(id) ?? null;
    }
    const who = id => ({ id, name: room.names.get(id)?.name ?? '?', avatar: room.names.get(id)?.avatar ?? '?' });
    const players = L.rankPlayers([...room.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score })));
    room.lastResults = {
      question: questionText(room), correctAnswer: realText(room),
      round: room.round, totalRounds: room.settings.rounds,
      isLast: room.round >= room.settings.rounds || L.availableCategories(room.usedQuestions, room.settings.categories).length === 0,
      options: room.options.map((o, i) => ({
        text: o.text, correct: o.correct, authors: o.authors.map(who),
        voters: [...room.votes].filter(([, vi]) => vi === i).map(([vid]) => who(vid)),
      })),
      roundScores: Object.fromEntries(rs), players,
    };
    broadcast(room);
    emitAll(room, 'game:results', room.lastResults);
  }

  function endGame(room, reason = 'rounds') {
    clearTimers(room);
    room.state = 'finished';
    room.pickerId = null;
    const players = [...room.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));
    room.lastEnd = { players: L.rankPlayers(players), reason };
    broadcast(room);
    emitAll(room, 'game:end', room.lastEnd);
  }

  /** Called whenever someone acts or leaves: advance if nobody connected is left to wait for. */
  function checkProgress(room) {
    const conn = connected(room);
    if (room.state === 'picking') {
      const picker = room.players.get(room.pickerId);
      if (!picker || !picker.connected) {
        const cats = room.pickCats;
        startQuestion(room, cats[Math.floor(Math.random() * cats.length)]);
      }
    } else if (room.state === 'question') {
      emitAll(room, 'game:answered', progressCounts(room, room.answers));
      if (conn.length && conn.every(p => room.answers.has(p.id))) advanceSoon(room, 'question', () => startVoting(room));
    } else if (room.state === 'voting') {
      emitAll(room, 'game:voted', progressCounts(room, room.votes));
      if (conn.length && conn.every(p => room.votes.has(p.id))) advanceSoon(room, 'voting', () => showResults(room));
    }
  }

  function ensureHost(room) {
    const host = room.players.get(room.hostId);
    if (host && host.connected) return false;
    const next = connected(room)[0] || (!host && room.players.values().next().value);
    if (!next || next.id === room.hostId) return false;
    room.hostId = next.id;
    return true;
  }

  // ---------- seats ----------
  function attach(conn, room, player) {
    if (player.conn && player.conn !== conn) {
      const old = player.conn;
      old.playerId = null;
      old.send('session:replaced');
      old.close(CLOSE_REPLACED, 'replaced');
    }
    if (conn.playerId && conn.playerId !== player.id) leave(conn, 'left');
    clearTimeout(player.graceTimer); player.graceTimer = null;
    const wasOffline = !player.connected;
    player.conn = conn; player.connected = true;
    conn.playerId = player.id;
    ensureHost(room);
    return wasOffline;
  }

  function removePlayer(room, id, reason) {
    const p = room.players.get(id);
    if (!p) return;
    clearTimeout(p.graceTimer);
    room.players.delete(id);
    if (p.conn) p.conn.playerId = null;
    if (room.players.size === 0) {
      clearTimers(room);
      if (current === room) { current = null; onIdle(); }
      return;
    }
    ensureHost(room);
    sys(room, reason === 'kicked' ? 'kicked' : 'left', p.name);
    broadcast(room);
    checkProgress(room);
  }

  function leave(conn, reason) {
    const id = conn.playerId;
    conn.playerId = null;
    if (current && id) removePlayer(current, id, reason);
  }

  // The code in the payload must match the room this connection was opened for.
  const findRoom = c => (normalizeCode(c) === code ? current : null);
  function seatByToken(room, token) { return [...room.players.values()].find(p => p.token === token); }

  function afterAttach(room, player, wasOffline) {
    broadcast(room);
    if (wasOffline && room.state !== 'lobby') sys(room, 'back', player.name);
    sendPhase(room, player);
    checkProgress(room);
  }

  function joinAck(room, player) {
    return { success: true, code: room.code, playerId: player.id, state: room.state, chat: room.chat.slice(-30) };
  }

  const ctx = conn => {
    const room = current;
    const player = room && conn.playerId ? room.players.get(conn.playerId) : null;
    return player ? { room, player, isHost: room.hostId === player.id } : null;
  };
  const profile = data => ({
    name: L.cleanText(data.name, L.MAX_NAME_LEN),
    avatar: L.cleanText(typeof data.avatar === 'string' ? data.avatar : '', 8) || '😎',
  });
  const newPlayer = (token, name, avatar) => ({ id: newId(), token, name, avatar, conn: null, connected: false, graceTimer: null, score: 0 });

  // ---------- event handlers: (conn, data, ack) ----------
  const handlers = new Map();
  const on = (ev, fn) => handlers.set(ev, fn);

  on('room:create', (conn, data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object') return cb({ success: false, error: 'invalid' });
    const { name, avatar } = profile(data);
    if (!name || !validToken(data.token)) return cb({ success: false, error: 'invalid' });
    // Only an empty room can be created; the code was reserved by POST /api/rooms.
    if (current) return cb({ success: false, error: 'taken' });
    clearTimeout(reserveTimer); reserveTimer = null;
    const room = current = newGame(data.lang);
    const player = newPlayer(data.token, name, avatar);
    room.players.set(player.id, player);
    room.names.set(player.id, { name, avatar });
    room.hostId = player.id;
    attach(conn, room, player);
    cb(joinAck(room, player));
    broadcast(room);
  });

  on('room:join', (conn, data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object') return cb({ success: false, error: 'invalid' });
    const { name, avatar } = profile(data);
    if (!name || !validToken(data.token)) return cb({ success: false, error: 'invalid' });
    const room = findRoom(data.code);
    if (!room) return cb({ success: false, error: 'not_found' });
    if (room.kicked.has(data.token)) return cb({ success: false, error: 'kicked' });
    const seat = seatByToken(room, data.token);
    if (seat) { // same browser coming back: resume the seat instead of creating a ghost
      const wasOffline = attach(conn, room, seat);
      cb(joinAck(room, seat));
      return afterAttach(room, seat, wasOffline);
    }
    if (room.state !== 'lobby') return cb({ success: false, error: 'started' });
    if (connected(room).length >= room.settings.maxPlayers) return cb({ success: false, error: 'full' });
    const player = newPlayer(data.token, name, avatar);
    room.players.set(player.id, player);
    room.names.set(player.id, { name, avatar });
    attach(conn, room, player);
    cb(joinAck(room, player));
    broadcast(room);
    sys(room, 'joined', name);
  });

  on('room:resume', (conn, data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object' || !validToken(data.token)) return cb({ success: false, error: 'invalid' });
    const room = findRoom(data.code);
    const seat = room && seatByToken(room, data.token);
    if (!seat) return cb({ success: false, error: 'not_found' });
    const wasOffline = attach(conn, room, seat);
    cb(joinAck(room, seat));
    afterAttach(room, seat, wasOffline);
  });

  on('room:leave', (conn, data, cb) => {
    if (conn.playerId) leave(conn, 'left');
    if (typeof cb === 'function') cb({ success: true });
  });

  on('room:settings', (conn, s) => {
    const c = ctx(conn); if (!c || !c.isHost || c.room.state !== 'lobby') return;
    c.room.settings = L.sanitizeSettings(c.room.settings, s);
    broadcast(c.room);
  });

  on('room:kick', (conn, pid) => {
    const c = ctx(conn); if (!c || !c.isHost || typeof pid !== 'string' || pid === c.player.id) return;
    const target = c.room.players.get(pid); if (!target) return;
    const targetConn = target.conn;
    c.room.kicked.add(target.token);
    emitTo(target, 'kicked');
    removePlayer(c.room, pid, 'kicked');
    if (targetConn) targetConn.close(CLOSE_KICKED, 'kicked');
  });

  on('game:start', conn => {
    const c = ctx(conn); if (!c || !c.isHost || c.room.state !== 'lobby') return;
    const room = c.room;
    if (connected(room).length < 2) return emitTo(c.player, 'error', 'need2');
    // Players who dropped in the lobby and never came back don't join the game.
    for (const p of [...room.players.values()]) if (!p.connected) removePlayer(room, p.id, 'left');
    room.round = 0; room.pickerIndex = 0; room.usedQuestions.clear();
    room.lastEnd = null; room.names.clear();
    for (const p of room.players.values()) { p.score = 0; room.names.set(p.id, { name: p.name, avatar: p.avatar }); }
    startRound(room);
  });

  on('game:pickCategory', (conn, cat) => {
    const c = ctx(conn); if (!c) return;
    const { room, player } = c;
    if (room.state !== 'picking' || player.id !== room.pickerId) return;
    if (typeof cat !== 'string' || !room.pickCats.includes(cat)) return;
    startQuestion(room, cat);
  });

  on('game:answer', (conn, text, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const c = ctx(conn); if (!c) return ack({ success: false, error: 'invalid' });
    const { room, player } = c;
    if (room.state !== 'question') return ack({ success: false, error: 'phase' });
    if (room.answers.has(player.id)) return ack({ success: false, error: 'already' });
    const clean = L.cleanText(text, L.MAX_ANSWER_LEN);
    if (!clean) return ack({ success: false, error: 'empty' });
    if (L.isRealAnswer(room.question, clean)) return ack({ success: false, error: 'real' });
    room.answers.set(player.id, clean);
    ack({ success: true, answer: clean });
    checkProgress(room);
  });

  on('game:vote', (conn, idx, cb) => {
    const ack = typeof cb === 'function' ? cb : () => {};
    const c = ctx(conn); if (!c) return ack({ success: false, error: 'invalid' });
    const { room, player } = c;
    if (room.state !== 'voting') return ack({ success: false, error: 'phase' });
    if (room.votes.has(player.id)) return ack({ success: false, error: 'already' });
    if (!Number.isInteger(idx) || idx < 0 || idx >= room.options.length) return ack({ success: false, error: 'invalid' });
    if (room.options[idx].authors.includes(player.id)) return ack({ success: false, error: 'own' });
    room.votes.set(player.id, idx);
    ack({ success: true });
    checkProgress(room);
  });

  on('game:next', conn => {
    const c = ctx(conn); if (!c || !c.isHost || c.room.state !== 'results') return;
    startRound(c.room);
  });

  on('game:restart', conn => {
    const c = ctx(conn); if (!c || !c.isHost || c.room.state !== 'finished') return;
    const room = c.room;
    clearTimers(room);
    room.state = 'lobby'; room.round = 0; room.pickerIndex = 0; room.pickerId = null;
    room.usedQuestions.clear(); room.lastEnd = null; room.lastResults = null;
    for (const p of room.players.values()) p.score = 0;
    broadcast(room);
  });

  on('chat:send', (conn, text) => {
    const c = ctx(conn); if (!c) return;
    const t = L.cleanText(text, 200); if (!t) return;
    const m = { t: 'p', name: c.player.name, avatar: c.player.avatar, text: t };
    c.room.chat.push(m); if (c.room.chat.length > 100) c.room.chat.shift();
    emitAll(c.room, 'chat:msg', m);
  });

  /** Runs one event. Unknown events are ignored (no ack either). */
  function handle(conn, ev, data, ack) {
    const fn = handlers.get(ev);
    if (!fn || disposed) return;
    let replied = false;
    const once = typeof ack === 'function' ? d => { if (!replied) { replied = true; ack(d); } } : undefined;
    try { fn(conn, data, once); } catch (e) {
      log(`handler "${ev}" failed:`, e);
      if (once) { try { once({ success: false, error: 'server' }); } catch { /* ignore */ } }
    }
  }

  // ---------- connections ----------
  function open(conn) {
    if (disposed) return conn.close(1001, 'closed');
    conn.seen = Date.now();
    conns.add(conn);
    if (!sweepTimer) sweepTimer = setInterval(safe('sweep', sweep), IDLE_CUTOFF_MS / 4);
  }

  // A phone that drops off the network may never send a close frame: free its seat for the grace period.
  function sweep() {
    const now = Date.now();
    for (const conn of [...conns]) {
      if (now - conn.seen > IDLE_CUTOFF_MS) { conn.close(1001, 'idle'); disconnect(conn); }
    }
  }

  /** Raw text frame from a client: `{t: event, d: data, id?: ackId}`. Anything else is ignored. */
  function message(conn, raw) {
    if (!conns.has(conn)) return;
    if (typeof raw !== 'string') return;
    if (raw.length > MAX_MESSAGE_BYTES) { conn.close(1009, 'too big'); disconnect(conn); return; }
    conn.seen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    if (msg.t === 'ping') { conn.send('pong'); return; }
    const id = msg.id;
    const ack = Number.isSafeInteger(id) && id >= 0 ? d => conn.reply(id, d) : undefined;
    handle(conn, msg.t, msg.d, ack);
  }

  /** The transport closed (safe to call more than once). */
  function disconnect(conn) {
    if (!conns.delete(conn)) return;
    if (!conns.size) { clearInterval(sweepTimer); sweepTimer = null; }
    const room = current;
    const player = room && conn.playerId ? room.players.get(conn.playerId) : null;
    conn.playerId = null;
    if (player && player.conn === conn && !disposed) {
      player.connected = false; player.conn = null;
      player.graceTimer = setTimeout(safe('grace', () => {
        if (current === room && room.players.get(player.id) === player && !player.connected) removePlayer(room, player.id, 'left');
      }), graceMs);
      ensureHost(room);
      broadcast(room);
      if (room.state === 'question') emitAll(room, 'game:answered', progressCounts(room, room.answers));
      if (room.state === 'voting') emitAll(room, 'game:voted', progressCounts(room, room.votes));
      setTimeout(safe('settle', () => { if (current === room) checkProgress(room); }), settleMs);
    }
    onIdle();
  }

  /** Holds a freshly handed-out code for its creator. False if the room is live or already reserved. */
  function reserve() {
    if (current || reserveTimer || disposed) return false;
    reserveTimer = setTimeout(safe('reserve', () => { reserveTimer = null; onIdle(); }), RESERVE_MS);
    return true;
  }

  function dispose() {
    disposed = true;
    clearTimeout(reserveTimer); reserveTimer = null;
    clearInterval(sweepTimer); sweepTimer = null;
    if (current) {
      clearTimers(current);
      for (const p of current.players.values()) clearTimeout(p.graceTimer);
      current = null;
    }
    for (const conn of conns) conn.close(1001, 'closed');
    conns.clear();
  }

  return {
    code, open, message, handle, disconnect, reserve, dispose,
    /** No game, no open connections and no pending reservation: safe to forget. */
    idle: () => !current && conns.size === 0 && !reserveTimer,
    get live() { return !!current; },
    /** The game state (null when nobody is seated). Exposed for tests. */
    get data() { return current; },
  };
}

module.exports = {
  createRoom, makeConn, genCode, normalizeCode,
  CODE_RE, MAX_MESSAGE_BYTES, CLOSE_REPLACED, CLOSE_KICKED,
};
