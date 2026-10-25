'use strict';
// End-to-end tests: a real server on a test port, driven by a small WebSocket client.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { connect: wsConnect } = require('./ws-client');
const { createGameServer } = require('../server');

const PORT = Number(process.env.KALAK_TEST_PORT) || 3609;
const URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const GRACE_MS = 1500;

let game;
const errors = [];
const clients = new Set();

test.before(async () => {
  game = createGameServer({ graceMs: GRACE_MS, advanceDelayMs: 30, disconnectSettleMs: 150, log: (...a) => errors.push(a) });
  await new Promise((resolve, reject) => { game.server.once('error', reject); game.server.listen(PORT, resolve); });
});

test.after(async () => {
  for (const c of clients) c.disconnect();
  await game.close();
});

test.afterEach(() => {
  assert.deepEqual(errors.splice(0), [], 'no handler errors were logged');
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const newToken = () => crypto.randomBytes(16).toString('hex');

async function connect(code) {
  const s = await wsConnect(`${WS_URL}?room=${encodeURIComponent(code)}`);
  clients.add(s);
  return s;
}

/** Asks the server for a fresh room code, like the browser does before room:create. */
async function newCode() {
  const r = await fetch(`${URL}/api/rooms`, { method: 'POST' });
  assert.equal(r.status, 200);
  return (await r.json()).code;
}

/** Resolves with the next `ev` received that matches `pred`. */
function waitFor(s, ev, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, ms);
    function h(data) { if (pred(data)) { clearTimeout(t); s.off(ev, h); resolve(data); } }
    s.on(ev, h);
  });
}
const ack = (s, ev, data) => new Promise(resolve => s.emit(ev, data, resolve));
const lastState = s => [...s.events].reverse().find(e => e.ev === 'room:state')?.data;

async function makePlayer(name, code) {
  const s = await connect(code || await newCode());
  s.token = newToken();
  const r = code
    ? await ack(s, 'room:join', { code, name, avatar: '🦊', token: s.token })
    : await ack(s, 'room:create', { name, avatar: '😎', token: s.token, lang: 'en' });
  assert.equal(r.success, true, JSON.stringify(r));
  s.pid = r.playerId; s.code = r.code; s.name = name;
  return s;
}

async function makeRoom(n = 3) {
  const host = await makePlayer('Host');
  const players = [host];
  for (let i = 1; i < n; i++) players.push(await makePlayer(`P${i}`, host.code));
  await sleep(50);
  return players;
}

const roomOf = s => game.rooms.get(s.code)?.data;
const byPid = (ps, pid) => ps.find(p => p.pid === pid);

/** Starts the game (or next round) and has the picker choose, resolving when the question is shown. */
async function toQuestion(ps, trigger) {
  const pick = waitFor(ps[0], 'game:pick');
  trigger();
  const p = await pick;
  const q = waitFor(ps[0], 'game:question');
  byPid(ps, p.pickerId).emit('game:pickCategory', p.categories[0]);
  return q;
}

async function answerAll(ps, answers) {
  const vote = waitFor(ps[0], 'game:vote');
  for (let i = 0; i < ps.length; i++) {
    const r = await ack(ps[i], 'game:answer', answers[i]);
    assert.equal(r.success, true, JSON.stringify(r));
  }
  return vote;
}

test('bad settings payloads do not crash the server and the game still starts', async () => {
  const [host, p1] = await makeRoom(2);
  for (const bad of [{ categories: [] }, { categories: ['nope'] }, { categories: 'general' }, null, 42, 'x',
    { rounds: 'many', answerTime: -1, maxPlayers: 1e12, lang: 'xx', evil: true }, { __proto__: { polluted: 1 } }]) {
    host.emit('room:settings', bad);
  }
  await sleep(100);
  const room = roomOf(host);
  assert.deepEqual(room.settings.categories, ['general']);
  assert.equal(room.settings.answerTime, 10);
  assert.equal(room.settings.maxPlayers, 50);
  assert.equal(room.settings.lang, 'en');
  assert.equal(room.settings.evil, undefined);
  assert.equal({}.polluted, undefined);

  const q = await toQuestion([host, p1], () => host.emit('game:start'));
  assert.equal(typeof q.question, 'string');
  assert.equal(q.category, 'general');
});

