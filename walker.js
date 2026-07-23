// ===== Shared repo-walk rules + the ONE traversal every indexer uses =====
// Extracted from main.js so the main process (fingerprint, symbol index) and
// the codegraph parse worker share IDENTICAL skip/size/cap semantics — the
// four hand-rolled walkers had already drifted from each other. Pure Node,
// no Electron imports (must load inside worker_threads).

const fs = require('fs');
const path = require('path');

const INDEX_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.loveai',
  '.next', 'coverage', 'out', 'target', 'vendor', 'venv', '__pycache__', 'local_cache']);
const INDEX_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'html',
  'css', 'scss', 'md', 'py', 'go', 'rs', 'java', 'cs', 'php', 'rb', 'vue', 'svelte',
  'yml', 'yaml', 'toml', 'sql']);
const INDEX_MAX_FILES = 5000;
const SYMBOL_MAX_BYTES = 400 * 1024;

// extra ignored dir names from the project's root .gitignore — SIMPLE entries
// only (plain names, optional trailing slash; no globs, no nested paths). This
// keeps build artifacts the hardcoded set doesn't know about (e.g. a custom
// output dir) from eating the INDEX_MAX_FILES budget. Cached per root.
const gitignoreDirs = {};   // root -> Set of dir names
function ignoredDirs(root) {
  if (gitignoreDirs[root]) return gitignoreDirs[root];
  const set = new Set();
  try {
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      line = line.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!line || line.includes('*') || line.includes('/')) continue;
      set.add(line);
    }
  } catch {}
  gitignoreDirs[root] = set;
  return set;
}
// shared walker rule: should this directory (or path segment) be skipped?
function skipDir(root, name) {
  return name.startsWith('.') || INDEX_SKIP_DIRS.has(name) || ignoredDirs(root).has(name);
}

// Walk `root` calling onFile({ full, rel, ext }) for every candidate file.
// - opts.exts: Set of extensions to include (omit = every file)
// - onFile returning false (or throwing) → the file does NOT count toward the
//   INDEX_MAX_FILES cap (matches the old walkers: skipped/unreadable files
//   never counted)
// - yields to the event loop every `yieldEvery` files so a big walk never
//   freezes its thread (main process or worker alike)
// Returns the counted-file total; count === INDEX_MAX_FILES ⇒ truncated.
async function walkRepo(root, opts, onFile) {
  const yieldEvery = (opts && opts.yieldEvery) || 25;
  const exts = (opts && opts.exts) || null;
  let count = 0, sinceYield = 0;
  const yieldSoon = () => new Promise((r) => setImmediate(r));
  async function walk(dir) {
    if (count >= INDEX_MAX_FILES) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (count >= INDEX_MAX_FILES) return;
      if (d.isDirectory()) {
        if (!skipDir(root, d.name)) await walk(path.join(dir, d.name));
        continue;
      }
      if (!d.isFile() && !d.isSymbolicLink()) continue;
      const ext = path.extname(d.name).slice(1).toLowerCase();
      if (exts && !exts.has(ext)) continue;
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      let counted;
      try { counted = await onFile({ full, rel, ext }); } catch { counted = false; }
      if (counted !== false) count++;
      if (++sinceYield >= yieldEvery) { sinceYield = 0; await yieldSoon(); }
    }
  }
  await walk(root);
  return count;
}

module.exports = {
  INDEX_SKIP_DIRS, INDEX_EXTS, INDEX_MAX_FILES, SYMBOL_MAX_BYTES,
  ignoredDirs, skipDir, walkRepo,
};
