# knowledge.md — harnage System Audit (current)

> Rewritten 2026-07-17 to replace a 2026-07-11 audit that predated the LLM-driven builder
> pipeline, Ink TUI, model profiles, memory/eval/trace subsystems, and permission system — none
> of the files that audit cited (`src/components/REPL.tsx`, `src/hooks/`, `src/state/`) exist
> anymore. This version reflects the codebase as of the `cc/docs` branch. Verify against code
> before acting — this is a snapshot, not a promise.

---

## What actually exists (verified against source)

- **Reference harness** (`src/`): Ink TUI (`src/ui/App.tsx` + `index.tsx`) with classic-readline
  fallback (`src/repl.ts`), `LoopEngine` state machine (`src/loop/LoopEngine.ts`), 9 tools
  (`src/tools.ts`), 4 providers (`src/services/api/providers/`), path-rule permissions
  (`src/permissions.ts`, defaults to `bypass` when no policy file exists), MCP dual-mode
  (`src/main.tsx`).
- **Builder** (`src/builder/`): LLM pipeline `interview → plan → generate → assemble → verify →
  repair` (`src/builder/index.ts::buildHarness`), keyword `parseIntent`/`generatePlan` fallback
  when no LLM provider is configured, model catalog + tiering (`src/builder/models/catalog.ts`).
- **Generated-harness templates** (`src/builder/assemble/harness-templates.ts`): `ModelProfile`
  (Engine v3), 3-stage memory+skills+compaction, eval-in-loop, trace/LLMops command, session
  resume, permissions, sub-agent tool, Ink TUI — one template constant per subsystem, each
  written by `assembleAndVerify`.
- 30 test files under `tests/` (not "8 suites" — see below).

---

## Known real gaps (as of this writing)

### G1. No interactive permission-approval UI
Neither the reference harness (`src/ui/App.tsx`) nor the generated TUI template renders a
permission-approval dialog. A denied call surfaces as a tool-result string the model has to
interpret; there's no "always allow this pattern" UX loop. Confirmed by grep: no dialog
component exists in `src/ui/`.

### G2. Sandbox is a blocklist, not a container
`src/loop/sandbox.ts` runs Bash via `Bun.spawn` with a command blocklist, a `NETWORK_COMMANDS`
set gated by `allowNetwork`, and blocked write paths — application-level policy only, no OS-level
isolation (no Docker/gVisor/Firecracker). A determined prompt injection could still reach the
host shell through an unblocked binary.

### G3. Memory recall has no stemming
`MemoryStore.recall()` (`HARNESS_MEMORY` template) does exact-substring `LIKE '%word%'` matching.
"games" will not match a stored "game". Documented as a known limitation, not yet fixed.

### G4. No published competitor benchmark
`scripts/bench-profile.ts`, `bench-archetype.ts`, `bench-editformat.ts`, `egress-check.ts` exist
and are used for internal profile tuning (per-model pass/latency), but there is no published
head-to-head run against Claude Code / Codex CLI / OpenCode.

### G5. CLAUDE.md test-runner claim is stale
`CLAUDE.md` says "vitest, 8 suites"; `tests/` currently has 30 `*.test.ts` files. Not fixing here
(CLAUDE.md is out of scope for this pass) — flagged for whoever owns that file next. See the
docs-worker report for the proposed one-line fix.

### G6. Egress/sovereignty claims are self-checked, not independently audited
`scripts/egress-check.ts` builds a harness and checks it doesn't reach the network by default;
this is the project's own tooling verifying its own claim, not a third-party audit. Fine for a
sovereign-by-design pitch, but worth stating precisely rather than as a blanket guarantee.

---

## Resolved since the 2026-07-11 audit (do not re-report these)

Builder module exists and works (LLM pipeline, not "recursive AgentForge duplication" — it
generates a different, smaller project, not a copy of this repo). Ink TUI exists in both
reference and generated harnesses. `findCommand()`-routed command dispatch exists
(`src/commands.ts`, `src/ui/App.tsx::handleCommand`). Ollama provider supports tool calling
(`OllamaProvider.ts`, `/api/show` capability probe in `src/builder/index.ts`). Session/loop
resume is wired (`recoverLastLoop` → `App`'s `resumeState` → `engine.resume`), not dead code.
Cost tracking, memory, eval, and trace all ship in every generated harness (previous audit
predates all four).

---

## How to keep this file honest

Don't hand-author a new "top 10 findings" list from memory. Run a real audit pass (grep + read,
or the `/review`/`/investigate` skills) before adding entries here, and cite `file:line` for every
claim, same as above.