test('malformed events are ignored and never crash the process', async () => {
  const [host, p1] = await makeRoom(2);
  const junk = [undefined, null, 1, 'x', {}, [], { code: 5 }, { name: {} }, () => {}];
  for (const ev of ['room:create', 'room:join', 'room:resume', 'room:settings', 'room:kick', 'game:pickCategory',
    'game:answer', 'game:vote', 'game:next', 'game:restart', 'chat:send', 'debug:getAnswers', 'debug:skip',
    'host:pause', 'host:resume', 'host:skip', 'host:endGame', 'host:addRounds']) {
    for (const j of junk) { p1.emit(ev, j); p1.emit(ev, j, () => {}); }
  }
  await sleep(150);
  // The server still works.
  const again = await makePlayer('Late', host.code);
  assert.ok(again.pid);
  assert.equal(roomOf(host).state, 'lobby');
});

test('the host tools that leaked answers are gone', async () => {
  const [host, p1] = await makeRoom(2);
  await toQuestion([host, p1], () => host.emit('game:start'));
  await ack(p1, 'game:answer', 'secret bluff');
  const reply = await Promise.race([ack(host, 'debug:getAnswers', null), sleep(300).then(() => 'no reply')]);
  assert.equal(reply, 'no reply');
});

test('full round: duplicate bluffs merge, own option is flagged and refused, real answer is refused', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  const room = roomOf(host);

  const real = await ack(p2, 'game:answer', `  ${room.question.aE.toUpperCase()} `);
  assert.deepEqual(real, { success: false, error: 'real' });
  const long = 'x'.repeat(200);

  const voteP1P = waitFor(p1, 'game:vote');
  const vote = await answerAll(ps, ['Fake A', 'fake  a', long]);
  const voteP1 = await voteP1P;
  const texts = vote.options.map(o => o.text);
  assert.equal(texts.length, 3, `real + 2 merged bluffs: ${texts}`);
  assert.equal(vote.question, room.question.qE, 'vote screen repeats the question');
  assert.ok(texts.includes('x'.repeat(60)), 'answers are capped at 60 chars');
  const fake = vote.options.find(o => o.text === 'Fake A');
  assert.equal(fake.own, true, 'host sees own option flagged');
  assert.equal(voteP1.options.find(o => o.id === fake.id).own, true, 'merged author also sees it as own');
  assert.deepEqual(await ack(host, 'game:vote', fake.id), { success: false, error: 'own' });

  const realOpt = vote.options.find(o => o.text === room.question.aE);
  const resultsP = waitFor(host, 'game:results');
  assert.equal((await ack(host, 'game:vote', realOpt.id)).success, true);
  assert.equal((await ack(p1, 'game:vote', realOpt.id)).success, true);
  assert.equal((await ack(p2, 'game:vote', fake.id)).success, true);
  const res = await resultsP;
  assert.equal(res.roundScores[host.pid].points, 3); // +2 truth, +1 fooled p2
  assert.equal(res.roundScores[p1.pid].points, 3); // same: co-author of the bluff
  assert.equal(res.roundScores[p2.pid].points, 0);
  const merged = res.options.find(o => o.text === 'Fake A');
  assert.deepEqual(merged.authors.map(a => a.id).sort(), [host.pid, p1.pid].sort());
  const ranks = Object.fromEntries(res.players.map(p => [p.id, p.rank]));
  assert.equal(ranks[host.pid], 1);
  assert.equal(ranks[p1.pid], 1, 'tied players share the rank');
  assert.equal(ranks[p2.pid], 3);
});

