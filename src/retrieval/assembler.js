// Budgeted context assembler — the single gate every injected prompt section
// passes through before it reaches the model. Pure + synchronous (like
// classifier.js: preload exposes it directly, no IPC).
//
// The classifier decides HOW MUCH context a task class deserves
// (task.charBudget); until now that number was only used by main.js
// buildPlanContext, while the renderer capped by item COUNTS and could still
// assemble an oversized prompt. This module makes the char budget a hard
// ceiling: sections are kept lowest-priority-dropped-first, oversized
// trimmable sections are cut at line boundaries, and the caller gets real
// accounting (chars used / budget / what was trimmed or dropped) instead of
// an informational char delta.
//
// Section shape:
//   { id: 'ranked-files',      // stable name, used in accounting + logs
//     text: '\n\nSECTION...',  // exact string that would be appended
//     priority: 2,             // 1 = most important; higher = dropped first
//     required: false,         // always kept (still counted against budget)
//     trimmable: true,         // may be cut at line boundaries to fit
//     minLines: 3 }            // below this many surviving lines → drop
//
// assembleSections(sections, charBudget) →
//   { text, chars, budget, included: [{id, chars, trimmed}], dropped: [id] }
//
// Output preserves the caller's ORIGINAL section order (append semantics are
// part of the prompt design); priority only decides what survives.

const TRIM_NOTE = (n) => `\n… (+${n} lines trimmed for context budget)`;

function trimToFit(text, maxChars, minLines) {
  // keep whole lines from the top (header + highest-ranked entries first);
  // ranked sections put their best hits first, so a top cut keeps the signal
  const lines = String(text).split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  const cut = lines.length - kept.length;
  if (cut <= 0) return { text, cut: 0 };
  // count only content lines (non-empty, non-header-ish) toward the floor
  const contentKept = kept.filter(l => /^\s*[-\w]/.test(l)).length;
  if (contentKept < (minLines || 3)) return null;   // too little left → drop
  return { text: kept.join('\n') + TRIM_NOTE(cut), cut };
}

function assembleSections(sections, charBudget) {
  const budget = Math.max(0, Number(charBudget) || 0);
  const live = (sections || [])
    .map((s, i) => ({ ...s, order: i }))
    .filter(s => s && typeof s.text === 'string' && s.text.trim());

  // decide survivors: required first, then priority (ties: original order)
  const byImportance = [...live].sort((a, b) =>
    (b.required === true) - (a.required === true)
    || (a.priority || 5) - (b.priority || 5)
    || a.order - b.order);

  let remaining = budget;
  const kept = new Map();     // order -> final text
  const included = [];
  const dropped = [];

  for (const s of byImportance) {
    const len = s.text.length;
    if (len <= remaining || (s.required && budget === 0)) {
      kept.set(s.order, s.text);
      included.push({ id: s.id, chars: len, trimmed: false });
      remaining -= len;
      continue;
    }
    if (s.required) {
      // required never drops: trim if possible, else keep whole (overrun is
      // the caller's bug to see in accounting, not silently lose the section)
      const t = s.trimmable ? trimToFit(s.text, remaining, s.minLines) : null;
      const finalText = t ? t.text : s.text;
      kept.set(s.order, finalText);
      included.push({ id: s.id, chars: finalText.length, trimmed: !!t });
      remaining = Math.max(0, remaining - finalText.length);
      continue;
    }
    if (s.trimmable && remaining > 200) {
      const t = trimToFit(s.text, remaining, s.minLines);
      if (t) {
        kept.set(s.order, t.text);
        included.push({ id: s.id, chars: t.text.length, trimmed: true });
        remaining -= t.text.length;
        continue;
      }
    }
    dropped.push(s.id);
  }

  // emit in the caller's original append order
  const text = live
    .filter(s => kept.has(s.order))
    .sort((a, b) => a.order - b.order)
    .map(s => kept.get(s.order))
    .join('');

  return { text, chars: text.length, budget, included, dropped };
}

// Cross-section dedupe helper: drop vector hits whose file+symbol are already
// visible on the ranked-files lines. The semantic block then only carries NEW
// information (symbols the lexical list missed), instead of restating the
// ranked list with scores attached.
function dedupeSemanticHits(vhits, rankedFiles) {
  const shownSyms = new Set();
  for (const f of rankedFiles || []) {
    for (const s of (f.symbols || [])) shownSyms.add(`${f.rel}#${s}`);
  }
  return (vhits || []).filter(h => !shownSyms.has(h.id));
}

module.exports = { assembleSections, dedupeSemanticHits };
