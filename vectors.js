// ===== Semantic vector index over the tree-sitter symbol graph =====
// Turns each codegraph `def` into a 384-d embedding (local fastembed / BGE-small,
// offline, zero per-token cost) so a natural-language prompt can find the right
// symbols even when its words never appear in the code ("timezone bug" -> matches
// formatUnixDate). This is the retrieval layer that lets the pipeline SKIP the
// agentic grep/read loop: query here deterministically, then make ONE LLM call.
//
// On-disk format (.loveai/index/vectors.json):
//   { v, built, model, dim, ids:[defId...], vecs:<base64 of Float32Array N*dim> }
//
// Everything degrades gracefully: if the native runtime or model is unavailable,
// init returns null and callers fall back to the existing BM25 `retrieve()`.

const fs = require('fs');
const path = require('path');

const MODEL_NAME = 'BGESmallENV15';
const DIM = 384;
const SCHEMA = 1;

let _embedderPromise = null;   // singleton init (model load is expensive)
let _embedderBroken = false;

// lazy, cached embedder. Returns null (never throws) when unavailable so the
// caller can fall back to lexical retrieval.
async function getEmbedder() {
  if (_embedderBroken) return null;
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    const { FlagEmbedding, EmbeddingModel } = require('fastembed');
    return FlagEmbedding.init({
      model: EmbeddingModel[MODEL_NAME],
      // symbol docs are short (~100 tokens); 256 is ample and ~3x faster than 512
      // (48min -> ~16min for a 17k-symbol monorepo), with no truncation.
      maxLength: 256,
    });
  })().catch((e) => {
    _embedderBroken = true;
    _embedderPromise = null;
    console.error('[vectors] embedder init failed:', e && e.message);
    return null;
  });
  return _embedderPromise;
}

// the text we embed for one symbol def — file + parent + name + kind + doc.
// Short by design; the model truncates at 512 tokens anyway.
function defDoc(d) {
  const where = d.parent ? `${d.parent}.${d.name}` : d.name;
  const doc = (d.doc || '').replace(/\s+/g, ' ').slice(0, 240);
  return `${d.rel} :: ${where} (${d.type})${doc ? ' — ' + doc : ''}`;
}

function indexPath(dir) {
  return path.join(dir, 'vectors.json');
}

// pack an array of Float32Array rows into one base64 blob
function packVecs(rows) {
  const flat = new Float32Array(rows.length * DIM);
  for (let i = 0; i < rows.length; i++) flat.set(rows[i], i * DIM);
  return Buffer.from(flat.buffer).toString('base64');
}

function unpackVecs(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// embed many docs in batches; returns Float32Array[] aligned to `docs`
async function embedDocs(emb, docs, onProgress) {
  const rows = [];
  const BATCH = 64;
  for await (const batch of emb.passageEmbed(docs, BATCH)) {
    for (const v of batch) rows.push(v);
    if (onProgress) onProgress(rows.length, docs.length);
  }
  return rows;
}

// Build (or rebuild) the vector index from an in-memory graph. Writes to disk and
// returns { ok, count } — or { ok:false } when the embedder is unavailable.
async function buildVectorIndex(dir, graph, onProgress) {
  const emb = await getEmbedder();
  if (!emb || !graph || !graph.defs || !graph.defs.length) return { ok: false };
  const defs = graph.defs;
  const ids = defs.map((d) => d.id);
  const docs = defs.map(defDoc);
  const rows = await embedDocs(emb, docs, onProgress);
  const out = {
    v: SCHEMA, built: Date.now(), model: MODEL_NAME, dim: DIM,
    ids, vecs: packVecs(rows),
  };
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(indexPath(dir), JSON.stringify(out), 'utf8');
  _cache.dir = null;   // invalidate in-memory cache
  return { ok: true, count: ids.length };
}

// Incrementally re-embed just the changed files' symbols into an existing index.
// `rels` is the set of files whose defs changed/were removed. Rows for those files
// are dropped and re-embedded from the current graph (a deleted file simply has no
// defs left, so its rows vanish). Rewrites the index. Returns { ok, count }.
async function syncFilesVectors(dir, graph, rels) {
  const idx = loadIndex(dir);
  if (!idx) return { ok: false };          // no base index yet → caller does a full build
  const emb = await getEmbedder();
  if (!emb) return { ok: false };
  const touched = new Set(rels);
  const relOf = (id) => id.slice(0, id.lastIndexOf('#'));
  const ids = [], rows = [];
  for (let i = 0; i < idx.ids.length; i++) {
    if (touched.has(relOf(idx.ids[i]))) continue;         // drop stale rows for these files
    ids.push(idx.ids[i]);
    rows.push(idx.vecs.subarray(i * DIM, (i + 1) * DIM));
  }
  const fresh = (graph.defs || []).filter((d) => touched.has(d.rel));
  if (fresh.length) {
    const embedded = await embedDocs(emb, fresh.map(defDoc));
    for (let i = 0; i < fresh.length; i++) { ids.push(fresh[i].id); rows.push(embedded[i]); }
  }
  const out = {
    v: SCHEMA, built: Date.now(), model: MODEL_NAME, dim: DIM,
    ids, vecs: packVecs(rows),
  };
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(indexPath(dir), JSON.stringify(out), 'utf8');
  _cache.dir = null;
  return { ok: true, count: ids.length };
}

// in-memory cache of the decoded index (one project at a time is the common case)
const _cache = { dir: null, ids: null, vecs: null };

function loadIndex(dir) {
  if (_cache.dir === dir) return _cache;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); } catch { return null; }
  if (!raw || raw.v !== SCHEMA || raw.dim !== DIM || !raw.ids) return null;
  _cache.dir = dir;
  _cache.ids = raw.ids;
  _cache.vecs = unpackVecs(raw.vecs);
  return _cache;
}

function hasVectorIndex(dir) {
  try { return fs.existsSync(indexPath(dir)); } catch { return false; }
}

// drop the decoded in-memory copy so the next query re-reads from disk. The main
// process must call this after a worker thread rewrites vectors.json, or its
// queries would keep using the pre-build vectors.
function invalidateCache() { _cache.dir = null; _cache.ids = null; _cache.vecs = null; }

// cosine of query row vs stored row i (query is pre-normalized enough; we normalize both)
function cosineAt(vecs, i, q) {
  let dot = 0, nb = 0;
  const off = i * DIM;
  for (let k = 0; k < DIM; k++) { const b = vecs[off + k]; dot += q[k] * b; nb += b * b; }
  return dot / (Math.sqrt(nb) || 1);
}

// Query the index with a natural-language prompt. Returns top-k
// [{ id, score }] over ALL symbols — pure local math, no LLM, <10ms at repo scale.
async function queryVectors(dir, prompt, k = 30) {
  const idx = loadIndex(dir);
  if (!idx) return null;
  const emb = await getEmbedder();
  if (!emb) return null;
  const q = await emb.queryEmbed(String(prompt || ''));
  let nq = 0;
  for (let i = 0; i < DIM; i++) nq += q[i] * q[i];
  nq = Math.sqrt(nq) || 1;
  const n = idx.ids.length;
  const scored = new Array(n);
  for (let i = 0; i < n; i++) scored[i] = { id: idx.ids[i], score: cosineAt(idx.vecs, i, q) / nq };
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

module.exports = {
  MODEL_NAME, DIM,
  getEmbedder, buildVectorIndex, syncFilesVectors, queryVectors,
  hasVectorIndex, invalidateCache, defDoc,
};
