// ===== Semantic vector index over the tree-sitter symbol graph =====
// Turns each codegraph `def` into a 384-d embedding (local fastembed / BGE-small,
// offline, zero per-token cost) so a natural-language prompt can find the right
// symbols even when its words never appear in the code ("timezone bug" -> matches
// formatUnixDate). This is the retrieval layer that lets the pipeline SKIP the
// agentic grep/read loop: query here deterministically, then make ONE LLM call.
//
// On-disk format (v2): .loveai/index/vectors.json holds the metadata
//   { v, built, model, dim, ids:[defId...], hashes:[docHash...] }
// and vectors.bin holds the raw Float32Array (N*dim) — a binary sidecar
// instead of the old v1 base64-in-JSON blob, which forced a ~35MB stringify
// + rewrite per watcher sync at 17k-symbol scale. v1 files remain READABLE
// (legacy branch in loadIndex); writes always produce v2.
//
// RESUME: long embedding builds checkpoint to vectors.partial.{json,bin}
// every ~1000 symbols. A later build (after the app closed mid-build, or a
// manual rebuild) reuses every row whose id AND doc-hash still match —
// same doc + same model ⇒ identical embedding — and embeds only the rest.
// The checkpoint is deleted on successful completion.
//
// Everything degrades gracefully: if the native runtime or model is unavailable,
// init returns null and callers fall back to the existing BM25 `retrieve()`.

const fs = require('fs');
const path = require('path');

const MODEL_NAME = 'BGESmallENV15';
const MODEL_FOLDER = 'fast-bge-small-en-v1.5';   // on-disk name fastembed uses
const MODEL_FILE = 'model_optimized.onnx';
const DIM = 384;
const SCHEMA = 2;   // 2 = binary sidecar (vectors.bin); 1 = legacy base64 JSON

let _embedderPromise = null;   // singleton init (model load is expensive)
let _embedderBroken = false;
let _embedderError = '';       // last init failure reason, surfaced to the UI
let _modelDirOverride = '';    // main process passes the resolved dir to the worker

// main.js (which knows app.isPackaged / resourcesPath) tells the worker exactly
// where the bundled model lives; keeps us off cwd-relative guessing.
function setModelDir(dir) { _modelDirOverride = dir || ''; }

// Resolve the ABSOLUTE dir holding model_optimized.onnx. Must never depend on
// process.cwd(): in dev cwd is the repo root, but in the packaged app it is the
// install dir, where fastembed's default "local_cache" would be missing and it
// would try to DOWNLOAD the model (slow/offline-broken). We ship the model and
// point straight at it.
function resolveModelDir() {
  const candidates = [
    _modelDirOverride,
    path.join(__dirname, 'local_cache', MODEL_FOLDER),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'local_cache', MODEL_FOLDER)
      : '',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, MODEL_FILE))) return c; } catch {}
  }
  return null;
}

// lazy, cached embedder. Returns null (never throws) when unavailable so the
// caller can fall back to lexical retrieval.
async function getEmbedder() {
  if (_embedderBroken) return null;
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    const { FlagEmbedding, EmbeddingModel } = require('fastembed');
    const dir = resolveModelDir();
    if (!dir) {
      throw new Error(
        `embedding model not found (local_cache/${MODEL_FOLDER}/${MODEL_FILE})`);
    }
    // CUSTOM + modelAbsoluteDirPath loads the local .onnx directly and SKIPS the
    // network download path entirely. Embeddings are identical to the named
    // BGESmallENV15 path (same onnx, same passage:/query: prefixes, same tokenizer).
    return FlagEmbedding.init({
      model: EmbeddingModel.CUSTOM,
      modelAbsoluteDirPath: dir,
      modelName: MODEL_FILE,
      // symbol docs are short (~100 tokens); 256 is ample and ~3x faster than 512
      // (48min -> ~16min for a 17k-symbol monorepo), with no truncation.
      maxLength: 256,
    });
  })().catch((e) => {
    _embedderBroken = true;
    _embedderPromise = null;
    _embedderError = (e && e.message) ? String(e.message) : String(e);
    console.error('[vectors] embedder init failed:', _embedderError);
    return null;
  });
  return _embedderPromise;
}

// the text we embed for one symbol def — file + parent + name + kind + doc,
// plus what it CALLS: a symbol with no leading comment would otherwise be
// represented by its name alone (pure fuzzy name-match, which BM25 already
// does); the callee names carry real body vocabulary for semantic recall.
// Short by design; the model truncates at maxLength anyway.
function defDoc(d) {
  const where = d.parent ? `${d.parent}.${d.name}` : d.name;
  const doc = (d.doc || '').replace(/\s+/g, ' ').slice(0, 240);
  const calls = (d.calls || []).slice(0, 8).join(' ');
  return `${d.rel} :: ${where} (${d.type})${doc ? ' — ' + doc : ''}` +
    (calls ? ` | calls: ${calls}` : '');
}

