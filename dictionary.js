// ============================================================
// dictionary.js — global word-list store + self-updating engine
// ============================================================
// A tiny, dependency-free "light DB" for the app's word lists (stop-words,
// generic tokens). It replaces the hardcoded `new Set([...])` literals that
// were scattered across renderer/app.js and main.js. Two goals:
//
//   1. ONE global source of truth, NOT per project. The file lives in Electron's
//      userData dir (like auth.js's session.bin), so every project opened in the
//      app shares — and grows — the same vocabulary.
//   2. It does not go stale. A learning pass counts words as they stream through
//      real requests and promotes recurring conversational filler into the stop
//      list automatically, with guardrails so a genuine code keyword (`diff`,
//      `useEditorViewModel`, `git.store.ts`) can NEVER be promoted and silently
//      wreck BM25 / vector retrieval.
//
// Storage is a single JSON file; there is no SQLite/native dependency on purpose
// — that would be the opposite of "light" in an Electron build.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- SEEDS: the ORIGINAL hardcoded lists, now just the built-in defaults ----
// First run writes these to disk; behaviour is identical to the old constants
// until the engine learns something new. Keep these in sync with the docs, not
// with the code — the code now READS them from here.
const SEEDS = {
  // renderer/app.js localIntentQuery — filler stripped from the RAG query
  intent: [
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
    'its', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he',
    'she', 'me', 'my', 'your', 'our', 'and', 'or', 'but', 'if', 'then', 'else',
    'so', 'because', 'as', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with',
    'without', 'by', 'into', 'onto', 'over', 'under', 'off', 'out', 'up', 'down',
    'here', 'there', 'where', 'when', 'how', 'what', 'which', 'who', 'why',
    'again', 'also', 'just', 'only', 'very', 'really', 'still', 'not', 'no',
    'yes', 'do', 'does', 'did', 'done', 'can', 'could', 'should', 'would',
    'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'get', 'got',
    'see', 'look', 'looking', 'want', 'need', 'make', 'made', 'use', 'using',
    'please', 'fucking', 'shit', 'thing', 'stuff', 'etc', 'example', 'another',
    'some', 'any', 'all', 'each', 'both', 'more', 'most', 'than', 'about',
    'like', 'okay', 'ok', 'now', 'them', 'they', 'their', 'view', 'read',
    'open', 'attached', 'file', 'files', 'disk'
  ],
  // renderer/app.js learnUiWords — words too generic to signal UI/UX work
  ui: [
    'this', 'that', 'with', 'from', 'make', 'have', 'should', 'when', 'then',
    'file', 'files', 'code', 'please', 'update', 'change', 'need', 'want',
    'like', 'also', 'more', 'less', 'very', 'just', 'will', 'must', 'them',
    'they', 'what', 'where', 'agent', 'task'
  ],
  // main.js tokenize() — BM25 stop-words for lexical retrieval
  retrieval: [
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'then',
    'not', 'but', 'you', 'are', 'was', 'will', 'add', 'fix', 'use', 'get',
    'set', 'new', 'now', 'has', 'have', 'should', 'need', 'want', 'make',
    'change', 'update', 'issue', 'bug', 'feature', 'file', 'code', 'function',
    'const', 'let', 'var', 'return', 'import', 'export'
  ],
  // main.js repoMapFromIndex blurbs — tokens too common to describe a dir
  generic: [
    'index', 'main', 'app', 'src', 'lib', 'data', 'item', 'value', 'list',
    'key', 'val', 'obj', 'props', 'params', 'err', 'res', 'req', 'str', 'num',
    'tmp', 'util', 'utils', 'test', 'spec', 'page', 'node', 'module',
    'default', 'string', 'number', 'object', 'options', 'config', 'result'
  ]
};

// Categories whose lists feed retrieval RANKING. Migrated to the store for
// central curation but auto-promotion stays OFF: a wrong promotion here would
// degrade BM25 for everyone, so those lists change only by hand (CLI / reset).
const LEARN_ENABLED = new Set(['intent', 'ui']);

// A candidate word must recur across at least this many distinct requests
// before it is promoted into the live stop list.
const PROMOTE_AT = 4;
// Hard cap on learned words per category — a bad run can never bloat the file.
const MAX_LEARNED = 300;
const MIN_LEN = 3;
const MAX_LEN = 16;

