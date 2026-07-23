// ===== Tree-sitter parse layer — runs INSIDE codegraph-worker.js =====
// Extracted from main.js: WASM parsing is pure CPU and must never run on the
// Electron main process (a 5000-file build stuttered the UI even with
// yielding). This module owns the runtime, grammars, queries and per-file
// extraction; main.js keeps assembly (edge linking), persistence and caches.
// Requiring this module does NOT load web-tree-sitter — that stays lazy
// inside tsInit(), so main.js can import LANG_GRAMMAR from here for free.

const fs = require('fs');
const path = require('path');
const { INDEX_MAX_FILES, SYMBOL_MAX_BYTES, walkRepo } = require('./walker');

// ext -> prebuilt grammar (tree-sitter-wasms). Only these langs get an AST graph;
// unknown exts fall through to the lexical fallback. Grammars load LAZILY (below).
const LANG_GRAMMAR = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'tsx', py: 'python', go: 'go', rs: 'rust', java: 'java',
};
// tree-sitter queries per grammar: def (declarations), call (references), imp (named
// imports). tsx reuses the typescript set. Each string is compiled independently and
// skipped on error, so a grammar version drift can't break the whole build.
const TS_QUERIES_JS = {
  def: [
    '(function_declaration name:(identifier)@n)',
    '(class_declaration name:(identifier)@n)',
    '(method_definition name:(property_identifier)@n)',
    '(variable_declarator name:(identifier)@n value:[(arrow_function)(function_expression)])',
  ],
  call: [
    '(call_expression function:(identifier)@n)',
    '(call_expression function:(member_expression property:(property_identifier)@n))',
    '(new_expression constructor:(identifier)@n)',   // constructor dependency (new Foo())
  ],
  imp: ['(import_specifier name:(identifier)@n)', '(import_clause (identifier)@n)'],
};
const TS_QUERIES_TS = {
  def: [
    '(function_declaration name:(identifier)@n)',
    '(class_declaration name:(type_identifier)@n)',
    '(interface_declaration name:(type_identifier)@n)',
    '(enum_declaration name:(identifier)@n)',
    '(method_definition name:(property_identifier)@n)',
    '(variable_declarator name:(identifier)@n value:[(arrow_function)(function_expression)])',
  ],
  call: TS_QUERIES_JS.call,
  imp: TS_QUERIES_JS.imp,
};
const TS_QUERIES = {
  javascript: TS_QUERIES_JS,
  typescript: TS_QUERIES_TS,
  tsx: TS_QUERIES_TS,
  python: {
    def: ['(function_definition name:(identifier)@n)', '(class_definition name:(identifier)@n)'],
    call: [
      '(call function:(identifier)@n)',
      '(call function:(attribute attribute:(identifier)@n))',
    ],
    imp: ['(import_from_statement name:(dotted_name (identifier)@n))'],
  },
  go: {
    def: [
      '(function_declaration name:(identifier)@n)',
      '(method_declaration name:(field_identifier)@n)',
      '(type_spec name:(type_identifier)@n)',
    ],
    call: [
      '(call_expression function:(identifier)@n)',
      '(call_expression function:(selector_expression field:(field_identifier)@n))',
    ],
    imp: [],
  },
  rust: {
    def: [
      '(function_item name:(identifier)@n)',
      '(struct_item name:(type_identifier)@n)',
      '(enum_item name:(type_identifier)@n)',
    ],
    call: [
      '(call_expression function:(identifier)@n)',
      '(call_expression function:(scoped_identifier name:(identifier)@n))',
      '(call_expression function:(field_expression field:(field_identifier)@n))',
    ],
    imp: [],
  },
  java: {
    def: [
      '(method_declaration name:(identifier)@n)',
      '(class_declaration name:(identifier)@n)',
      '(interface_declaration name:(identifier)@n)',
    ],
    call: ['(method_invocation name:(identifier)@n)'],
    imp: [],
  },
};

// tree-sitter runtime state (all lazy — nothing loads until the first build).
let tsMod = null;             // the web-tree-sitter module (required lazily)
let tsReady = null;           // Parser.init() promise (run once)
let tsParser = null;          // reused Parser instance (setLanguage per file)
let tsBroken = false;         // runtime/grammar totally unavailable → skip tree-sitter
let tsInitError = '';         // last real tsInit failure, surfaced via codegraph-status
let tsInitErrorLogged = false; // log a given failure once per session, not per file
const tsLangs = {};           // grammar name -> Language (null = failed)
const tsQueryCache = {};      // grammar name -> { def:[Query], call:[Query], imp:[Query] }