test('reload mid-game resumes the same seat and score', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  roomOf(host).players.get(p2.pid).score = 7;
  await ack(p2, 'game:answer', 'my bluff');

  p2.disconnect();
  await sleep(50);
  assert.equal(roomOf(host).players.get(p2.pid).connected, false);

  const back = await connect(host.code);
  const q = waitFor(back, 'game:question');
  const r = await ack(back, 'room:resume', { code: host.code, token: p2.token });
  assert.equal(r.success, true);
  assert.equal(r.playerId, p2.pid, 'same seat');
  const qd = await q;
  assert.equal(qd.answered, true);
  assert.equal(qd.myAnswer, 'my bluff');
  await sleep(50);
  const me = lastState(host).players.find(p => p.id === p2.pid);
  assert.equal(me.connected, true);
  assert.equal(me.score, 7);
  assert.equal(lastState(host).players.length, 3, 'no ghost seat');

  // Joining again through the join form with the same browser token also resumes (no "Game already started").
  const viaJoin = await connect(host.code);
  const j = await ack(viaJoin, 'room:join', { code: host.code, name: 'Whatever', avatar: '🐱', token: p2.token });
  assert.equal(j.success, true);
  assert.equal(j.playerId, p2.pid);
  await sleep(50);
  assert.ok(back.events.some(e => e.ev === 'session:replaced'), 'older tab is told it was replaced');
  assert.equal(back.closeCode, 4001, 'and its connection is closed so it does not reconnect');
  assert.equal(roomOf(host).players.size, 3);

  // A different browser still can't join a running game.
  const stranger = await connect(host.code);
  const s = await ack(stranger, 'room:join', { code: host.code, name: 'New', avatar: '🐱', token: newToken() });
  assert.deepEqual(s, { success: false, error: 'started' });
});

test('reloading in the lobby leaves no ghost and does not use up a slot', async () => {
  const [host, p1] = await makeRoom(2);
  host.emit('room:settings', { maxPlayers: 2 });
  await sleep(50);
  p1.disconnect();
  await sleep(50);
  const back = await connect(host.code);
  const r = await ack(back, 'room:resume', { code: host.code, token: p1.token });
  assert.equal(r.playerId, p1.pid);
  await sleep(50);
  assert.equal(roomOf(host).players.size, 2);
  assert.deepEqual(lastState(host).players.map(p => p.connected), [true, true]);
});

test('a player who never comes back is removed after the grace period (not on the podium)', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  p2.disconnect();
  await sleep(GRACE_MS + 300);
  assert.equal(roomOf(host).players.has(p2.pid), false);
  assert.equal(lastState(host).players.length, 2);
  const back = await connect(host.code);
  const r = await ack(back, 'room:resume', { code: host.code, token: p2.token });
  assert.equal(r.success, false);
});

test('player leaving mid-round: the round advances without waiting for the timer', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  await ack(host, 'game:answer', 'bluff one');
  await ack(p1, 'game:answer', 'bluff two');
  const vote = waitFor(host, 'game:vote', () => true, 1500); // answer timer is 30 s
  p2.disconnect();
  const v = await vote;
  assert.equal(v.options.length, 3);

  // Same during voting: p1 leaves after the host voted.
  const res = waitFor(host, 'game:results', () => true, 1500);
  await ack(host, 'game:vote', v.options.find(o => !o.own).id);
  p1.disconnect();
  await res;
});

test('picker leaving: a random topic is chosen right away', async () => {
  const ps = await makeRoom(3);
  const [host] = ps;
  const pick = waitFor(host, 'game:pick');
  host.emit('game:start');
  const p = await pick;
  const picker = byPid(ps, p.pickerId);
  const watcher = ps.find(s => s !== picker);
  const q = waitFor(watcher, 'game:question', () => true, 1500);
  picker.disconnect();
  await q;
});

test('host leaving on the results screen: the new host gets control and can go on', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  const vote = await answerAll(ps, ['a1', 'a2', 'a3']);
  const res = waitFor(p1, 'game:results');
  for (const s of ps) await ack(s, 'game:vote', vote.options.find(o => o.text === roomOf(host).question.aE).id);
  await res;

  const newHost = waitFor(p1, 'room:state', st => st.hostId !== host.pid);
  host.disconnect();
  const st = await newHost;
  assert.ok([p1.pid, p2.pid].includes(st.hostId));
  const nh = byPid(ps, st.hostId);
  const pick = waitFor(nh, 'game:pick');
  nh.emit('game:next');
  const pk = await pick;
  assert.equal(pk.round, 2);
  assert.notEqual(pk.pickerId, host.pid, 'disconnected players are not asked to pick');
});

test('kicks are stored by token, not by name', async () => {
  const [host, p1] = await makeRoom(2);
  const kicked = waitFor(p1, 'kicked');
  host.emit('room:kick', p1.pid);
  await kicked;
  const s = await connect(host.code);
  const again = await ack(s, 'room:join', { code: host.code, name: 'Another name', avatar: '🐱', token: p1.token });
  assert.deepEqual(again, { success: false, error: 'kicked' });
  const other = await connect(host.code);
  const sameName = await ack(other, 'room:join', { code: host.code, name: p1.name, avatar: '🐱', token: newToken() });
  assert.equal(sameName.success, true, 'someone else with the same name can join');
});

