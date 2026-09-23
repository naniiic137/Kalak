'use strict';
// Pure game rules (no sockets, no timers) so they can be unit-tested.
const { QUESTIONS, CATEGORIES } = require('./questions');

const MAX_ANSWER_LEN = 60;
const MAX_NAME_LEN = 15;

const DEFAULT_SETTINGS = Object.freeze({
  categories: ['general'], rounds: 5, answerTime: 30, voteTime: 20, lang: 'ar', maxPlayers: 12,
});
const LIMITS = Object.freeze({
  rounds: [1, 30], answerTime: [10, 120], voteTime: [10, 60], maxPlayers: [2, 50],
});
const LANGS = ['ar', 'en'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Returns a new settings object with only valid values from `input` applied.
 * Unknown keys, wrong types and unknown categories are ignored; numbers are clamped.
 */
function sanitizeSettings(current, input) {
  const next = { ...current, categories: [...current.categories] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return next;
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!has(input, key)) continue;
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    next[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (has(input, 'lang') && LANGS.includes(input.lang)) next.lang = input.lang;
  if (has(input, 'categories') && Array.isArray(input.categories)) {
    const cats = [...new Set(input.categories.filter(c => typeof c === 'string' && CATEGORIES.includes(c)))];
    if (cats.length) next.categories = cats;
  }
  return next;
}

/** Trim, collapse whitespace, strip control chars and cap the length. */
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirty: '30',
  // Arabic, already normalised (no "ال", ة→ه, أ→ا)
  صفر: '0', واحد: '1', واحده: '1', اثنان: '2', اثنين: '2', اثنتان: '2', اثنتين: '2', ثلاثه: '3', ثلاث: '3',
  اربعه: '4', اربع: '4', خمسه: '5', خمس: '5', سته: '6', ست: '6', سبعه: '7', سبع: '7', ثمانيه: '8', ثماني: '8',
  تسعه: '9', تسع: '9', عشره: '10', عشر: '10', ثلاثون: '30', ثلاثين: '30',
};

/**
 * Canonical form used to compare answers: case-, whitespace-, punctuation- and
 * diacritics-insensitive (Latin accents and Arabic harakat), unifies Arabic letter
 * variants and digits, and ignores leading articles ("the", "ال") and number words.
 */
function normalizeAnswer(s) {
  if (typeof s !== 'string') return '';
  const out = s.normalize('NFKD')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\p{M}/gu, '')
    .replace(/\u0640/g, '')
    .replace(/ٱ/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/).filter(Boolean)
    .filter((w, i, arr) => !(i === 0 && arr.length > 1 && ['the', 'a', 'an'].includes(w)))
    .map(w => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w))
    .map(w => NUMBER_WORDS[w] || w)
    .join(' ');
  return out;
}

/** Key used to merge duplicate bluffs. Falls back to the lowercased text for emoji-only answers. */
function answerKey(s) {
  return normalizeAnswer(s) || String(s).trim().toLowerCase();
}

/** All accepted spellings of the real answer (both languages + alternatives). */
function realAnswerKeys(q) {
  const list = [q.a, q.aE, ...(q.alt || []), ...(q.altE || [])];
  return new Set(list.map(normalizeAnswer).filter(Boolean));
}

function isRealAnswer(q, text) {
  const k = normalizeAnswer(text);
  return !!k && realAnswerKeys(q).has(k);
}

/**
 * Merge bluffs that are equal ignoring case/whitespace/diacritics.
 * `answers` is an iterable of [playerId, text]. Returns [{ text, authors: [ids] }].
 * Bluffs equal to the real answer are dropped (defensive; they are rejected on submit).
 */
function groupAnswers(answers, question) {
  const real = question ? realAnswerKeys(question) : new Set();
  const groups = new Map();
  for (const [pid, text] of answers) {
    const key = answerKey(text);
    if (real.has(key)) continue;
    if (!groups.has(key)) groups.set(key, { text, authors: [] });
    groups.get(key).authors.push(pid);
  }
  return [...groups.values()];
}

/**
 * Score one round. `options` = [{ correct, authors }], `votes` = iterable of [voterId, optionIndex].
 * Returns Map<playerId, { correct, fooled, points }> for every id in `playerIds`.
 */
function scoreRound(playerIds, options, votes) {
  const rs = new Map();
  for (const id of playerIds) rs.set(id, { correct: false, fooled: 0, points: 0 });
  for (const [voter, idx] of votes) {
    const opt = options[idx];
    if (!opt) continue;
    if (opt.correct) {
      const r = rs.get(voter);
      if (r) { r.correct = true; r.points += 2; }
    } else {
      for (const author of opt.authors) {
        if (author === voter) continue;
        const r = rs.get(author);
        if (r) { r.fooled++; r.points += 1; }
      }
    }
  }
  return rs;
}

/** Sort by score and give equal scores the same rank (1, 1, 3, ...). */
function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  return sorted.map(p => ({ ...p, rank: 1 + sorted.filter(o => o.score > p.score).length }));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const questionKey = q => q.qE;

function remainingQuestions(used, category) {
  const pool = has(QUESTIONS, category) ? QUESTIONS[category] : null;
  if (!Array.isArray(pool)) return [];
  return pool.filter(q => !used.has(questionKey(q)));
}

/** Enabled categories that still have unused questions. */
function availableCategories(used, categories) {
  return categories.filter(c => remainingQuestions(used, c).length > 0);
}

/**
 * Pick an unused question, preferring `category`, then any other enabled category.
 * Iterative; returns null when every enabled category is used up. Marks the question as used.
 */
function pickQuestion(used, categories, category) {
  const order = [category, ...shuffle(categories.filter(c => c !== category))];
  for (const c of order) {
    const avail = remainingQuestions(used, c);
    if (!avail.length) continue;
    const q = avail[Math.floor(Math.random() * avail.length)];
    used.add(questionKey(q));
    return { ...q, category: c };
  }
  return null;
}

module.exports = {
  MAX_ANSWER_LEN, MAX_NAME_LEN, DEFAULT_SETTINGS, LIMITS, LANGS,
  sanitizeSettings, cleanText, normalizeAnswer, answerKey, isRealAnswer, groupAnswers,
  scoreRound, rankPlayers, shuffle, availableCategories, pickQuestion, remainingQuestions,
};