// Words that LOOK like plain English but are real code/domain vocabulary. Even
// if one of these recurs, it is never promoted — dropping it would blind search
// to the very thing the user is asking about.
const PROTECTED = new Set([
  'diff', 'edit', 'edits', 'editor', 'view', 'model', 'store', 'state', 'hook',
  'hooks', 'panel', 'feed', 'session', 'prompt', 'query', 'index', 'vector',
  'symbol', 'graph', 'commit', 'branch', 'merge', 'token', 'cache', 'config',
  'route', 'router', 'api', 'auth', 'error', 'build', 'test', 'render', 'click',
  'hover', 'scroll', 'drag', 'focus', 'screen', 'button', 'modal', 'dialog',
  'sidebar', 'navbar', 'theme', 'style', 'layout', 'agent', 'plan', 'ticket',
  'terminal', 'browser', 'window', 'component', 'service', 'worker', 'process'
]);

const FILE_VERSION = 1;
const FILE_NAME = 'loveai-dictionary.json';

let storeDir = null;      // resolved lazily (userData, or a temp dir off-Electron)
let filePath = null;
let data = null;          // { version, categories: { cat: { learned: {w:count} } } }
let liveSets = null;      // { cat: Set } — seed ∪ promoted, mutated in place
let saveTimer = null;

// Resolve the global store directory. Prefers Electron userData so the file is
// shared across every project; falls back to a temp dir when required outside
// Electron (CLI, tests) so the module stays loadable and testable anywhere.
function resolveDir() {
  if (storeDir) return storeDir;
  try {
    storeDir = require('electron').app.getPath('userData');
  } catch {
    storeDir = path.join(os.tmpdir(), 'loveai');
  }
  return storeDir;
}

// Load the JSON file into memory once, seeding a fresh file on first run. Safe
// to call repeatedly — later calls are a no-op. Bad/corrupt JSON degrades to
// seeds rather than throwing, so the app never fails to start over this file.
function ensureLoaded() {
  if (data) return;
  const dir = init.dirOverride || resolveDir();
  filePath = path.join(dir, FILE_NAME);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && parsed.categories) data = parsed;
  } catch { /* missing or corrupt — seed below */ }
  if (!data) {
    data = { version: FILE_VERSION, categories: {} };
    for (const cat of Object.keys(SEEDS)) data.categories[cat] = { learned: {} };
    persistNow();
  }
  // build the live sets: seed words plus any already-promoted learned words
  liveSets = {};
  for (const cat of Object.keys(SEEDS)) {
    const set = new Set(SEEDS[cat]);
    const learned = (data.categories[cat] && data.categories[cat].learned) || {};
    for (const [w, c] of Object.entries(learned)) if (c >= PROMOTE_AT) set.add(w);
    liveSets[cat] = set;
  }
}

// Explicit init (called from main once userData is known) — lets a caller pin
// the directory. Passing a dir also resets any temp-dir guess made earlier.
function init(dir) {
  if (dir) { init.dirOverride = dir; data = null; liveSets = null; storeDir = dir; }
  ensureLoaded();
  return filePath;
}
init.dirOverride = null;

function persistNow() {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch { /* best-effort; the in-memory copy stays authoritative */ }
}

// Debounced write — learning fires on every request, so batch the disk hits.
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 1500);
  if (saveTimer.unref) saveTimer.unref();   // never hold the process open
}

// The live stop-word Set for a category (seed ∪ promoted). Returns the SAME
// reference across calls, and promotions mutate it in place, so a consumer can
// hold the reference once (e.g. main.js's tokenizer) and see later additions.
function liveSet(category) {
  ensureLoaded();
  return liveSets[category] || new Set();
}

// A word is a stop-word for this category.
function isStop(category, word) {
  return liveSet(category).has(String(word).toLowerCase());
}

// Only pure lowercase-letter words in a sane length band, that aren't already
// known and aren't protected code vocabulary, can ever be learned. This filter
// is what stops `useEditorViewModel`, `git.store.ts`, `v2`, or `diff` from
// being counted, let alone promoted.
function eligible(category, word) {
  if (word.length < MIN_LEN || word.length > MAX_LEN) return false;
  if (!/^[a-z]+$/.test(word)) return false;
  if (PROTECTED.has(word)) return false;
  if (new Set(SEEDS[category]).has(word)) return false;
  return true;
}