test('when every question is used up the game ends gracefully', async () => {
  const ps = await makeRoom(2);
  const [host, p1] = ps;
  host.emit('room:settings', { categories: ['general'], rounds: 30 });
  await sleep(50);
  let trigger = () => host.emit('game:start');
  let end = null;
  const ended = waitFor(host, 'game:end', () => true, 20000).then(d => { end = d; });
  for (let round = 1; round <= 30 && !end; round++) {
    const pickOrEnd = Promise.race([waitFor(host, 'game:pick', () => true, 20000), ended]);
    trigger();
    const p = await pickOrEnd;
    if (end) break;
    const qP = waitFor(host, 'game:question');
    byPid(ps, p.pickerId).emit('game:pickCategory', 'general');
    await qP;
    const vote = await answerAll(ps, [`h${round}`, `p${round}`]);
    const res = waitFor(host, 'game:results');
    const realId = vote.options.find(o => o.text === roomOf(host).question.aE).id;
    for (const s of ps) assert.equal((await ack(s, 'game:vote', realId)).success, true);
    await res;
    trigger = () => host.emit('game:next');
  }
  await ended;
  assert.equal(end.reason, 'no_questions');
  assert.equal(roomOf(host).round, 25);
  assert.equal(roomOf(host).state, 'finished');
  const ranks = end.players.map(p => p.rank);
  assert.ok(ranks.every(r => r >= 1));
  // Play again resets to the lobby with fresh questions.
  const lobby = waitFor(p1, 'room:state', s => s.state === 'lobby');
  host.emit('game:restart');
  await lobby;
  assert.equal(roomOf(host).usedQuestions.size, 0);
});

test('only the host can change settings, start, or go next', async () => {
  const [host, p1] = await makeRoom(2);
  p1.emit('room:settings', { rounds: 1 });
  p1.emit('game:start');
  await sleep(100);
  assert.equal(roomOf(host).settings.rounds, 5);
  assert.equal(roomOf(host).state, 'lobby');
  const st = lastState(p1);
  assert.equal(JSON.stringify(st).includes(host.token), false, 'tokens are never broadcast');
});

test('room codes from POST /api/rooms are unique and valid; unknown codes are not found', async () => {
  const codes = new Set();
  for (let i = 0; i < 20; i++) codes.add(await newCode());
  assert.equal(codes.size, 20);
  for (const c of codes) assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.equal((await fetch(`${URL}/api/rooms`)).status, 404, 'only POST creates codes');

  // A valid code nobody created: same "room not found" as before, for join and resume.
  const unused = [...codes][0];
  const s = await connect(unused.toLowerCase()); // codes are case-insensitive
  assert.deepEqual(await ack(s, 'room:join', { code: unused, name: 'X', avatar: '🐱', token: newToken() }),
    { success: false, error: 'not_found' });
  assert.deepEqual(await ack(s, 'room:resume', { code: unused, token: newToken() }), { success: false, error: 'not_found' });
  // A reserved code can't be handed out twice while its creator is connecting.
  const host = await makePlayer('Host');
  assert.notEqual(host.code, unused);
});

test('invalid room codes are refused at the WebSocket upgrade', async () => {
  const before = game.rooms.size;
  for (const q of ['?room=bad', '?room=ABCD', '?room=ABCDEF', '?room=OOOOO', '?room=AB%20CD', '?room=', '']) {
    await assert.rejects(wsConnect(`${WS_URL}${q}`), /400/, `ws${q}`);
  }
  await assert.rejects(wsConnect(`ws://localhost:${PORT}/other?room=ABCDE`), /400/);
  assert.equal(game.rooms.size, before, 'no room objects are created for bad codes');
});

test('a code in the payload must match the room the connection was opened for', async () => {
  const [a] = await makeRoom(2);
  const [b] = await makeRoom(2);
  const s = await connect(a.code);
  const r = await ack(s, 'room:join', { code: b.code, name: 'Mixed', avatar: '🐱', token: newToken() });
  assert.deepEqual(r, { success: false, error: 'not_found' });
  assert.equal(roomOf(b).players.size, 2);
});

