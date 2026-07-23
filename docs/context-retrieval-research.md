# Research: Fast context gathering for agents — push vs pull, and custom tools

Date: 2026-07-23 · Status: RESEARCH ONLY, nothing applied.

## The question

Agents in this app take noticeably longer to "get context" than plain Claude
Code, despite using the same SDK and the same underlying tools. Is there a
faster way? Do we need a custom tool?

## What we do today (PUSH model)

On every cold run the renderer pre-computes and INJECTS context into the
first prompt before the agent even spawns:

- BM25 lexical ranking (`retrieveContext`) → pre-ranked file list + inlined
  file contents (up to ~6k chars)
- Vector RAG (`vectorQuery`) → semantic matches list
- Tree-sitter symbol pack (`retrieveSymbols`) → ~12k chars of symbols + deps
- Topic memory, regression impact, orientation hint
- Warm runs: a lighter per-message retrieval trio

Recent fixes (parallel kickoff, tighter timeouts) cut the pre-spawn stall
from ~38s worst case to ~3.5s. But the architecture is still **push**: we
guess what the model needs from the raw prompt text, before the model has
reasoned at all.

## Why push is structurally slow/wasteful

1. **The query is worst at t=0.** Retrieval is keyed on the user's prompt
   ("fix this test ∫ And I submit the Card…") — before anyone knows which
   files matter. Observed result: junk hits, and the agent re-greps anyway
   (we watched it do exactly this on the payments test).
2. **Tokens are paid even when wrong.** ~12k injected chars ride the first
   request and get replayed by the cache on every later turn.
3. **One-shot.** Mid-task, when the model finally knows it needs
   `PaymentsPage.ts`'s modal selectors, our index can't be asked again —
   the model falls back to manual grep loops.
4. Industry data points the same way: Claude Code's agentic (pull) search
   used ~5.5x fewer tokens than embedding-push retrieval for identical
   tasks in independent testing.

## What the field converged on (2025–2026)

| System | Strategy | Takeaway for us |
| --- | --- | --- |
| **Claude Code** | No index. Pure agentic pull: Grep/Glob/Read as the model reasons. | Precise + always fresh; multi-turn but token-cheap. Our injected blob competes with — and loses to — the model just searching. |
| **Aider** | Tiny **repo map**: tree-sitter symbol graph + PageRank, budgeted to ~1k tokens. Map only, never file contents. | Push a MAP, not code. Their benchmarks: ranked map beats naive file inclusion on edit accuracy. Our `PROJECT-MAP.md` idea is right; our 12k content dump is not. |
| **Cursor** | Embeddings index + grep, **agent chooses per query** (exact → grep, conceptual → semantic). | Semantic search is a TOOL the agent picks, not a pre-injection. |
| **2026 consensus ("agentic RAG")** | Give the agent retrieval tools; let it decide what and when to retrieve. Exploration ideally in a separate context (subagent) — main-context clutter degrades performance ~30%. | The index we built stays valuable — its delivery mechanism is what's wrong. |

## Is a custom tool needed? — Yes, and the SDK makes it nearly free

The Claude Agent SDK supports **in-process MCP servers**
(`createSdkMcpServer` + `tool()` in `@anthropic-ai/claude-agent-sdk`):
plain async functions registered at `query()` time, running inside main.js
— no separate process, no network hop. Passed via `options.mcpServers`,
allowed via `allowedTools: ["mcp__deck__*"]`. With `readOnlyHint: true`
the model can call them in parallel with other reads. Tool schemas are
deferred by default (tool search), so they cost ~no context until used.

### Proposed tool surface (wraps what we already built — no new infra)

```
mcp__deck__search_code(query, k?)     → hybrid BM25 + vector hits
                                        [{file, symbol, score, snippet}]
mcp__deck__get_symbols(query|file)    → tree-sitter symbol pack slice
mcp__deck__who_references(symbol)     → regression blast-radius (code graph)
mcp__deck__topic_memory(query)        → .loveai/memory topic bodies
```

Handlers call the same main-process functions the renderer IPC uses today
(`retrieveContext`, `vectorQuery`, `retrieveSymbols`, `regressionImpact`).
The difference: the MODEL composes the query mid-task, with full knowledge
of what it's actually looking for — and can call again as understanding
deepens.

## Recommended target architecture

1. **Shrink the push to an Aider-style map** (~1–1.5k tokens): ranked file
   list + top symbols only. Drop whole-file inlining and the 12k symbol
   pack from the first prompt.
2. **Move heavy retrieval behind in-process custom tools** (list above).
   Rules text tells the agent: "search_code/get_symbols are indexed and
   instant — prefer them over Grep for discovery; use Grep/Read to verify."
3. **Persistent session per chat** (already proposed separately): keeps the
   process + prompt cache warm; follow-ups start in ~0s. This pairs with
   pull retrieval — a warm session + callable index is exactly the Claude
   Code feel, plus semantic search Claude Code doesn't have.
4. Optional later: exploration subagent so long searches don't pollute the
   implementing agent's context.

### Expected effect

- First-token latency: no 12k-char first prompt → faster TTFT; pre-spawn
  prep becomes negligible (map read is ms).
- Tokens: pay for retrieval only when the model asks (Claude Code's 5.5x
  advantage came from exactly this).
- Accuracy: mid-task queries ("card modal selector in PaymentsPage") beat
  t=0 prompt-keyed queries — fewer manual grep loops, fewer turns.

### Costs / risks

- Custom tools live in `query()` options → main.js change (app restart to
  take effect; renderer untouched).
- Weaker models may under-use tools; the rules nudge + keeping the small
  map mitigates.
- The vector index still needs to be built/warm to be useful — unchanged.

## Sources

- [Claude Code doesn't index your codebase — what it does instead](https://vadim.blog/claude-code-no-indexing/)
- [RAG is not always the answer: how agents search code in 2026](https://dev.to/nimay_04/rag-is-not-always-the-answer-anymore-how-ai-agents-search-code-in-2026-43m3)
- [Morph — Agentic search: how coding agents find the right code](https://www.morphllm.com/agentic-search)
- [Milvus — Against grep-only retrieval (the counter-argument)](https://milvus.io/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens.md)
- [Aider — Building a better repository map with tree-sitter](https://aider.chat/2023/10/22/repomap.html)
- [Aider repo-map internals (PageRank, 10x/50x boosts, token budget)](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system)
- [Claude Code vs Cursor on large codebases (token/speed data)](https://www.tunedtools.com/blog/claude-code-vs-cursor-large-codebases)
- [Claude Agent SDK — custom in-process tools (createSdkMcpServer)](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [RAG vs agentic RAG for code](https://explainx.ai/blog/rag-vs-agentic-rag-pageindex-2026)
