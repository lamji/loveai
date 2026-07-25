// Deterministic task classifier → adaptive retrieval budget.
// Pure + synchronous (required: preload.js calls it directly, no IPC).
// Classifies a request into a task class so a tiny question injects a lean
// context (few files, no repo map, one-line tool hint) while a feature or
// architecture task still gets the full front-load.
//
// Consumers and the fields they read:
// - renderer/app.js runAgent(): task.type (log line), task.inject
//   { files, semantic, repoMap, repoMapDirs, tools: 'full'|'lean' }
// - main.js buildPlanContext(): task.type, task.charBudget, task.tokenBudget

const CLASSES = {
  question: {
    // "what does X do?", "is it failed?" — no edit intended; the agent can
    // still pull code via mcp__deck__* tools, so keep the push tiny.
    inject: { files: 5, semantic: 4, repoMap: false, repoMapDirs: 0, tools: 'lean' },
    charBudget: 6000
  },
  config: {
    // config/docs/typo/copy tweaks — target files say it all
    inject: { files: 6, semantic: 4, repoMap: false, repoMapDirs: 0, tools: 'lean' },
    charBudget: 6000
  },
  bugfix: {
    // targeted fix — ranked files + impact matter, whole-repo survey doesn't
    inject: { files: 8, semantic: 6, repoMap: false, repoMapDirs: 0, tools: 'lean' },
    charBudget: 12000
  },
  refactor: {
    inject: { files: 10, semantic: 8, repoMap: true, repoMapDirs: 12, tools: 'full' },
    charBudget: 16000
  },
  feature: {
    inject: { files: 12, semantic: 10, repoMap: true, repoMapDirs: 20, tools: 'full' },
    charBudget: 20000
  },
  architecture: {
    inject: { files: 12, semantic: 12, repoMap: true, repoMapDirs: 30, tools: 'full' },
    charBudget: 28000
  },
  // unmatched prompts: middle ground, never the max
  general: {
    inject: { files: 10, semantic: 8, repoMap: true, repoMapDirs: 12, tools: 'lean' },
    charBudget: 12000
  }
};

const RE = {
  architecture: /\b(architect|re-?architect|redesign|migrat\w+|monorepo|multi-?tenan|overhaul|rewrite (the )?(app|system|backend|frontend)|system-?wide|across the (whole|entire)|restructur)/i,
  feature: /\b(add|implement|create|build|introduce|support|new (feature|page|screen|view|endpoint|component|modal|tab|panel)|integrat\w+)\b/i,
  refactor: /\b(refactor|clean ?up|extract|deduplicate|simplif\w+|reorganiz\w+|split (up|into)|consolidat\w+|dead code)\b/i,
  bugfix: /\b(fix|bug|broken|crash|error|exception|fail(s|ed|ing)?|not work\w*|doesn'?t work|wrong|stuck|hang(s|ing)?|freez\w+|regression|leak|undefined|NaN|null)\b/i,
  config: /\b(typo|readme|docs?|comment|rename|config|\.env|settings?\.json|package\.json|gitignore|changelog|label|wording|text change)\b/i,
  editVerb: /\b(fix|add|implement|create|build|change|update|refactor|remove|delete|rename|make|set|adjust|move|replace|improve|redesign)\b/i,
  questionStart: /^\s*(what|why|how|where|when|which|who|is|are|was|does|do|did|can|could|should|would|explain|tell me)\b/i
};

function classifyType(text) {
  // order matters: the heaviest signals win, question only when nothing
  // suggests an edit (a "?" alone doesn't make a request read-only)
  if (RE.architecture.test(text)) return 'architecture';
  const asksOnly = (RE.questionStart.test(text) || /\?\s*$/.test(text))
    && !RE.editVerb.test(text);
  if (asksOnly) return 'question';
  if (RE.bugfix.test(text)) return 'bugfix';
  if (RE.refactor.test(text)) return 'refactor';
  if (RE.feature.test(text)) return 'feature';
  if (RE.config.test(text)) return 'config';
  if (RE.questionStart.test(text) || /\?/.test(text)) return 'question';
  return 'general';
}

function classifyTask(issue) {
  const text = String(issue || '').slice(0, 4000);
  const type = text.trim() ? classifyType(text) : 'general';
  const c = CLASSES[type] || CLASSES.general;
  return {
    type,
    inject: { ...c.inject },
    charBudget: c.charBudget,
    tokenBudget: Math.round(c.charBudget / 4)
  };
}

module.exports = { classifyTask };