test('two rooms run independently', async () => {
  const A = await makeRoom(2);
  const B = await makeRoom(3);
  assert.notEqual(A[0].code, B[0].code);
  B[0].emit('room:settings', { rounds: 9, lang: 'ar' });
  B[1].emit('chat:send', 'only for room B');
  await sleep(50);
  assert.equal(roomOf(A[0]).settings.rounds, 5);
  assert.equal(roomOf(A[0]).settings.lang, 'en');
  assert.equal(A[0].events.some(e => e.ev === 'chat:msg' && e.data.text === 'only for room B'), false);
  assert.ok(B[2].events.some(e => e.ev === 'chat:msg' && e.data.text === 'only for room B'));

  // Room A plays a round while room B stays in its lobby and hears nothing about it.
  await toQuestion(A, () => A[0].emit('game:start'));
  const vote = await answerAll(A, ['alpha', 'beta']);
  const res = waitFor(A[0], 'game:results');
  const realId = vote.options.find(o => o.text === roomOf(A[0]).question.aE).id;
  for (const s of A) assert.equal((await ack(s, 'game:vote', realId)).success, true);
  await res;
  assert.equal(roomOf(B[0]).state, 'lobby');
  assert.equal(lastState(B[0]).players.length, 3);
  for (const s of B) assert.equal(s.events.some(e => e.ev.startsWith('game:') || e.ev === 'timer:update'), false);
  assert.equal(lastState(A[0]).players.length, 2);
});

test('raw junk frames are ignored, oversized messages close the connection', async () => {
  const [host, p1] = await makeRoom(2);
  for (const junk of ['not json', '[]', '[1,2]', 'null', '42', '"x"', '{}', '{"t":5}', '{"t":"__proto__"}',
    '{"t":"constructor","id":1}', '{"t":"toString","d":{},"id":2}', '{"t":"room:settings","d":{"__proto__":{"polluted":1}}}',
    '{"t":"game:start","id":-1}', '{"t":"game:start","id":"x"}']) {
    p1.raw(junk);
  }
  p1.ws.send(Buffer.from([1, 2, 3])); // binary frames are ignored
  const pong = waitFor(p1, 'pong');
  p1.raw('{"t":"ping"}');
  await pong;
  assert.equal({}.polluted, undefined);
  assert.equal(roomOf(host).state, 'lobby');
  assert.equal(roomOf(host).players.get(p1.pid).connected, true, 'junk does not cost the seat');

  const closed = waitFor(p1, 'close');
  p1.raw(JSON.stringify({ t: 'chat:send', d: 'x'.repeat(5000) }));
  assert.equal(await closed, 1009);
  // The room carries on and the player can come back.
  const back = await connect(host.code);
  const r = await ack(back, 'room:resume', { code: host.code, token: p1.token });
  assert.equal(r.success, true);
});

test('creating a room on a code that is already in use is refused', async () => {
  const [host] = await makeRoom(2);
  const s = await connect(host.code);
  const r = await ack(s, 'room:create', { name: 'Thief', avatar: '🐱', token: newToken(), lang: 'en' });
  assert.deepEqual(r, { success: false, error: 'taken' });
  assert.equal(roomOf(host).hostId, host.pid);
});

test('empty rooms are cleaned up', async () => {
  const [host, p1] = await makeRoom(2);
  const code = host.code;
  assert.ok(game.rooms.has(code));
  await ack(p1, 'room:leave');
  host.disconnect(); p1.disconnect();
  await sleep(GRACE_MS + 300);
  assert.equal(game.rooms.has(code), false, 'room is forgotten once nobody is left');
  // A connection to an unused code leaves nothing behind either.
  const s = await connect(code);
  assert.ok(game.rooms.has(code));
  s.disconnect();
  await sleep(50);
  assert.equal(game.rooms.has(code), false);
});

// ---------- host controls (pause / resume, skip, end game, add rounds) ----------

const HOST_EVENTS = ['host:pause', 'host:resume', 'host:skip', 'host:endGame', 'host:addRounds'];