// Learn from one request's worth of tokens. Each distinct eligible token gets
// its cross-request count bumped once; crossing PROMOTE_AT adds it to the live
// stop list. Returns the words promoted by THIS call (usually none).
function learn(category, tokens) {
  ensureLoaded();
  if (!LEARN_ENABLED.has(category)) return [];
  const bucket = data.categories[category] || (data.categories[category] = { learned: {} });
  const learned = bucket.learned;
  const promoted = [];
  const seen = new Set();
  for (let tok of tokens || []) {
    tok = String(tok).toLowerCase();
    if (seen.has(tok) || !eligible(category, tok)) continue;
    seen.add(tok);
    if (liveSets[category].has(tok)) continue;   // already promoted
    learned[tok] = (learned[tok] || 0) + 1;
    if (learned[tok] >= PROMOTE_AT) {
      liveSets[category].add(tok);
      promoted.push(tok);
    }
  }
  if (seen.size) {
    enforceCap(category);
    persistSoon();
  }
  return promoted;
}

// Keep each category's learned map bounded: when it overflows, drop the
// lowest-count (least-established) words first. Promoted words survive by count.
function enforceCap(category) {
  const learned = data.categories[category].learned;
  const keys = Object.keys(learned);
  if (keys.length <= MAX_LEARNED) return;
  keys.sort((a, b) => learned[a] - learned[b]);
  for (const k of keys.slice(0, keys.length - MAX_LEARNED)) {
    delete learned[k];
    // demote if it was below the promotion bar anyway; promoted words are kept
    if (!SEEDS[category].includes(k)) liveSets[category].delete(k);
  }
}

// Full active list for a category (seed ∪ promoted), sorted — for the renderer
// to hydrate its in-memory Set, and for the CLI to print.
function words(category) {
  return [...liveSet(category)].sort();
}

// Introspection for the CLI / status UI: counts + pending candidates (words
// seen but not yet promoted), so a human can see what the engine is learning.
function stats(category) {
  ensureLoaded();
  const bucket = data.categories[category] || { learned: {} };
  const active = words(category);
  const seedSize = SEEDS[category] ? new Set(SEEDS[category]).size : 0;
  const candidates = Object.entries(bucket.learned)
    .filter(([w, c]) => c < PROMOTE_AT && !liveSets[category].has(w))
    .sort((a, b) => b[1] - a[1])
    .map(([w, c]) => ({ word: w, count: c, needs: PROMOTE_AT - c }));
  return {
    category,
    seedCount: seedSize,
    learnedCount: active.length - seedSize,
    learnEnabled: LEARN_ENABLED.has(category),
    activeCount: active.length,
    candidates,
    file: filePath
  };
}

// Manual curation (CLI / API). add: force a word into the live list + learned
// map at/above the promotion bar. remove: delete a learned word (seeds cannot
// be removed — they are the code's baseline). reset: wipe learned, back to seed.
function add(category, word) {
  ensureLoaded();
  const w = String(word).toLowerCase().trim();
  if (!w || !SEEDS[category]) return false;
  data.categories[category] || (data.categories[category] = { learned: {} });
  data.categories[category].learned[w] = Math.max(
    PROMOTE_AT, data.categories[category].learned[w] || 0);
  liveSets[category].add(w);
  persistNow();
  return true;
}

function remove(category, word) {
  ensureLoaded();
  const w = String(word).toLowerCase().trim();
  if (!data.categories[category]) return false;
  const wasLearned = w in data.categories[category].learned;
  delete data.categories[category].learned[w];
  if (!SEEDS[category].includes(w)) liveSets[category].delete(w);
  persistNow();
  return wasLearned;
}

function reset(category) {
  ensureLoaded();
  if (category) {
    if (!SEEDS[category]) return false;
    data.categories[category] = { learned: {} };
    liveSets[category] = new Set(SEEDS[category]);
  } else {
    for (const cat of Object.keys(SEEDS)) {
      data.categories[cat] = { learned: {} };
      liveSets[cat] = new Set(SEEDS[cat]);
    }
  }
  persistNow();
  return true;
}

module.exports = {
  init, liveSet, isStop, learn, words, stats, add, remove, reset,
  categories: () => Object.keys(SEEDS),
  SEEDS, PROMOTE_AT
};
