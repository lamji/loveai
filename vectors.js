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
const os = require('os');
const path = require('path');

const MODEL_NAME = 'BGESmallENV15';
const MODEL_FOLDER = 'fast-bge-small-en-v1.5';   // on-disk name fastembed uses
const MODEL_FILE = 'model_optimized.onnx';
const DIM = 384;
const SCHEMA = 2;   // 2 = binary sidecar (vectors.bin); 1 = legacy base64 JSON

// ---- Resource budget -------------------------------------------------------
// This runs on the user's LAPTOP while they work, not on a build server, so the
// embedder is capped rather than allowed to take the machine. Measured before
// capping: ONNX defaulted to ~6 of 16 cores pinned at 100% for the whole build.
// Two threads keeps a build in the background noise; raise via LOVEAI_EMBED_THREADS.
const THREADS = (() => {
  const env = parseInt(process.env.LOVEAI_EMBED_THREADS || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  const cores = os.cpus().length || 4;
  return Math.max(1, Math.min(2, cores - 1));   // leave the machine usable
})();

// Docs are SHORT (measured over a real graph: mean 48 tokens, p99 121, max 172),
// but fastembed pads every sequence to `maxLength` — at the old 256 that made
// 81% of every forward pass pure padding. We tokenize to natural length and pad
// each batch to ITS OWN longest instead (see embedBatched), so this is now only
// a truncation ceiling. 192 clears the p99 with room to spare.
const MAX_TOKENS = 192;
const BATCH = 64;

// Drop the model from RAM after this long with no vector work. It holds ~400MB
// resident (133MB of weights plus ONNX arenas) and a desktop session is mostly
// idle; the next job pays a ~2.5s reload, which is invisible next to a build.
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

let _embedderPromise = null;   // singleton init (model load is expensive)
let _embedderBroken = false;
let _embedderError = '';       // last init failure reason, surfaced to the UI
let _modelDirOverride = '';    // main process passes the resolved dir to the worker
let _padId = 0;                // pad token id/text, read from the model dir at init
let _padToken = '[PAD]';

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

// fastembed hard-codes its InferenceSession options and exposes no way to bound
// the thread pool, so we wrap the constructor it calls. Public onnxruntime API
// only — no fastembed internals — and it re-wraps idempotently across reloads.
function capOnnxThreads() {
  let ort;
  try { ort = require('onnxruntime-node'); } catch { return; }
  const S = ort && ort.InferenceSession;
  if (!S || S._loveaiCapped) return;
  const orig = S.create.bind(S);
  S.create = (model, opts, ...rest) => orig(model, {
    ...(opts || {}),
    intraOpNumThreads: THREADS,   // parallelism WITHIN one operator
    interOpNumThreads: 1,         // we already serialize jobs in the worker
  }, ...rest);
  S._loveaiCapped = true;
}

// pad token id/text for manual batch padding — same files fastembed reads
function loadPadConfig(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (Number.isFinite(cfg.pad_token_id)) _padId = cfg.pad_token_id;
  } catch {}
  try {
    const tc = JSON.parse(
      fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'));
    if (tc && tc.pad_token) _padToken = tc.pad_token;
  } catch {}
}

// lazy, cached embedder. Returns null (never throws) when unavailable so the
// caller can fall back to lexical retrieval.
async function getEmbedder() {
  if (_embedderBroken) return null;
  touchEmbedder();
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    capOnnxThreads();   // MUST precede init — that's where the session is created
    const { FlagEmbedding, EmbeddingModel } = require('fastembed');
    const dir = resolveModelDir();
    if (!dir) {
      throw new Error(
        `embedding model not found (local_cache/${MODEL_FOLDER}/${MODEL_FILE})`);
    }
    loadPadConfig(dir);
    // CUSTOM + modelAbsoluteDirPath loads the local .onnx directly and SKIPS the
    // network download path entirely. Embeddings are identical to the named
    // BGESmallENV15 path (same onnx, same passage:/query: prefixes, same tokenizer).
    const emb = await FlagEmbedding.init({
      model: EmbeddingModel.CUSTOM,
      modelAbsoluteDirPath: dir,
      modelName: MODEL_FILE,
      maxLength: MAX_TOKENS,   // truncation ceiling; padding is per-batch now
    });
    // Switch the tokenizer from Fixed(maxLength) padding to natural length:
    // omitting maxLength selects BatchLongest, and since fastembed encodes one
    // string per call that yields the sequence's true length. embedBatched then
    // pads each batch itself. Truncation (setTruncation) is untouched.
    try {
      emb.tokenizer.setPadding({ padId: _padId, padToken: _padToken });
      emb._loveaiNaturalLen = true;
    } catch {
      emb._loveaiNaturalLen = false;   // fall back to fastembed's own loop
    }
    return emb;
  })().catch((e) => {
    _embedderBroken = true;
    _embedderPromise = null;
    _embedderError = (e && e.message) ? String(e.message) : String(e);
    console.error('[vectors] embedder init failed:', _embedderError);
    return null;
  });
  return _embedderPromise;
}

// ---- idle unload ----------------------------------------------------------
let _idleTimer = null;

// Free the ONNX session and its arenas. Safe at any time: the next getEmbedder()
// simply re-inits. Callers must not hold an embedder across an await after this.
function releaseEmbedder() {
  const p = _embedderPromise;
  _embedderPromise = null;
  clearTimeout(_idleTimer);
  _idleTimer = null;
  if (!p) return;
  Promise.resolve(p).then((emb) => {
    try { if (emb && emb.session && emb.session.release) emb.session.release(); } catch {}
  }).catch(() => {});
}