test('only the host can use the host controls', async () => {
  const ps = await makeRoom(3);
  const [host, p1] = ps;
  // Not in a game yet: nothing to pause or end, even for the host.
  assert.deepEqual(await ack(host, 'host:pause'), { success: false, error: 'phase' });
  assert.deepEqual(await ack(host, 'host:endGame'), { success: false, error: 'phase' });
  assert.deepEqual(await ack(host, 'host:addRounds', 1), { success: false, error: 'phase' });

  await toQuestion(ps, () => host.emit('game:start'));
  const room = roomOf(host);
  for (const ev of HOST_EVENTS) {
    const data = ev === 'host:addRounds' ? 3 : ev === 'host:skip' ? { phase: 'question', round: 1 } : undefined;
    assert.deepEqual(await ack(p1, ev, data), { success: false, error: 'host' }, ev);
  }
  // A connection without a seat can't use them either.
  const stranger = await connect(host.code);
  for (const ev of HOST_EVENTS) assert.deepEqual(await ack(stranger, ev, 1), { success: false, error: 'host' }, ev);
  await sleep(50);
  assert.equal(room.state, 'question');
  assert.equal(room.paused, false);
  assert.equal(room.settings.rounds, 5);
});

test('pause stops the timer for everyone and resume carries on with the time left', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  await waitFor(p1, 'timer:update', d => d.left <= 29);

  const pausedState = waitFor(p2, 'room:state', st => st.paused === true);
  assert.deepEqual(await ack(host, 'host:pause'), { success: true });
  await pausedState;
  const left = roomOf(host).timeLeft;
  assert.deepEqual(await ack(host, 'host:pause'), { success: true }, 'pausing twice is harmless');
  const mark = p1.events.length;
  await sleep(1600);
  assert.equal(roomOf(host).timeLeft, left, 'the clock does not move while paused');
  const ticks = p1.events.slice(mark).filter(e => e.ev === 'timer:update');
  assert.ok(ticks.every(e => e.data.left === left), 'no countdown ticks while paused');

  // Nothing can be answered while paused, and a player who reloads sees the pause and the frozen time.
  assert.deepEqual(await ack(p1, 'game:answer', 'sneaky'), { success: false, error: 'paused' });
  p2.disconnect();
  await sleep(50);
  const back = await connect(host.code);
  const timer = waitFor(back, 'timer:update');
  const st = waitFor(back, 'room:state');
  assert.equal((await ack(back, 'room:resume', { code: host.code, token: p2.token })).success, true);
  assert.equal((await st).paused, true);
  assert.equal((await timer).left, left);
  await sleep(1100);
  assert.equal(roomOf(host).timeLeft, left, 'a reconnect does not restart the clock');

  const resumed = waitFor(p1, 'room:state', s => s.paused === false);
  const nextTick = waitFor(back, 'timer:update', d => d.left === left - 1, 1500);
  assert.deepEqual(await ack(host, 'host:resume'), { success: true });
  await resumed;
  await nextTick;
  assert.deepEqual(await ack(host, 'host:resume'), { success: true }, 'resuming twice is harmless');
  assert.equal((await ack(p1, 'game:answer', 'now it counts')).success, true);
});

test('a round that could move on while paused waits for resume', async () => {
  const ps = await makeRoom(2);
  const [host, p1] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  await ack(host, 'game:answer', 'host bluff');
  await ack(host, 'host:pause');
  // p1 leaves while paused: normally the round would move on right away.
  p1.disconnect();
  await sleep(400);
  assert.equal(roomOf(host).state, 'question', 'still paused on the question');
  const vote = waitFor(host, 'game:vote', () => true, 1500);
  await ack(host, 'host:resume');
  await vote;
});

test('skip moves the current phase on, once per tap', async () => {
  const ps = await makeRoom(3);
  const [host] = ps;
  const pick = waitFor(host, 'game:pick');
  host.emit('game:start');
  await pick;
  const room = roomOf(host);
  assert.deepEqual(await ack(host, 'host:skip', { phase: 'question', round: 1 }), { success: false, error: 'phase' });
  for (const bad of [undefined, null, 'picking', { phase: 'picking' }, { phase: 'picking', round: '1' }]) {
    assert.deepEqual(await ack(host, 'host:skip', bad), { success: false, error: 'phase' });
  }

  const q = waitFor(host, 'game:question');
  assert.deepEqual(await ack(host, 'host:skip', { phase: 'picking', round: 1 }), { success: true });
  await q;
  assert.equal(room.state, 'question', 'a random topic was chosen');

  // A double tap: only the first one counts.
  const vote = waitFor(host, 'game:vote');
  const [a, b] = await Promise.all([
    ack(host, 'host:skip', { phase: 'question', round: 1 }),
    ack(host, 'host:skip', { phase: 'question', round: 1 }),
  ]);
  assert.deepEqual([a.success, b.success], [true, false]);
  await vote;
  assert.equal(room.state, 'voting');

  // Skip also works while paused, and the next phase is not paused.
  await ack(host, 'host:pause');
  const res = waitFor(host, 'game:results');
  assert.deepEqual(await ack(host, 'host:skip', { phase: 'voting', round: 1 }), { success: true });
  await res;
  assert.equal(room.state, 'results');
  assert.equal(room.paused, false);
  assert.equal(lastState(host).paused, false);
  assert.deepEqual(await ack(host, 'host:skip', { phase: 'results', round: 1 }), { success: false, error: 'phase' });
  assert.deepEqual(await ack(host, 'host:pause'), { success: false, error: 'phase' }, 'no timer to pause on the results');
});

