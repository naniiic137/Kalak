'use strict';
// End-to-end tests: a real server on a test port, driven by socket.io-client.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { io: ioc } = require('socket.io-client');
const { createGameServer } = require('../server');

const PORT = Number(process.env.KALAK_TEST_PORT) || 3609;
const URL = `http://localhost:${PORT}`;
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

function connect() {
  const s = ioc(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.add(s);
  s.events = [];
  s.onAny((ev, data) => s.events.push({ ev, data }));
  return new Promise((resolve, reject) => { s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
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
  const s = await connect();
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

const roomOf = s => game.rooms.get(s.code);
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
    'game:answer', 'game:vote', 'game:next', 'game:restart', 'chat:send', 'debug:getAnswers', 'debug:skip']) {
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

  const back = await connect();
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
  const viaJoin = await connect();
  const j = await ack(viaJoin, 'room:join', { code: host.code, name: 'Whatever', avatar: '🐱', token: p2.token });
  assert.equal(j.success, true);
  assert.equal(j.playerId, p2.pid);
  await sleep(50);
  assert.ok(back.events.some(e => e.ev === 'session:replaced'), 'older tab is told it was replaced');
  assert.equal(roomOf(host).players.size, 3);

  // A different browser still can't join a running game.
  const stranger = await connect();
  const s = await ack(stranger, 'room:join', { code: host.code, name: 'New', avatar: '🐱', token: newToken() });
  assert.deepEqual(s, { success: false, error: 'started' });
});

test('reloading in the lobby leaves no ghost and does not use up a slot', async () => {
  const [host, p1] = await makeRoom(2);
  host.emit('room:settings', { maxPlayers: 2 });
  await sleep(50);
  p1.disconnect();
  await sleep(50);
  const back = await connect();
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
  const back = await connect();
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
  const s = await connect();
  const again = await ack(s, 'room:join', { code: host.code, name: 'Another name', avatar: '🐱', token: p1.token });
  assert.deepEqual(again, { success: false, error: 'kicked' });
  const other = await connect();
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