function indexPath(dir) {
  return path.join(dir, 'vectors.json');
}
function binPath(dir) {
  return path.join(dir, 'vectors.bin');
}
function partialJsonPath(dir) {
  return path.join(dir, 'vectors.partial.json');
}
function partialBinPath(dir) {
  return path.join(dir, 'vectors.partial.bin');
}

// tiny 32-bit FNV-1a over the doc text — validates a stored row still matches
// the CURRENT doc before reuse (the file may have changed while the app was
// closed). Same doc + same model ⇒ identical embedding, so reuse is lossless.
function docHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// read one {json,bin} pair into id → { row, hash } entries (hash-carrying v2
// only; sizes must agree — a torn write from a crash mid-checkpoint is skipped)
function collectRows(out, jsonPath, binFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!raw || raw.v !== SCHEMA || raw.dim !== DIM) return;
    if (!Array.isArray(raw.ids) || !Array.isArray(raw.hashes)) return;
    if (raw.hashes.length !== raw.ids.length) return;
    let buf = fs.readFileSync(binFile);
    if (buf.byteLength !== raw.ids.length * DIM * 4) return;
    if (buf.byteOffset % 4 !== 0) buf = Buffer.from(buf);
    const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    for (let i = 0; i < raw.ids.length; i++) {
      out.set(raw.ids[i], { row: vecs.subarray(i * DIM, (i + 1) * DIM), hash: raw.hashes[i] });
    }
  } catch {}
}

// every row a new build may REUSE: the completed index (manual rebuilds skip
// re-embedding unchanged symbols) plus the partial checkpoint (a build the
// app was closed in the middle of). Later sources win on id collision.
function loadReusableRows(dir) {
  const out = new Map();
  collectRows(out, indexPath(dir), binPath(dir));
  collectRows(out, partialJsonPath(dir), partialBinPath(dir));
  return out;
}

