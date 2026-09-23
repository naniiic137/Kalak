'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const L = require('./lib/logic');

const PICK_TIME = 15;
const DEFAULT_GRACE_MS = 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Builds the HTTP + Socket.io server. Options (mostly for tests):
 *   graceMs          how long a disconnected player keeps their seat (default 60 s)
 *   advanceDelayMs   pause before moving on once everyone has answered/voted (default 500 ms)
 *   disconnectSettleMs  after a disconnect, wait this long (a page reload usually comes back
 *                    within it) before re-checking whether the round can move on (default 3 s)
 *   log              logger for handler errors (default console.error)
 */
function createGameServer(opts = {}) {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const advanceDelayMs = opts.advanceDelayMs ?? 500;
  const settleMs = opts.disconnectSettleMs ?? 3000;
  const log = opts.log || ((...a) => console.error('[kalak]', ...a));

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  app.use(express.static(path.join(__dirname, 'public')));

  const rooms = new Map();

  // Every async callback goes through this so one bad event can't take the process down.
  const safe = (label, fn) => (...args) => {
    try { return fn(...args); } catch (e) { log(`${label} failed:`, e); }
  };

  const channel = room => `room:${room.code}`;
  const newId = () => crypto.randomBytes(8).toString('hex');

  function genCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 5; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    } while (rooms.has(code));
    return code;
  }

  function createRoom(lang) {
    const settings = L.sanitizeSettings(L.DEFAULT_SETTINGS, { lang });
    const room = {
      code: genCode(), hostId: null, players: new Map(), state: 'lobby', settings,
      round: 0, pickerIndex: 0, pickerId: null, pickCats: [], question: null,
      answers: new Map(), votes: new Map(), options: null, names: new Map(),
      usedQuestions: new Set(), timer: null, advanceTimer: null, timeLeft: 0, timeMax: 0,
      kicked: new Set(), chat: [], lastResults: null, lastEnd: null,
    };
    rooms.set(room.code, room);
    return room;
  }

  const connected = room => [...room.players.values()].filter(p => p.connected);

  function emitAll(room, ev, data) { io.to(channel(room)).emit(ev, data); }
  function emitTo(player, ev, data) { if (player.connected && player.socketId) io.to(player.socketId).emit(ev, data); }
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
  function attach(socket, room, player) {
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        old.data.roomCode = null; old.data.playerId = null;
        old.leave(channel(room));
        old.emit('session:replaced');
        old.disconnect(true);
      }
    }
    if (socket.data.roomCode && (socket.data.roomCode !== room.code || socket.data.playerId !== player.id)) leave(socket, 'left');
    clearTimeout(player.graceTimer); player.graceTimer = null;
    const wasOffline = !player.connected;
    player.socketId = socket.id; player.connected = true;
    socket.data.roomCode = room.code; socket.data.playerId = player.id;
    socket.join(channel(room));
    ensureHost(room);
    return wasOffline;
  }

  function removePlayer(room, id, reason) {
    const p = room.players.get(id);
    if (!p) return;
    clearTimeout(p.graceTimer);
    room.players.delete(id);
    const s = p.socketId && io.sockets.sockets.get(p.socketId);
    if (s) { s.leave(channel(room)); s.data.roomCode = null; s.data.playerId = null; }
    if (room.players.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
    ensureHost(room);
    sys(room, reason === 'kicked' ? 'kicked' : 'left', p.name);
    broadcast(room);
    checkProgress(room);
  }

  function leave(socket, reason) {
    const room = rooms.get(socket.data.roomCode);
    const id = socket.data.playerId;
    socket.data.roomCode = null; socket.data.playerId = null;
    if (room && id) removePlayer(room, id, reason);
  }

  function findRoom(code) { return typeof code === 'string' ? rooms.get(code.trim().toUpperCase()) : undefined; }
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

  // ---------- socket handlers ----------
  io.on('connection', socket => {
    const on = (ev, fn) => socket.on(ev, (...args) => {
      try { fn(...args); } catch (e) {
        log(`handler "${ev}" failed:`, e);
        const ack = args[args.length - 1];
        if (typeof ack === 'function') { try { ack({ success: false, error: 'server' }); } catch { /* ignore */ } }
      }
    });
    const ctx = () => {
      const room = rooms.get(socket.data.roomCode);
      const player = room && room.players.get(socket.data.playerId);
      return player ? { room, player, isHost: room.hostId === player.id } : null;
    };
    const profile = data => ({
      name: L.cleanText(data.name, L.MAX_NAME_LEN),
      avatar: L.cleanText(typeof data.avatar === 'string' ? data.avatar : '', 8) || '😎',
    });

    on('room:create', (data, cb) => {
      if (typeof cb !== 'function') return;
      if (!data || typeof data !== 'object') return cb({ success: false, error: 'invalid' });
      const { name, avatar } = profile(data);
      if (!name || !TOKEN_RE.test(data.token || '')) return cb({ success: false, error: 'invalid' });
      if (socket.data.roomCode) leave(socket, 'left');
      const room = createRoom(data.lang);
      const player = { id: newId(), token: data.token, name, avatar, socketId: null, connected: false, graceTimer: null, score: 0 };
      room.players.set(player.id, player);
      room.names.set(player.id, { name, avatar });
      room.hostId = player.id;
      attach(socket, room, player);
      cb(joinAck(room, player));
      broadcast(room);
    });

    on('room:join', (data, cb) => {
      if (typeof cb !== 'function') return;
      if (!data || typeof data !== 'object') return cb({ success: false, error: 'invalid' });
      const { name, avatar } = profile(data);
      if (!name || !TOKEN_RE.test(data.token || '')) return cb({ success: false, error: 'invalid' });
      const room = findRoom(data.code);
      if (!room) return cb({ success: false, error: 'not_found' });
      if (room.kicked.has(data.token)) return cb({ success: false, error: 'kicked' });
      const seat = seatByToken(room, data.token);
      if (seat) { // same browser coming back: resume the seat instead of creating a ghost
        const wasOffline = attach(socket, room, seat);
        cb(joinAck(room, seat));
        return afterAttach(room, seat, wasOffline);
      }
      if (room.state !== 'lobby') return cb({ success: false, error: 'started' });
      if (connected(room).length >= room.settings.maxPlayers) return cb({ success: false, error: 'full' });
      const player = { id: newId(), token: data.token, name, avatar, socketId: null, connected: false, graceTimer: null, score: 0 };
      room.players.set(player.id, player);
      room.names.set(player.id, { name, avatar });
      attach(socket, room, player);
      cb(joinAck(room, player));
      broadcast(room);
      sys(room, 'joined', name);
    });

    on('room:resume', (data, cb) => {
      if (typeof cb !== 'function') return;
      if (!data || typeof data !== 'object' || !TOKEN_RE.test(data.token || '')) return cb({ success: false, error: 'invalid' });
      const room = findRoom(data.code);
      const seat = room && seatByToken(room, data.token);
      if (!seat) return cb({ success: false, error: 'not_found' });
      const wasOffline = attach(socket, room, seat);
      cb(joinAck(room, seat));
      afterAttach(room, seat, wasOffline);
    });

    on('room:leave', cb => {
      if (socket.data.roomCode) leave(socket, 'left');
      if (typeof cb === 'function') cb({ success: true });
    });

    on('room:settings', s => {
      const c = ctx(); if (!c || !c.isHost || c.room.state !== 'lobby') return;
      c.room.settings = L.sanitizeSettings(c.room.settings, s);
      broadcast(c.room);
    });

    on('room:kick', pid => {
      const c = ctx(); if (!c || !c.isHost || typeof pid !== 'string' || pid === c.player.id) return;
      const target = c.room.players.get(pid); if (!target) return;
      c.room.kicked.add(target.token);
      emitTo(target, 'kicked');
      removePlayer(c.room, pid, 'kicked');
    });

    on('game:start', () => {
      const c = ctx(); if (!c || !c.isHost || c.room.state !== 'lobby') return;
      const room = c.room;
      if (connected(room).length < 2) return emitTo(c.player, 'error', 'need2');
      // Players who dropped in the lobby and never came back don't join the game.
      for (const p of [...room.players.values()]) if (!p.connected) removePlayer(room, p.id, 'left');
      room.round = 0; room.pickerIndex = 0; room.usedQuestions.clear();
      room.lastEnd = null; room.names.clear();
      for (const p of room.players.values()) { p.score = 0; room.names.set(p.id, { name: p.name, avatar: p.avatar }); }
      startRound(room);
    });

    on('game:pickCategory', cat => {
      const c = ctx(); if (!c) return;
      const { room, player } = c;
      if (room.state !== 'picking' || player.id !== room.pickerId) return;
      if (typeof cat !== 'string' || !room.pickCats.includes(cat)) return;
      startQuestion(room, cat);
    });

    on('game:answer', (text, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      const c = ctx(); if (!c) return ack({ success: false, error: 'invalid' });
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

    on('game:vote', (idx, cb) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      const c = ctx(); if (!c) return ack({ success: false, error: 'invalid' });
      const { room, player } = c;
      if (room.state !== 'voting') return ack({ success: false, error: 'phase' });
      if (room.votes.has(player.id)) return ack({ success: false, error: 'already' });
      if (!Number.isInteger(idx) || idx < 0 || idx >= room.options.length) return ack({ success: false, error: 'invalid' });
      if (room.options[idx].authors.includes(player.id)) return ack({ success: false, error: 'own' });
      room.votes.set(player.id, idx);
      ack({ success: true });
      checkProgress(room);
    });

    on('game:next', () => {
      const c = ctx(); if (!c || !c.isHost || c.room.state !== 'results') return;
      startRound(c.room);
    });

    on('game:restart', () => {
      const c = ctx(); if (!c || !c.isHost || c.room.state !== 'finished') return;
      const room = c.room;
      clearTimers(room);
      room.state = 'lobby'; room.round = 0; room.pickerIndex = 0; room.pickerId = null;
      room.usedQuestions.clear(); room.lastEnd = null; room.lastResults = null;
      for (const p of room.players.values()) p.score = 0;
      broadcast(room);
    });

    on('chat:send', text => {
      const c = ctx(); if (!c) return;
      const t = L.cleanText(text, 200); if (!t) return;
      const m = { t: 'p', name: c.player.name, avatar: c.player.avatar, text: t };
      c.room.chat.push(m); if (c.room.chat.length > 100) c.room.chat.shift();
      emitAll(c.room, 'chat:msg', m);
    });

    on('disconnect', () => {
      const room = rooms.get(socket.data.roomCode);
      const player = room && room.players.get(socket.data.playerId);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false; player.socketId = null;
      player.graceTimer = setTimeout(safe('grace', () => {
        if (rooms.get(room.code) === room && room.players.get(player.id) === player && !player.connected) removePlayer(room, player.id, 'left');
      }), graceMs);
      ensureHost(room);
      broadcast(room);
      if (room.state === 'question') emitAll(room, 'game:answered', progressCounts(room, room.answers));
      if (room.state === 'voting') emitAll(room, 'game:voted', progressCounts(room, room.votes));
      setTimeout(safe('settle', () => { if (rooms.get(room.code) === room) checkProgress(room); }), settleMs);
    });
  });

  function close() {
    for (const room of rooms.values()) {
      clearTimers(room);
      for (const p of room.players.values()) clearTimeout(p.graceTimer);
    }
    rooms.clear();
    return new Promise(resolve => { io.close(() => resolve()); });
  }

  return { app, server, io, rooms, close };
}

module.exports = { createGameServer };

if (require.main === module) {
  const { server } = createGameServer();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