// resolve a bundled .wasm, preferring the asar.unpacked copy in a packaged build
function tsAsset(p) {
  const unpacked = p.replace('app.asar', 'app.asar.unpacked');
  try { if (fs.existsSync(unpacked)) return unpacked; } catch {}
  return p;
}
function grammarWasm(name) {
  return tsAsset(path.join(__dirname, 'node_modules', 'tree-sitter-wasms', 'out',
    `tree-sitter-${name}.wasm`));
}
async function tsInit() {
  if (tsReady) return tsReady;
  tsReady = (async () => {
    try {
      try {
        tsMod = require('web-tree-sitter');
        if (!tsMod || !tsMod.Parser) throw new Error('web-tree-sitter: Parser missing');
      } catch {
        // exports-map may resolve oddly under Electron — fall back to the explicit CJS entry
        tsMod = require('web-tree-sitter/tree-sitter.cjs');
      }
      // read the runtime WASM as bytes: passing a path lets the glue code try
      // fetch() under Electron's renderer-flavored globals, which fails silently
      const wasmPath = tsAsset(path.join(__dirname, 'node_modules', 'web-tree-sitter',
        'tree-sitter.wasm'));
      const wasmBinary = fs.readFileSync(wasmPath);
      await tsMod.Parser.init({
        wasmBinary,
        locateFile(name) {
          return tsAsset(path.join(__dirname, 'node_modules', 'web-tree-sitter', name));
        },
      });
    } catch (err) {
      tsInitError = String(err && err.message ? err.message : err);
      if (!tsInitErrorLogged) {
        console.error('[codegraph] tree-sitter init failed:', err);
        tsInitErrorLogged = true;
      }
      tsReady = null;   // allow a later retry (e.g. a manual rebuild) to re-attempt
      throw err;
    }
  })();
  return tsReady;
}
async function loadLang(name) {
  if (name in tsLangs) return tsLangs[name];
  try {
    tsLangs[name] = await tsMod.Language.load(fs.readFileSync(grammarWasm(name)));
  } catch (err) {
    tsLangs[name] = null;
    console.error(`[codegraph] grammar load failed (${name}):`, err);
  }
  return tsLangs[name];
}
function compiledQueries(name, lang) {
  if (tsQueryCache[name]) return tsQueryCache[name];
  const spec = TS_QUERIES[name] || {};
  const out = { def: [], call: [], imp: [] };
  for (const cat of ['def', 'call', 'imp']) {
    for (const q of (spec[cat] || [])) {
      try { out[cat].push(new tsMod.Query(lang, q)); }
      catch (err) { console.error(`[codegraph] query compile failed (${name}/${cat}):`, err); }
    }
  }
  tsQueryCache[name] = out;
  return out;
}
// ===== Rich symbol records — from a def name node up to its declaration =====
// A def query captures a NAME identifier; the symbol's extent/type/parent live on
// the enclosing declaration node. These maps + helpers derive the full record
// (type, line range, parent, visibility, doc, language) WITHOUT storing source —
// source is read lazily by line range when a symbol is actually packed, keeping
// the index small (a Performance goal). Node API per web-tree-sitter 0.25.
const DECL_TYPES = new Set([
  'function_declaration', 'function_definition', 'function_item',
  'generator_function_declaration', 'function_expression', 'arrow_function',
  'class_declaration', 'class_definition',
  'method_definition', 'method_declaration',
  'interface_declaration', 'enum_declaration', 'enum_item',
  'struct_item', 'trait_item', 'type_spec', 'type_alias_declaration',
  'variable_declarator', 'lexical_declaration', 'public_field_definition',
]);
// enclosing nodes that make a symbol a CHILD (its parent symbol)
const CONTAINER_TYPES = new Set([
  'class_declaration', 'class_definition', 'interface_declaration',
  'struct_item', 'trait_item', 'enum_declaration', 'impl_item',
  'namespace_declaration', 'internal_module', 'module',
]);
// declaration node type -> our coarse symbol.type label
const TYPE_OF = {
  function_declaration: 'function', function_definition: 'function',
  function_item: 'function', generator_function_declaration: 'function',
  function_expression: 'function', arrow_function: 'function',
  variable_declarator: 'function', lexical_declaration: 'function',
  method_definition: 'method', method_declaration: 'method',
  class_declaration: 'class', class_definition: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum', enum_item: 'enum',
  struct_item: 'struct', trait_item: 'trait',
  type_spec: 'type', type_alias_declaration: 'type',
  public_field_definition: 'field',
};
// walk up from a captured name node to the declaration that owns its extent
function enclosingDecl(nameNode) {
  let n = nameNode;
  while (n && !DECL_TYPES.has(n.type)) n = n.parent;
  return n || nameNode.parent || nameNode;
}
function nodeName(node) {
  try { const id = node.childForFieldName('name'); if (id && id.text) return id.text; }
  catch {}
  return '';
}
// nearest enclosing class/interface/struct/namespace name (for symbol.parent)
function parentSymbol(decl) {
  let n = decl.parent;
  while (n) {
    if (CONTAINER_TYPES.has(n.type)) { const nm = nodeName(n); if (nm) return nm.slice(0, 80); }
    n = n.parent;
  }
  return '';
}
// visibility heuristic — accessibility modifier > export/pub > python underscore
function visibilityOf(decl, grammar, name) {
  try {
    for (const c of (decl.namedChildren || [])) {
      if (!c) continue;
      if (c.type === 'accessibility_modifier') return c.text;   // TS/Java public/private/protected
      if (c.type === 'visibility_modifier') return 'pub';        // Rust
    }
  } catch {}
  let n = decl, hops = 0;
  while (n && hops < 4) {
    if (n.type === 'export_statement') return 'exported';
    n = n.parent; hops++;
  }
  if (grammar === 'python') return name.startsWith('_') ? 'private' : 'public';
  return 'public';
}
// leading line-comment(s) immediately above the declaration → short doc string
function leadingDoc(decl) {
  let n = decl.previousNamedSibling;
  if (!n && decl.parent && decl.parent.type === 'export_statement') {
    n = decl.parent.previousNamedSibling;
  }
  const parts = [];
  while (n && n.type === 'comment' && parts.length < 6) {
    parts.unshift(n.text);
    n = n.previousNamedSibling;
  }
  let doc = parts.join(' ').replace(/^[\/*#\s]+|[*\/\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (doc.length > 200) doc = doc.slice(0, 200) + '…';
  return doc;
}
// build the rich record for one captured name node (rel/id filled by the assembler)
function defRecord(nameNode, grammar, langName) {
  const name = (nameNode.text || '').slice(0, 80);
  if (!name) return null;
  const decl = enclosingDecl(nameNode);
  const sp = decl.startPosition || { row: 0 };
  const ep = decl.endPosition || { row: 0 };
  return {
    name,
    type: TYPE_OF[decl.type] || 'symbol',
    sl: sp.row + 1,
    el: ep.row + 1,
    parent: parentSymbol(decl),
    vis: visibilityOf(decl, grammar, name),
    doc: leadingDoc(decl),
    lang: langName,
  };
}

// parse one file → { symbols, calls, imps }. symbols are rich def records (deduped
// by name, first wins — matches the prior name-Set behavior so ids stay unique per
// file); calls/imps stay name-only for NAME-resolved edge linking. null on failure.
async function extractFileGraph(text, grammar) {
  const lang = await loadLang(grammar);
  if (!lang) return null;
  if (!tsParser) tsParser = new tsMod.Parser();
  tsParser.setLanguage(lang);
  let tree;
  try { tree = tsParser.parse(text); } catch { return null; }
  if (!tree) return null;
  const q = compiledQueries(grammar, lang);
  const langName = grammar === 'tsx' ? 'typescript' : grammar;
  const grab = (queries) => {
    const seen = new Set();
    for (const query of queries) {
      let caps; try { caps = query.captures(tree.rootNode); } catch { continue; }
      for (const c of caps) {
        const t = c.node.text;
        if (t && t.length <= 80) seen.add(t);
      }
    }
    return [...seen];
  };
  // dedupe by name AND start line — same-named symbols at different lines
  // (e.g. `render` methods on two classes in one file) are DISTINCT defs; the
  // old name-only dedupe silently dropped the second and served the first's
  // line range from the packer.
  const byKey = new Map();
  for (const query of q.def) {
    let caps; try { caps = query.captures(tree.rootNode); } catch { continue; }
    for (const c of caps) {
      const rec = defRecord(c.node, grammar, langName);
      if (!rec) continue;
      const key = rec.name + '@' + rec.sl;
      if (!byKey.has(key)) byKey.set(key, rec);
    }
  }
  const symbols = [...byKey.values()];
  // FORWARD deps: bucket each call/new capture into the INNERMOST enclosing def
  // (by line range) → per-symbol `calls`. This is what lets the packer expand
  // "load login() AND what it calls" without reading whole files. Callee names
  // resolve to def ids by NAME at query time (see forwardReach).
  const callCaps = [];
  for (const query of q.call) {
    let caps; try { caps = query.captures(tree.rootNode); } catch { continue; }
    for (const c of caps) {
      const t = c.node.text;
      const row = (c.node.startPosition ? c.node.startPosition.row : 0) + 1;
      if (t && t.length <= 80) callCaps.push({ name: t, row });
    }
  }
  const fwd = symbols.map(() => new Set());
  for (const cc of callCaps) {
    let bestI = -1, bestSpan = Infinity;
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      if (cc.row >= s.sl && cc.row <= s.el) {
        const span = s.el - s.sl;
        if (span < bestSpan) { bestSpan = span; bestI = i; }
      }
    }
    if (bestI >= 0 && cc.name !== symbols[bestI].name) fwd[bestI].add(cc.name);
  }
  symbols.forEach((s, i) => { s.calls = [...fwd[i]].slice(0, 30); });
  // CONSTRUCTOR DEPENDENCIES: reaching a class via `new Class()` should expand to
  // what its constructor builds. Members' calls bucket to the member (e.g. the
  // constructor def), not the class — so merge a class's constructor calls up onto
  // the class itself, letting forwardReach follow class → constructor deps.
  for (const s of symbols) {
    if (s.type !== 'class' && s.type !== 'struct' && s.type !== 'interface') continue;
    const isCtor = (m) => m.name === 'constructor' || m.name === s.name;
    const members = symbols.filter((m) => m !== s && m.parent === s.name);
    const merged = new Set(s.calls);
    // constructor deps first (they matter most for `new Class()`), then other methods
    for (const m of members) if (isCtor(m)) for (const c of m.calls) merged.add(c);
    for (const m of members) if (!isCtor(m) && m.type === 'method') for (const c of m.calls) merged.add(c);
    s.calls = [...merged].slice(0, 30);
  }
  const res = { symbols, calls: grab(q.call), imps: grab(q.imp) };
  try { tree.delete(); } catch {}
  return res;
}
// module specifiers a file imports/requires, straight off the text (regex — the
// tree-sitter imp queries capture NAMES, not sources). Feeds import-scoped edge
// resolution below. JS/TS quoted forms + python `from x.y import`.
function importSpecs(text) {
  const out = new Set();
  // no spaces in the char class: real module specifiers never contain them,
  // and excluding them stops quoted PROSE in comments from matching
  const reQuoted = /(?:\bfrom|\brequire\s*\(|\bimport\s*\(?)\s*['"]([^'"\s]+)['"]/g;
  const rePy = /\bfrom\s+([\w.]+)\s+import\b/g;
  let m;
  while ((m = reQuoted.exec(text)) && out.size < 100) out.add(m[1]);
  while ((m = rePy.exec(text)) && out.size < 100) out.add(m[1]);
  return [...out];
}

// ---- repo-scale parse entry points (called from codegraph-worker.js) ----

// parse one file → raw { rel, symbols, calls, imps, specs } (null on skip/fail)
async function parseFile(abs, rel) {
  const grammar = LANG_GRAMMAR[path.extname(abs).slice(1).toLowerCase()];
  if (!grammar) return null;
  await tsInit();
  const st = await fs.promises.stat(abs);
  if (!st.isFile() || st.size > SYMBOL_MAX_BYTES) return null;
  const text = await fs.promises.readFile(abs, 'utf8');
  const raw = await extractFileGraph(text, grammar);
  if (!raw) return null;
  raw.rel = rel;
  raw.specs = importSpecs(text);
  return raw;
}

// parse the whole repo → { raws, truncated }. Progress is (done, total); total
// is pre-counted only when opts.countFirst (a manual rebuild's progress bar).
async function parseRepo(root, opts = {}) {
  await tsInit();   // throws when the runtime is unavailable — caller reports it
  const grammarExts = new Set(Object.keys(LANG_GRAMMAR));
  let total = 0;
  if (opts.countFirst) {
    let seen = 0;
    total = await walkRepo(root, { exts: grammarExts }, () => {
      seen++;
      if (opts.onCount && seen % 250 === 0) opts.onCount(seen);
    });
  }
  const raws = [];
  let done = 0;
  const counted = await walkRepo(root, { exts: grammarExts }, async ({ full, rel, ext }) => {
    const st = await fs.promises.stat(full);
    if (st.size > SYMBOL_MAX_BYTES) return false;
    const text = await fs.promises.readFile(full, 'utf8');
    const raw = await extractFileGraph(text, LANG_GRAMMAR[ext]);
    if (raw) { raw.rel = rel; raw.specs = importSpecs(text); raws.push(raw); }
    done++;
    if (opts.onProgress && done % 10 === 0) opts.onProgress(done, total);
  });
  if (opts.onProgress) opts.onProgress(done, total || done);
  return { raws, truncated: counted >= INDEX_MAX_FILES };
}

module.exports = { LANG_GRAMMAR, parseFile, parseRepo, importSpecs, extractFileGraph };
