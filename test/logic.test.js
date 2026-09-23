'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/logic');
const { QUESTIONS, CATEGORIES } = require('../lib/questions');

test('sanitizeSettings ignores empty or unknown categories', () => {
  const base = L.DEFAULT_SETTINGS;
  assert.deepEqual(L.sanitizeSettings(base, { categories: [] }).categories, ['general']);
  assert.deepEqual(L.sanitizeSettings(base, { categories: ['nope', 42, null] }).categories, ['general']);
  assert.deepEqual(L.sanitizeSettings(base, { categories: 'science' }).categories, ['general']);
  assert.deepEqual(L.sanitizeSettings(base, { categories: ['science', 'nope', 'science', 'flags'] }).categories, ['science', 'flags']);
  assert.deepEqual(L.sanitizeSettings(base, { categories: ['__proto__', 'constructor', 'toString'] }).categories, ['general']);
});

test('sanitizeSettings clamps numbers and ignores bad types and unknown keys', () => {
  const s = L.sanitizeSettings(L.DEFAULT_SETTINGS, {
    rounds: 1e9, answerTime: -5, voteTime: 12.6, maxPlayers: NaN, lang: 'fr', foo: 1, hostId: 'x',
  });
  assert.equal(s.rounds, 30);
  assert.equal(s.answerTime, 10);
  assert.equal(s.voteTime, 13);
  assert.equal(s.maxPlayers, 12);
  assert.equal(s.lang, 'ar');
  assert.equal('foo' in s, false);
  assert.equal('hostId' in s, false);
  assert.equal(L.sanitizeSettings(L.DEFAULT_SETTINGS, { rounds: '7' }).rounds, 5);
  assert.equal(L.sanitizeSettings(L.DEFAULT_SETTINGS, { lang: 'en' }).lang, 'en');
  assert.deepEqual(L.sanitizeSettings(L.DEFAULT_SETTINGS, null), { ...L.DEFAULT_SETTINGS, categories: ['general'] });
  assert.deepEqual(L.sanitizeSettings(L.DEFAULT_SETTINGS, [1, 2]), { ...L.DEFAULT_SETTINGS, categories: ['general'] });
});

test('pickQuestion is iterative, falls back to other categories and returns null when all are used', () => {
  const used = new Set();
  const seen = new Set();
  const cats = ['general', 'flags'];
  let q;
  let n = 0;
  while ((q = L.pickQuestion(used, cats, 'general'))) {
    assert.ok(cats.includes(q.category));
    assert.equal(seen.has(q.qE), false, 'no question is asked twice');
    seen.add(q.qE);
    n++;
  }
  assert.equal(n, QUESTIONS.general.length + QUESTIONS.flags.length);
  assert.deepEqual(L.availableCategories(used, cats), []);
  assert.equal(L.pickQuestion(new Set(), [], 'nope'), null);
  assert.equal(L.pickQuestion(new Set(), ['nope'], 'nope'), null);
});

test('normalizeAnswer ignores case, spacing, punctuation, diacritics and articles', () => {
  const same = (a, b) => assert.equal(L.normalizeAnswer(a), L.normalizeAnswer(b), `${a} vs ${b}`);
  same('Fake A', 'fake a');
  same('  FAKE   a ', 'Fake A.');
  same('Fäke Á', 'fake a');
  same('الفَهْد', 'فهد');
  same('أربعة', '4');
  same('٤', '4');
  same('The Nile', 'nile');
  same('Seven', '7');
  assert.notEqual(L.normalizeAnswer('Fake A'), L.normalizeAnswer('Fake B'));
});

test('groupAnswers merges duplicates and credits every author', () => {
  const q = { a: 'الفهد', aE: 'Cheetah' };
  const groups = L.groupAnswers([['p1', 'Fake A'], ['p2', 'fake  a'], ['p3', 'Other'], ['p4', 'cheetah']], q);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { text: 'Fake A', authors: ['p1', 'p2'] });
  assert.deepEqual(groups[1], { text: 'Other', authors: ['p3'] });
});

test('isRealAnswer accepts both languages and listed alternatives', () => {
  const football = QUESTIONS.general.find(q => q.aE === 'Football');
  assert.ok(football, 'football question exists with a clean answer');
  assert.ok(L.isRealAnswer(football, 'soccer'));
  assert.ok(L.isRealAnswer(football, 'FOOTBALL'));
  assert.ok(L.isRealAnswer(football, 'كرة القدم'));
  assert.equal(L.isRealAnswer(football, 'Basketball'), false);
});

test('scoreRound: +2 for the truth, +1 per fooled player to every author, nothing for yourself', () => {
  const options = [
    { correct: true, authors: [] },
    { correct: false, authors: ['a', 'b'] },
    { correct: false, authors: ['c'] },
  ];
  const rs = L.scoreRound(['a', 'b', 'c'], options, [['a', 0], ['b', 2], ['c', 1]]);
  assert.deepEqual(rs.get('a'), { correct: true, fooled: 1, points: 3 });
  assert.deepEqual(rs.get('b'), { correct: false, fooled: 1, points: 1 });
  assert.deepEqual(rs.get('c'), { correct: false, fooled: 1, points: 1 });
  const self = L.scoreRound(['a'], options, [['a', 1]]);
  assert.equal(self.get('a').points, 0);
});

test('rankPlayers gives tied scores the same rank', () => {
  const r = L.rankPlayers([{ id: 'a', score: 3 }, { id: 'b', score: 5 }, { id: 'c', score: 5 }, { id: 'd', score: 1 }]);
  assert.deepEqual(r.map(p => [p.id, p.rank]), [['b', 1], ['c', 1], ['a', 3], ['d', 4]]);
});

test('cleanText trims, collapses whitespace, strips control characters and caps length', () => {
  assert.equal(L.cleanText('  a \n\t b  ', 60), 'a b');
  assert.equal(L.cleanText('x'.repeat(100), 60).length, 60);
  assert.equal(L.cleanText('\u202eevil', 60), 'evil');
  assert.equal(L.cleanText({}, 60), '');
});

test('question bank: one clean answer per question in each language', () => {
  assert.equal(CATEGORIES.length, 13);
  const alternatives = /[\p{L}]{3,}\s*\/\s*[\p{L}]{3,}/u; // "Football/Soccer" style
  for (const c of CATEGORIES) {
    for (const q of QUESTIONS[c]) {
      for (const k of ['q', 'a', 'qE', 'aE']) assert.equal(typeof q[k], 'string', `${c}: ${q.qE} ${k}`);
      for (const ans of [q.a, q.aE]) {
        assert.equal(alternatives.test(ans), false, `"${ans}" lists alternatives`);
        assert.equal(/[()]/.test(ans), false, `"${ans}" has a parenthesised hint`);
        assert.ok(ans.length <= L.MAX_ANSWER_LEN, `"${ans}" too long`);
      }
      for (const k of ['alt', 'altE']) if (k in q) assert.ok(Array.isArray(q[k]) && q[k].every(x => typeof x === 'string'));
    }
  }
});