test('end game goes straight to the final scores for everyone', async () => {
  const ps = await makeRoom(3);
  const [host, p1] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  await ack(host, 'host:pause');
  const ends = ps.map(s => waitFor(s, 'game:end'));
  assert.deepEqual(await ack(host, 'host:endGame'), { success: true });
  const [end] = await Promise.all(ends);
  assert.equal(end.reason, 'host');
  assert.equal(end.players.length, 3);
  const room = roomOf(host);
  assert.equal(room.state, 'finished');
  assert.equal(room.paused, false);
  assert.equal(room.timer, null);
  assert.deepEqual(await ack(host, 'host:endGame'), { success: false, error: 'phase' }, 'ending twice is refused');
  // "Play again" still works afterwards.
  const lobby = waitFor(p1, 'room:state', s => s.state === 'lobby');
  host.emit('game:restart');
  await lobby;
});

test('add rounds raises the total, within the limit', async () => {
  const ps = await makeRoom(2);
  const [host, p1] = ps;
  host.emit('room:settings', { rounds: 1 });
  await sleep(50);
  await toQuestion(ps, () => host.emit('game:start'));
  for (const bad of [0, -1, 1.5, '3', null, 11, 1e9]) {
    assert.deepEqual(await ack(host, 'host:addRounds', bad), { success: false, error: 'invalid' }, String(bad));
  }
  const st = waitFor(p1, 'room:state', s => s.totalRounds === 2);
  assert.deepEqual(await ack(host, 'host:addRounds', 1), { success: true, rounds: 2 });
  await st;

  // What used to be the last round is not the last one any more.
  const vote = await answerAll(ps, ['b1', 'b2']);
  const res = waitFor(host, 'game:results');
  const realId = vote.options.find(o => o.text === roomOf(host).question.aE).id;
  for (const s of ps) await ack(s, 'game:vote', realId);
  assert.equal((await res).isLast, false);
  const pick = waitFor(host, 'game:pick');
  host.emit('game:next');
  await pick;
  const q = waitFor(host, 'game:question');
  await ack(host, 'host:skip', { phase: 'picking', round: 2 });
  await q;
  const v2 = waitFor(host, 'game:vote');
  await ack(host, 'host:skip', { phase: 'question', round: 2 });
  await v2;
  const res2 = waitFor(host, 'game:results');
  await ack(host, 'host:skip', { phase: 'voting', round: 2 });
  assert.equal((await res2).isLast, true);

  // Adding rounds on the results of the last round turns "Final results" into "Next".
  assert.deepEqual(await ack(host, 'host:addRounds', 3), { success: true, rounds: 5 });
  assert.equal(roomOf(host).lastResults.isLast, false, 'a player who reloads now sees "Next" too');
  assert.equal(roomOf(host).lastResults.totalRounds, 5);

  // Never more than 30 rounds.
  for (let i = 0; i < 3; i++) await ack(host, 'host:addRounds', 10);
  assert.equal(roomOf(host).settings.rounds, 30);
  assert.deepEqual(await ack(host, 'host:addRounds', 1), { success: false, error: 'max' });
});

