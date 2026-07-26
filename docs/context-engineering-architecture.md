# Context Engineering Architecture

Date: 2026-07-26 · Status: IMPLEMENTED (phase 1) — see "What changed" below.

Goal: behave as if the model has complete repository knowledge while
transmitting the minimum tokens. Retrieval finds *possible* context; context
engineering decides what *deserves to be sent*. This doc maps the target
pipeline onto the code that implements each stage, so future work extends the
right seam instead of adding a parallel one.

## The pipeline and where each stage lives

| Stage | Implementation | Notes |
| --- | --- | --- |
| Intent detection | `src/retrieval/classifier.js` (`classifyTask`) | Deterministic, synchronous, runs in preload. Task class → inject caps + charBudget. |
| Execution planning | `mcp__deck__execution_plan` gate (main.js `buildDeckServer`) + pipeline PE stage | The model locks root cause + workflow before edits. |
| Repository analysis | BM25 (`retrieve`), vectors (`vectors.js`, per-symbol BGE embeddings), tree-sitter codegraph (`codegraph-parse.js` + main.js `linkEdges`) | Symbol-level units, never folders. |
| Context ranking | `fuseRetrieval` (main.js): RRF over BM25 + vector + **git activity boost** | Git working tree + last 5 commits lift actively-edited files (half weight, boost-only — never injects unrelated files). |
| Context compression | `packSymbols` levels (signature → impl → dep-signature), repo map, topic memory, **assembler trimming** | Lowest sufficient level wins. |
| Prompt assembly | `src/retrieval/assembler.js` (`assembleSections`) via `renderer/app.js` `runAgent` | HARD charBudget ceiling; priority-ordered survival; original append order preserved. |
| Model execution | `agent-run` (main.js): preset `claude_code` system prompt + role rules append + `mcp__deck__*` pull tools | Push a MAP, model PULLS code mid-task. |
| Memory update | topic memory (`.loveai/memory/topics`), **run log** (`.loveai/memory/recent-runs.json`) | Compact per-run records replace transcript replay. |
| Cache update | `fuseCache`, `distillCache`, `intentCache`, `gitActivityCache`, index caches | Keyed on index build stamps / TTL; index rebuilds naturally miss. |

## Core principles encoded in the code

1. **Push a map, pull the code.** Cold runs inject file names + symbol names
   only (never bodies). Implementations are pulled mid-task through
   `mcp__deck__search_code` / `get_symbols` / `who_references`, when the model
   knows what it actually needs. (`docs/context-retrieval-research.md` has the
   evidence for why push-heavy loses.)
2. **Budget is a ceiling, not a hint.** `classifyTask().charBudget`
   (question 6k → architecture 28k chars) is enforced by the assembler:
   sections carry a priority; lowest-priority sections are dropped first,
   oversized ranked lists are trimmed at line boundaries, required directives
   always survive. Warm follow-ups get `min(4000, charBudget)`.
3. **Never send the same fact twice.** Semantic matches are deduped against
   the ranked-file lines (`dedupeSemanticHits`); warm target-file blocks are
   deduped per session (`lastTargets`); warm runs skip every cold inject
   (the transcript already carries them); continue-in-place (no fork) keeps
   prompt-cache hits.
4. **Compress before you cap.** Stale-session restores collapse tool calls to
   one-line markers and keep the semantic turns (user asks, assistant
   conclusions) — the 12k preamble cap now holds ~all real exchanges.
5. **Conversations die; summaries persist.** Each successful run appends a
   compact record (task class, distilled task, files edited, outcome line) to
   `.loveai/memory/recent-runs.json` (capped 30). Cold runs inject the last 3
   as a RECENT WORK section (~300 chars) — cross-session continuity without
   replaying transcripts.
6. **Cache anything deterministic.** Same issue text → one Haiku distill
   (`distillCache` main-side, `intentCache` renderer-side). Same query + same
   index build stamp → one BM25+vector fusion (`fuseCache`, 60s TTL) — covers
   agents re-running identical `search_code` calls and pipeline stages racing
   on one issue. Git activity cached 15s per project.

## Section priority model (renderer `runAgent`)

Priority 1 drops last. Emission keeps append order; priority only decides
survival under the budget.

| id | prio | when | content |
| --- | --- | --- | --- |
| orientation | 1 (required) | cold, map exists | one-line PROJECT-MAP pointer |
| target-files | 1 | warm | per-message ranked files |
| ranked-files | 2 | cold heavy | pre-ranked file names + symbols |
| tools / efficiency | 2 (required) | cold heavy / warm | pull-tool directive + gates |
| impact | 3 | cold | regression blast radius |
| calls-out | 4 | cold heavy | one-hop forward deps |
| topic-memory | 5 | cold | 1–2 matched topic bodies |
| semantic | 6 | cold heavy | vector hits NOT already on ranked lines |
| recent-work | 6 | cold | last 3 compressed run records |
| repo-map | 7 | cold heavy, repoMap classes | dir-level survey (first to shrink) |

## Accounting

- Launch line: `context assembled in Nms · +X.Xk/Yk chars (class budget) ·
  trimmed: … · dropped: …` — real budget accounting, not an FYI delta.
- Per-run: `in / out / cache` token line from the SDK result (high in + low
  cache = scoping regression).
- Retrieval quality: `.loveai/index/retrieval-eval.jsonl` hit@5/hit@10
  (predicted vs actually-edited files). Check `evalStats` before/after tuning
  ranking — the git-activity boost should move hit@k up, not down.

## Explicitly not done (and why)

- **No LLM-summarized conversation compaction** — the SDK's `autoCompact`
  already handles in-session growth; cross-session continuity comes from the
  run log + topic memory at ~zero cost.
- **No whole-file summaries index** — the per-symbol codegraph + repo map
  already cover orientation; file-level summaries would duplicate them.
- **No cross-agent prompt broadcast** — pipeline agents stay FRESH and share
  state through `.loveai/pipeline/*.md` briefs and the run log (structured
  memory, not prompts).

## Future seams

- Confidence-driven expansion: `search_code` could return a confidence score
  so the model knows when to widen (callers → callees → imports) — the
  progressive-expansion ladder is currently the model's judgment.
- Open-tabs / cursor signals: the editor knows the open file set; feeding it
  into `fuseRetrieval` as a fourth RRF list mirrors the git boost.
- Persist `fuseCache` keyed on content hashes for cross-restart reuse.
