#!/usr/bin/env node
// ============================================================
// tools/dict.js — manage the global word-list store from the CLI
// ============================================================
// Inspect and curate the same dictionary the app uses (dictionary.js). By
// default it points at Electron's userData dir so it edits the LIVE file the
// running app reads; override with --dir <path> or LOVEAI_DICT_DIR.
//
//   node tools/dict.js list [category]
//   node tools/dict.js stats [category]
//   node tools/dict.js add <category> <word>
//   node tools/dict.js rm  <category> <word>
//   node tools/dict.js reset [category]
//
// Categories: intent, ui, retrieval, generic. Changes to retrieval/generic take
// effect on the next app start (they are read once at launch).

const path = require('path');
const dict = require('../dictionary');

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf('--dir');
let dir = process.env.LOVEAI_DICT_DIR || null;
if (dirFlag !== -1) { dir = argv[dirFlag + 1]; argv.splice(dirFlag, 2); }

// Best-effort userData resolution matching Electron's default for this app
// (app name "loveai"). Kept simple; override with --dir if your build differs.
if (!dir) {
  if (process.platform === 'win32' && process.env.APPDATA) {
    dir = path.join(process.env.APPDATA, 'loveai');
  } else if (process.platform === 'darwin' && process.env.HOME) {
    dir = path.join(process.env.HOME, 'Library', 'Application Support', 'loveai');
  } else if (process.env.HOME) {
    dir = path.join(process.env.HOME, '.config', 'loveai');
  }
}

const file = dict.init(dir);
const [cmd, a, b] = argv;
const known = dict.categories();

console.log('store: ' + file);

if (cmd === 'list') {
  const cats = a ? [a] : known;
  for (const c of cats) console.log('\n[' + c + ']\n' + dict.words(c).join(' '));
} else if (cmd === 'stats') {
  const cats = a ? [a] : known;
  for (const c of cats) {
    const s = dict.stats(c);
    console.log('\n[' + c + '] active=' + s.activeCount + ' seed=' + s.seedCount +
      ' learned=' + s.learnedCount + ' learnEnabled=' + s.learnEnabled);
    if (s.candidates.length) {
      console.log('  candidates (word:count needs):');
      for (const cd of s.candidates.slice(0, 20)) {
        console.log('   ' + cd.word + ':' + cd.count + ' needs ' + cd.needs);
      }
    }
  }
} else if (cmd === 'add') {
  if (!known.includes(a) || !b) { console.error('usage: add <category> <word>'); process.exit(1); }
  console.log(dict.add(a, b) ? 'added ' + b + ' to ' + a : 'no change');
} else if (cmd === 'rm') {
  if (!known.includes(a) || !b) { console.error('usage: rm <category> <word>'); process.exit(1); }
  console.log(dict.remove(a, b) ? 'removed learned ' + b + ' from ' + a
    : 'not a learned word (seeds cannot be removed)');
} else if (cmd === 'reset') {
  dict.reset(a || null);
  console.log('reset ' + (a || 'ALL categories') + ' to seed');
} else {
  console.log('\ncommands: list [cat] | stats [cat] | add <cat> <word> | ' +
    'rm <cat> <word> | reset [cat]\ncategories: ' + known.join(', '));
}