test('when the host leaves, the new host gets the controls and the old one loses them', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  await ack(host, 'host:pause');
  const handOff = waitFor(p1, 'room:state', st => st.hostId !== host.pid);
  host.disconnect();
  const st = await handOff;
  assert.equal(st.paused, true, 'the room stays paused');
  const nh = byPid(ps, st.hostId);
  const other = [p1, p2].find(s => s !== nh);
  assert.deepEqual(await ack(other, 'host:resume'), { success: false, error: 'host' });

  // The old host comes back as a normal player.
  const back = await connect(host.code);
  assert.equal((await ack(back, 'room:resume', { code: host.code, token: host.token })).success, true);
  assert.deepEqual(await ack(back, 'host:resume'), { success: false, error: 'host' });
  assert.equal(roomOf(nh).paused, true);

  assert.deepEqual(await ack(nh, 'host:resume'), { success: true });
  assert.equal(roomOf(nh).paused, false);
  assert.deepEqual(await ack(nh, 'host:addRounds', 1), { success: true, rounds: 6 });
  const end = waitFor(back, 'game:end');
  assert.deepEqual(await ack(nh, 'host:endGame'), { success: true });
  assert.equal((await end).reason, 'host');
});

test('host controls never show the host any answers before everyone else sees them', async () => {
  const ps = await makeRoom(3);
  const [host, p1, p2] = ps;
  await toQuestion(ps, () => host.emit('game:start'));
  await sleep(50); // let every player get the question first
  const room = roomOf(host);
  const secrets = ['ZEBRA bluff one', 'ZEBRA bluff two', room.question.a, room.question.aE];
  const replies = [];
  const use = async (ev, data) => { const r = await ack(host, ev, data); replies.push(r); return r; };

  const hostMark = host.events.length;
  const p2Mark = p2.events.length;
  await ack(p1, 'game:answer', secrets[0]);
  await ack(p2, 'game:answer', secrets[1]);
  await use('host:pause');
  await use('host:addRounds', 1);
  await use('host:addRounds', 'x'); // refused calls reply too
  await use('host:skip', { phase: 'voting', round: 1 });
  await use('host:resume');
  const voteP = waitFor(host, 'game:vote');
  const voteP2 = waitFor(p2, 'game:vote');
  await use('host:skip', { phase: 'question', round: 1 });
  const vote = await voteP;
  const vote2 = await voteP2;

  // Up to the vote list, nothing the host got mentions any bluff or the real answer.
  const voteIdx = host.events.findIndex((e, i) => i >= hostMark && e.ev === 'game:vote');
  const beforeVote = JSON.stringify(host.events.slice(hostMark, voteIdx)) + JSON.stringify(replies);
  for (const s of secrets) assert.equal(beforeVote.includes(s), false, `host saw "${s}" early`);
  for (const r of replies) assert.deepEqual(Object.keys(r).filter(k => !['success', 'error', 'rounds'].includes(k)), []);
  // The host got exactly the same kinds of messages as another player.
  const kinds = (s, from, to) => s.events.slice(from, to).map(e => e.ev).filter(ev => ev !== 'timer:update');
  const p2VoteIdx = p2.events.findIndex((e, i) => i >= p2Mark && e.ev === 'game:vote');
  assert.deepEqual(kinds(host, hostMark, voteIdx), kinds(p2, p2Mark, p2VoteIdx));

  // The vote list says nothing about who wrote what, for the host or anyone else.
  for (const o of vote.options) assert.deepEqual(Object.keys(o).sort(), ['id', 'own', 'text']);
  assert.deepEqual(vote.options.map(o => o.text), vote2.options.map(o => o.text), 'same list for everyone');
  assert.ok(vote.options.every(o => o.own === false), 'the host wrote nothing this round');

  // While voting, the controls still say nothing about the votes or who wrote what.
  const voteMark = host.events.length;
  replies.length = 0;
  await ack(p1, 'game:vote', vote.options.find(o => o.text !== secrets[0]).id);
  await use('host:pause');
  await use('host:addRounds', 1);
  await use('host:resume');
  const res = waitFor(host, 'game:results');
  await use('host:skip', { phase: 'voting', round: 1 });
  await res;
  const resIdx = host.events.findIndex((e, i) => i >= voteMark && e.ev === 'game:results');
  const duringVote = JSON.stringify(host.events.slice(voteMark, resIdx)) + JSON.stringify(replies);
  for (const word of ['authors', 'voters', 'correct', 'answer"', ...secrets]) {
    assert.equal(duringVote.includes(word), false, `host saw "${word}" during the vote`);
  }
  assert.equal(JSON.stringify(host.events).includes(host.token), false, 'tokens are never sent');
});
