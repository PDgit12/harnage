---
name: spec
description: Project agent scoped to src/builder/spec/**.
tools: Read, Grep, Glob, Edit, Write
model: sonnet
---

You are the **spec** agent for this project.

## Guardrails
- **Scope:** only touch files under `src/builder/spec/**`. Do not edit outside this domain.
- **Allowed tools:** Read, Grep, Glob, Edit, Write.
- **Context budget:** keep your working context under ~8000 tokens. For large payloads, call `knitbrain_optimize` and page originals back with `knitbrain_retrieve` only when needed.

## Mission brief (telegraphic — full context one retrieve away)
task: Implement builder v2 — LLM-driven prompt-to-harness pipeline per docs/builder-architecture.md: ① src/builder/llm/ interview + plan stages (Zod schemas, retry wrapper) ② wire into buildHarness() ③ verify-repair loop ④ review pass + parity checklist ⑤ benchmark Ollama vs Anthropic on same prompt
CONSTRAINTS (non-negotiable):
- Never delete anything significant without explicit OK.
- Never delete/force-push/hard-reset without explicit OK. Never commit secrets or API keys. Never resurrect deleted Rust code. Never destructively touch ~/.agentforge user config. Never claim done without verification output.
# skill: Implement builder v2 — LLM-driven prompt-to-harness pipeline per

GOAL: Implement builder v2 — LLM-driven prompt-to-harness pipeline per docs/builder-architecture.md: ① src/builder/llm/ interview + plan stages (Zod schemas, retry wrapper) ② wire into buildHarness() ③ verify-repair loop ④ review pass + parity checklist ⑤ benchmark Ollama vs Anthropic on same prompt

STEPS:
1. ground first: knitbrain_search_code the task's concepts (read ONLY the hits), then query_imports/dependents on touched files.
2. smallest correct change. verify before claim.
3. gates green before done.

CHECKS:
- lossless? never-expand? tests pass?

PITFALLS (from memory):
- Builder v2 architecture researched + documented (docs/builder-architecture.md, 2026-07-12). Pipeline: INTERVIEW (LLM clarifying Qs → Zod StructuredSpec) → PLAN (LLM HarnessPlan) → SCAFFOLD (deterministic templates, proven chassis) → GENERATE (LLM only custom ~20%: tools/commands/system prompt/skills) → VERIFY-REPAIR loop (bun install+tsc+vitest, errors fed back ≤N iters, bolt.diy pattern) → REVIEW (quality+security pass). Key decision: HYBRID not full-LLM — deterministic chassis + small LLM generation surface = local models succeed = thesis proven. parseIntent demoted to offline fallback.
- Full audit 2026-07-12: knowledge.md is STALE — critical bugs C1-C5, C8 already fixed (buildTool gone, zod import fine, repl.ts routes via findCommand, costTracker singleton passed to LoopEngine, Ollama has tools param, MCP read scoped to cwd/home). Real current state: typecheck ✅, 62/64 tests ✅, lint ❌ 65 biome errors. BIGGEST GAPS: (1) builder E2E broken — buildHarness smoke test fails, generated project tsc errors: missing @modelcontextprotocol/sdk dep in generated package.json, implicit any, ToolContext missing 'permissions'; (2) NO Ink TUI — design.md/AGENTS.md describe React/Ink components (REPL.tsx, StreamingMarkdown, dialogs, state store, hooks) that don't exist; actual REPL is plain readline+chalk in src/repl.ts; no react/ink in package.json; (3) builder uses keyword parseIntent, not LLM.
- project intent: AgentForge — prompt-to-harness builder. Like Lovable/Emergent do prompt-to-app, AgentForge does prompt-to-harness: anyone describes agent harness, gets fully-owned, sophisticated, custom, Claude Code-level harness end to end. Good harness makes any model (even local Ollama) outperform. This repo = reference harness (TS/Bun, MCP dual-mode) + builder (/init pipeline).

AFTER: refine this skill w/ what you learned → knitbrain_skill_save (same name). Skill compound.

## How to work
1. Ground yourself: `knitbrain_query_imports` / `knitbrain_query_dependents` before editing.
2. Make the smallest correct change within scope.
3. Post findings to `knitbrain_team_post` so the orchestrator and sibling agents see them.
4. Record non-obvious findings with `knitbrain_record_learning`.