// checkpoint the rows embedded so far (null slots skipped). bin first, json
// second — a json without its matching bin is rejected by collectRows.
async function writePartial(dir, defs, rows, hashes) {
  try {
    const ids = [], hs = [], keep = [];
    for (let i = 0; i < defs.length; i++) {
      if (rows[i]) { ids.push(defs[i].id); hs.push(hashes[i]); keep.push(rows[i]); }
    }
    const flat = new Float32Array(ids.length * DIM);
    for (let i = 0; i < keep.length; i++) flat.set(keep[i], i * DIM);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(partialBinPath(dir),
      Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
    await fs.promises.writeFile(partialJsonPath(dir),
      JSON.stringify({ v: SCHEMA, built: Date.now(), model: MODEL_NAME, dim: DIM,
        ids, hashes: hs }), 'utf8');
  } catch {}
}
async function clearPartial(dir) {
  for (const p of [partialJsonPath(dir), partialBinPath(dir)]) {
    try { await fs.promises.unlink(p); } catch {}
  }
}

// legacy v1: unpack the base64 blob into a Float32Array view
function unpackVecs(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// write the v2 pair: raw Float32 bin first, then the metadata JSON (a reader
// that sees the new JSON must find its bin already on disk). `hashes` (doc
// hashes aligned to ids) enable row reuse by later builds; entries of 0 mean
// "unknown — never reuse".
async function writeIndex(dir, ids, rows, hashes) {
  const flat = new Float32Array(ids.length * DIM);
  for (let i = 0; i < rows.length; i++) flat.set(rows[i], i * DIM);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(binPath(dir),
    Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
  const meta = { v: SCHEMA, built: Date.now(), model: MODEL_NAME, dim: DIM, ids,
    hashes: hashes || ids.map(() => 0) };
  await fs.promises.writeFile(indexPath(dir), JSON.stringify(meta), 'utf8');
  _cache.dir = null;   // invalidate in-memory cache
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
  if (!graph || !graph.defs || !graph.defs.length) return { ok: false, error: 'empty graph' };
  const defs = graph.defs;
  // report 0/N BEFORE the model load — first init takes tens of seconds and
  // used to leave the progress bar frozen with no explanation
  if (onProgress) onProgress(0, defs.length);
  const ids = defs.map((d) => d.id);
  const docs = defs.map(defDoc);
  const hashes = docs.map(docHash);
  // RESUME: reuse every row (from the checkpoint of an interrupted build, or
  // the existing index on a manual rebuild) whose id + doc-hash still match.
  const reusable = loadReusableRows(dir);
  const rows = new Array(defs.length).fill(null);
  const missing = [];
  for (let i = 0; i < defs.length; i++) {
    const r = reusable.get(ids[i]);
    if (r && r.hash === hashes[i]) rows[i] = r.row;
    else missing.push(i);
  }
  const reused = defs.length - missing.length;
  if (reused && onProgress) onProgress(reused, defs.length);
  if (!missing.length) {   // everything current — no model load needed at all
    await writeIndex(dir, ids, rows, hashes);
    await clearPartial(dir);
    return { ok: true, count: ids.length, resumed: reused };
  }
  const emb = await getEmbedder();
  if (!emb) return { ok: false, error: _embedderError || 'embedder unavailable' };
  // embed only the missing docs, checkpointing every ~1000 so a close/crash
  // mid-build loses at most that much work
  const missingDocs = missing.map((i) => docs[i]);
  let doneNew = 0, sinceCkpt = 0;
  for await (const batch of emb.passageEmbed(missingDocs, 64)) {
    for (const v of batch) { rows[missing[doneNew]] = v; doneNew++; }
    sinceCkpt += batch.length;
    if (onProgress) onProgress(reused + doneNew, defs.length);
    if (sinceCkpt >= 1000) {
      sinceCkpt = 0;
      await writePartial(dir, defs, rows, hashes);
    }
  }
  await writeIndex(dir, ids, rows, hashes);
  await clearPartial(dir);
  return { ok: true, count: ids.length, resumed: reused };
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
  const ids = [], rows = [], hashes = [];
  for (let i = 0; i < idx.ids.length; i++) {
    if (touched.has(relOf(idx.ids[i]))) continue;         // drop stale rows for these files
    ids.push(idx.ids[i]);
    rows.push(idx.vecs.subarray(i * DIM, (i + 1) * DIM));
    hashes.push(idx.hashes ? idx.hashes[i] : 0);          // 0 = unknown, never reused
  }
  const fresh = (graph.defs || []).filter((d) => touched.has(d.rel));
  if (fresh.length) {
    const docs = fresh.map(defDoc);
    const embedded = await embedDocs(emb, docs);
    for (let i = 0; i < fresh.length; i++) {
      ids.push(fresh[i].id); rows.push(embedded[i]); hashes.push(docHash(docs[i]));
    }
  }
  await writeIndex(dir, ids, rows, hashes);
  return { ok: true, count: ids.length };
}

// in-memory cache of the decoded index (one project at a time is the common case)
const _cache = { dir: null, ids: null, vecs: null };

function loadIndex(dir) {
  if (_cache.dir === dir) return _cache;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); } catch { return null; }
  if (!raw || raw.dim !== DIM || !Array.isArray(raw.ids)) return null;
  let vecs = null;
  if (raw.v === SCHEMA) {
    try {
      let buf = fs.readFileSync(binPath(dir));
      if (buf.byteLength === raw.ids.length * DIM * 4) {
        // Float32Array views need 4-byte alignment; pooled Buffers may not have it
        if (buf.byteOffset % 4 !== 0) buf = Buffer.from(buf);
        vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      }
    } catch {}
  } else if (raw.v === 1 && typeof raw.vecs === 'string') {
    vecs = unpackVecs(raw.vecs);   // legacy in-JSON base64 blob
  }
  if (!vecs) return null;
  _cache.dir = dir;
  _cache.ids = raw.ids;
  _cache.vecs = vecs;
  // doc hashes ride along so watcher syncs preserve them (resume metadata)
  _cache.hashes = (Array.isArray(raw.hashes) && raw.hashes.length === raw.ids.length)
    ? raw.hashes : null;
  return _cache;
}

// Why the embedder is down, if it is. Lets callers tell "no index on disk" apart
// from "index exists but the model won't load" — two very different fixes.
function embedderError() { return _embedderBroken ? (_embedderError || 'embedder unavailable') : ''; }

// true only for a LOADABLE index — a schema-stale or corrupt file must read as
// "absent" so maybeBootstrapVectors kicks a rebuild instead of the app sitting
// on a dead index forever (bare existsSync had exactly that failure mode).
function hasVectorIndex(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8'));
    if (!raw || raw.dim !== DIM || !Array.isArray(raw.ids)) return false;
    if (raw.v === SCHEMA) return fs.existsSync(binPath(dir));
    return raw.v === 1 && typeof raw.vecs === 'string';
  } catch { return false; }
}

// drop the decoded in-memory copy so the next query re-reads from disk. The main
// process must call this after a worker thread rewrites vectors.json, or its
// queries would keep using the pre-build vectors.
function invalidateCache() {
  _cache.dir = null; _cache.ids = null; _cache.vecs = null; _cache.hashes = null;
}

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
  setModelDir, resolveModelDir, embedderError,
};