// restart the idle countdown; called on every embedder use
function touchEmbedder() {
  if (!IDLE_UNLOAD_MS) return;
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(releaseEmbedder, IDLE_UNLOAD_MS);
  if (_idleTimer.unref) _idleTimer.unref();   // never hold the process open
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

// L2-normalize in place (matches fastembed's `normalize`)
function normalizeRow(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1e-12;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Embed one already-tokenized, length-sorted batch. Every sequence is padded to
// THIS batch's longest instead of a global maxLength — with docs averaging 48
// tokens against a 256 ceiling that was 81% of the compute spent on padding.
// Pooling is CLS (row 0 of last_hidden_state) + L2, identical to fastembed's, so
// vectors stay bit-compatible with indexes built before this change.
async function runBatch(emb, encs) {
  const ort = require('onnxruntime-node');
  const n = encs.length;
  const width = encs[n - 1].ids.length;   // sorted ascending -> last is longest
  const ids = new BigInt64Array(n * width);
  const mask = new BigInt64Array(n * width);
  const types = new BigInt64Array(n * width);
  const padBig = BigInt(_padId);
  for (let r = 0; r < n; r++) {
    const e = encs[r];
    const off = r * width;
    for (let c = 0; c < width; c++) {
      const real = c < e.ids.length;
      ids[off + c] = real ? BigInt(e.ids[c]) : padBig;
      mask[off + c] = real ? BigInt(e.mask[c]) : 0n;
      types[off + c] = real ? BigInt(e.types[c]) : 0n;
    }
  }
  const dims = [n, width];
  const out = await emb.session.run({
    input_ids: new ort.Tensor('int64', ids, dims),
    attention_mask: new ort.Tensor('int64', mask, dims),
    token_type_ids: new ort.Tensor('int64', types, dims),
  });
  const data = out.last_hidden_state.data;
  const [, seq, hidden] = out.last_hidden_state.dims;
  const rows = [];
  for (let r = 0; r < n; r++) {
    const start = r * seq * hidden;          // CLS = first token of each sequence
    rows.push(normalizeRow(Float32Array.from(data.slice(start, start + hidden))));
  }
  return rows;
}

// Embed many docs; returns Float32Array[] aligned to `docs`. Docs are tokenized
// to their NATURAL length, then grouped by length so each batch pads to its own
// max. Work happens in windows so peak memory stays flat on huge repos rather
// than holding every encoding at once.
// `onProgress(done, total)` may return a promise (build checkpointing awaits it).
async function embedDocs(emb, docs, onProgress) {
  const rows = new Array(docs.length);
  // graceful degradation: an unexpected fastembed shape falls back to its own
  // loop, which is slower but always correct
  if (!emb._loveaiNaturalLen || !emb.session || !emb.tokenizer) {
    let done = 0;
    for await (const batch of emb.passageEmbed(docs, BATCH)) {
      for (const v of batch) rows[done++] = v;
      if (onProgress) await onProgress(done, docs.length, rows);
    }
    return rows;
  }
  const WINDOW = 2048;   // encodings held at once; length-sorting is window-local
  let done = 0;
  for (let w = 0; w < docs.length; w += WINDOW) {
    const idxs = [];
    for (let i = w; i < Math.min(w + WINDOW, docs.length); i++) idxs.push(i);
    const encs = await Promise.all(idxs.map(async (i) => {
      const e = await emb.tokenizer.encode(`passage: ${docs[i]}`);
      return {
        i,
        ids: e.getIds(),
        mask: e.getAttentionMask(),
        types: e.getTypeIds(),
      };
    }));
    encs.sort((a, b) => a.ids.length - b.ids.length);
    for (let b = 0; b < encs.length; b += BATCH) {
      const slice = encs.slice(b, b + BATCH);
      const out = await runBatch(emb, slice);
      for (let k = 0; k < slice.length; k++) rows[slice[k].i] = out[k];
      done += slice.length;
      if (onProgress) await onProgress(done, docs.length, rows);
    }
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
  let sinceCkpt = 0, lastDone = 0;
  const fresh = await embedDocs(emb, missingDocs, async (doneNew, _total, partial) => {
    // mirror finished rows into the full-length array so a checkpoint captures
    // them. Batches complete out of order (length-sorted), hence the scan —
    // trivial next to inference, and writePartial already skips empty slots.
    for (let j = 0; j < missing.length; j++) {
      if (partial[j] && !rows[missing[j]]) rows[missing[j]] = partial[j];
    }
    if (onProgress) onProgress(reused + doneNew, defs.length);
    sinceCkpt += doneNew - lastDone;
    lastDone = doneNew;
    if (sinceCkpt >= 1000) {
      sinceCkpt = 0;
      await writePartial(dir, defs, rows, hashes);
    }
  });
  for (let j = 0; j < missing.length; j++) rows[missing[j]] = fresh[j];
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
  MODEL_NAME, DIM, THREADS, IDLE_UNLOAD_MS,
  getEmbedder, buildVectorIndex, syncFilesVectors, queryVectors,
  hasVectorIndex, invalidateCache, defDoc,
  setModelDir, resolveModelDir, embedderError, releaseEmbedder,
};
