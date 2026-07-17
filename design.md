# harnage — Architecture

> **AI Model = Brain. Harness = Hands.** `harnage` for the TUI, `harnage --mcp` for MCP server mode.
> Two brains in this system: the **build brain** (LLM driving `/init`'s interview→plan→generate→
> repair pipeline) and the **runtime brain** (whatever model the generated harness plugs in,
> reconfigured per-model by `ModelProfile`). This repo is both the reference harness (dogfoods its
> own engine) and the builder that generates new ones.

---

## Overview

```
main.tsx (Commander)
  ├── --mcp flag → MCP server (tools, resources, prompts via SDK)
  └── default    → Ink TUI (src/ui/index.tsx + App.tsx), falls back to classic readline REPL (src/repl.ts)
         ├── App(config, engine, branch, resumeState)
         │     ├── <Static> history (user/agent/tool/error/info lines)
         │     ├── streaming text box, active-tool line, live "/command" menu
         │     └── framed ❯ input (ink-text-input)
         └── LoopEngine (AsyncGenerator<StreamEvent>)
               └── Provider (Anthropic | OpenAI | Ollama | OpenRouter)
```

Verified: `src/main.tsx:286` names the CLI `harnage`; `src/ui/index.tsx` renders the Ink `App`
and falls back per `--classic`/piped stdin; `src/ui/App.tsx` has no `StoreProvider`/`ThemeProvider`/
dialog components — those are not implemented (see Gaps).

---

## Two-brain architecture

**Build brain** — `src/builder/llm/*`, invoked only during `/init` (or `buildHarness()` with a
`provider` option). Writes a harness once; not part of the generated harness's runtime.

**Runtime brain** — whatever provider/model the *generated* harness is configured with. The
generated `profiles.ts` resolves that model to a `ModelProfile` (tier, loop mode, tool-calling
mode, tool budget, edit format, prompt budget, decoding params) so the same chassis behaves
differently for a frontier model vs. a 3B local model. See "Engine v3 / ModelProfile" below.

This repo's own `src/loop/LoopEngine.ts` is the reference implementation both brains are modeled on.

---

## LoopEngine (reference harness)

Goal-driven agent loop — state machine, not a bare LLM caller. `src/loop/types.ts` defines
`LoopPhase`: `planning → executing → verifying → checking_goal → adapting → done | failed`.

```
run(goal) → AsyncGenerator<StreamEvent>
  planning      → provider.stream(messages, toolDefs); collect text + tool_uses
  executing     → for each tool_use: checkPermissions → tool.call → append result
  verifying     → provider checks tool results for errors
  checking_goal → provider answers YES/NO; YES → done, NO → adapting
  adapting      → re-plan with failure context, then executing again

resume(state) → AsyncGenerator<StreamEvent>   (restart from a persisted LoopState — src/loop/LoopEngine.ts:94)
getState()    → current LoopState (messages, toolResults, phase)
```

`src/loop/persistence.ts` snapshots `LoopState` to disk; `recoverLastLoop()` is read at TUI
launch (`src/ui/index.tsx:45`) and handed to `App` as `resumeState`, which `App.tsx:127-137`
auto-resumes via `engine.resume(resumeState)` on mount — mid-task resume after a crash or
interrupted run, not just a fresh session replay.

`src/loop/safety.ts` enforces rails (max iterations, max wall time); `src/loop/context.ts` does
compaction/summarization; `src/loop/sandbox.ts` runs Bash via `Bun.spawn` with a command/path
blocklist (application-level only — no OS container).

---

## Tool system

9 tools, lazily loaded via `getAllTools()` (`src/tools.ts`): Bash (sandboxed), FileRead, FileEdit,
FileWrite, Glob, Grep, WebFetch, WebSearch, Agent (spawns a sub-agent — same `LoopEngine`, fresh
transcript, restricted tool set).

Permissions (`src/permissions.ts`): `PermissionContext` modes `default | plan | auto | bypass`,
plus path-glob `rules` (`"bash(bun *)"` → allow/deny) loaded from `~/.harnage/permissions.json`.
No policy file present → defaults to `bypass` (current reference-harness behavior); writing a
policy file is how a user opts in to enforcement.

---

## Provider system

`createProvider(config)` in `src/services/api/client.ts` selects by `config.type`. Each provider
implements `Provider.stream(messages, tools?) → AsyncGenerator<StreamEvent>`.

| Provider | File |
|----------|------|
| `anthropic` | `src/services/api/providers/AnthropicProvider.ts` |
| `openai` | `src/services/api/providers/OpenAIProvider.ts` |
| `openrouter` | `src/services/api/providers/OpenRouterProvider.ts` |
| `ollama` | `src/services/api/providers/OllamaProvider.ts` (plain fetch, no SDK) |

`FallbackProvider` (`src/services/api/client.ts:58`) wraps a chain for automatic failover.

---

## Builder — LLM-driven pipeline

`buildHarness(prompt, cwd?, onProgress?, options)` in `src/builder/index.ts`:

```
1. INTERVIEW (LLM, src/builder/llm/interview.ts::runInterview)
     clarifying questions (≤3, ready:false → ask via `ask` callback or use defaults)
     → validated LLMSpec (Zod: SpecSchema)
2. PLAN (LLM, src/builder/llm/plan.ts::runLLMPlan)
     a. CORE call  → name, description, tools, commands, systemPrompt, config
        (one small JSON object every build brain — even a weak local model — can produce)
     b. enrichment calls, fired in PARALLEL, each best-effort (failure just skips it):
        - pipeline stages (small-model tier fixed pipeline, ≤6 stages)
        - customCommands (≤4 bespoke slash commands)
        - customSkills (≤3 procedural-memory recipes)
        empty-array enrichment responses get one bounded retry (src/builder/llm/plan.ts:168,195)
3. GENERATE (LLM, src/builder/llm/generate.ts)
     runGenerate() writes real TS modules for spec.customTools (in parallel; a tool that
     never validates aborts the build — tools are load-bearing, not best-effort)
     runGenerateCommands() writes real TS modules for plan.customCommands
4. ASSEMBLE (deterministic, src/builder/assemble/index.ts::assembleAndVerify)
     writes package.json/tsconfig/main.tsx/Tool.ts/tools.ts/commands.ts/provider.ts,
     plus harness subsystems from src/builder/assemble/harness-templates.ts:
     profiles.ts, pipeline.ts, engine.ts, compaction.ts, memory.ts, eval.ts, trace.ts,
     permissions.ts, skills.ts, session.ts, subagent.ts, ui.tsx (Ink TUI)
5. VERIFY (verifyBuild: bun install + bun run typecheck)
6. REPAIR (LLM, src/builder/llm/repair.ts::repairLoop, ≤ options.maxRepairs, default 2)
     feeds tsc errors + implicated file contents back to the LLM, applies full-file
     patches (path-confined to outputDir), re-verifies; gives up cleanly if a repair
     attempt produces no valid patch
```

No `provider` option (offline) → falls back to keyword `parseIntent` + deterministic
`generatePlan` (`src/builder/index.ts:70-106`), skipping stages 1-3 and 6.

Local-model packing: if the spec includes `ollama`, `buildHarness` probes
`localhost:11434/api/tags` + `/api/show` (capability check for `tools`), then either asks
the user to pick from `recommendModels()` (interactive) or auto-picks the largest installed
model that fits `maxParamsForRam()` (non-interactive). The chosen model's `catalogOverrides()`
(`src/builder/models/catalog.ts`) are baked into `profiles.ts` as per-model tuning on top of
the size-tier default.

---

## Model catalog & tiers (`src/builder/models/catalog.ts`)

Two layers: (1) a curated shortlist of proven local tool-callers (Qwen-heavy — `CATALOG` array,
each entry with `id`, `params`, `ramGb`, `domains`, optional `profileOverrides`); (2)
family/size inference (`classifyDomain`, `maxParamsForRam`) for any model not in the shortlist —
recommend-not-restrict, nothing is excluded.

`recommendModels(domain, ramGb, installedNames)` ranks the shortlist for a work type
(`code | data | docs | review | general`) and RAM budget, marking `[installed]` vs.
`[run: ollama pull <id>]`.

---

## Engine v3 / ModelProfile (generated harness, `HARNESS_PROFILES` template)

Every generated harness ships a `profiles.ts` that resolves the configured model to a
`ModelProfile` at runtime (`src/builder/assemble/harness-templates.ts:10-70`):

```ts
interface ModelProfile {
  tier: "frontier" | "strong" | "mid" | "small";
  loop: "free" | "plan-act" | "pipeline";
  toolCalling: "native" | "constrained-json";
  maxTools: number;
  editFormat: "search-replace" | "whole-file";
  systemPromptBudget: number;
  temperature: number;
  repeatPenalty?: number;
  nudge: boolean;
  contextTokens: number;
}
```

`resolveBase(model)` matches, in order: frontier hosted models (claude/gpt-4+/o1/o3/gemini) →
free native-tool loop; ≥13B local → free native-tool loop; ≤3.5B (or phi/tinyllama/gemma:2b/
llama3.2) → fixed `pipeline` loop + `constrained-json` dispatch + 4-tool budget; else (7-8B,
unknown) → `plan-act` + `constrained-json`. Per-model `profileOverrides` from the catalog are
merged on top. The builder's PLAN stage bakes the domain-specific `pipeline` stages
(`plan.pipeline`, ≤6 steps) that the `pipeline` loop mode executes — a 3B model fills slots in a
build-time-known pipeline instead of free-loop reasoning about tool choice.

---

## Memory (generated harness, `HARNESS_MEMORY` + related templates)

Four tiers, matching the market taxonomy:

- **Semantic** (durable facts) + **episodic** (dated events) — local `bun:sqlite` at
  `~/.<name>/memory.db` (`src/memory.ts`, class `MemoryStore`). `saveFact`/`saveEvent` write;
  `recall(query)` is a **deterministic keyword-overlap retrieval gate** — an empty match IS the
  decision to skip retrieval, so no model call is ever spent on that meta-decision. Disabled via
  `HARNAGE_MEMORY=off`; off for sub-agents (`persistSession` gate).
- **Procedural** — the skills system (`skills/*.md`, `HARNESS_SKILLS` + `plan.customSkills`
  rendered by `assembleAndVerify`).
- **Working** — context compaction (`HARNESS_COMPACTION` → `src/compaction.ts`): summarizes
  older messages into one system note once `estimateTokens()` exceeds a threshold, keeping the
  most recent `keepRecent` messages verbatim.

Nothing leaves the machine — documented in the generated `SECURITY.md`.

---

## Eval-in-loop (generated harness, `HARNESS_EVAL` → `src/eval.ts`)

`runDeterministicEvals(goal, answer, messages, toolCount)` — cheap, no model call: non-empty
answer, didn't stop on error, isn't a raw JSON/blob dump, used a tool when tools were available.
Opt-in LLM-as-judge (`HARNAGE_JUDGE=on`) via `judgeRequest`/`parseJudgeScore` scores 1-5. Results
log to the audit trail; `trace.ts` (`HARNESS_TRACE`) summarizes runs/latency/tool calls/eval
pass rate via a generated `trace` command — terminal-first LLMops, no external service.

---

## Session persistence & resume (generated harness, `HARNESS_SESSION`)

`saveSession(messages, {goal, done})` / `loadSession()` at `~/.<name>/session.json` (last 200
messages). `done: false` on save means a run was in flight when it last saved — the generated
`main.tsx --resume` path (mirrors the reference harness's `recoverLastLoop`) can detect and
offer to continue an unfinished task, not just replay history.

---

## Permission system (generated harness, `HARNESS_PERMISSIONS`)

Same shape as the reference harness's `src/permissions.ts`, generated per-project: modes
`default | plan | auto | bypass`, path-glob rules in `~/.<name>/permissions.json`, `checkPermission`
matches tool name + a `targetOf(input)` extraction (path/file_path/command/url/pattern) against
rule patterns.

---

## Reference-harness TUI vs. generated-harness TUI

Both use Ink 5 + React 18 + `ink-text-input`. Reference: `src/ui/App.tsx` (277 lines) — no theme
system, no dialog overlays; permission denials surface as tool results the model adapts to.
Generated: `GENERATED_TUI` template in `harness-templates.ts` (same shape, baked with the plan's
name/model/commands).

---

## Command-center orchestration

Not code in this repo — a Claude Code *skill* (`command-center`) for turning a session into an
orchestrator that spawns real Claude Code sessions in tmux (one per workstream, its own git
worktree), prompts/monitors/collects their reports. Used to run the multi-worker docs/build/qa
split this repo's own development uses; not part of the `harnage` runtime.

---

## Cost tracking

`CostTracker` (`src/cost-tracker.ts`): per-session `promptTokens`/`completionTokens`/`cost`,
cumulative `allTimeCost`/`allTimeTokens`, per-model pricing table, `recordUsage()`,
`checkBudget(ceilingUsd)`.

---

## MCP integration

Dual-mode: `harnage --mcp` exposes the 9 tools + resources (project files, config, state) +
prompts via `StdioServerTransport` (`src/main.tsx`). Consuming side: `McpClientManager`
(`src/services/mcp/`) connects to external MCP servers (stdio or Streamable HTTP) and wraps
their tools as internal `Tool` instances.

---

## Persistence layout

```
~/.harnage/
├── config.json       ← provider configuration
├── permissions.json  ← permission policy (absent = bypass)
├── state.json        ← messages + settings (debounced writes)
```

Generated harnesses mirror this under `~/.<name>/` plus `memory.db` and `session.json`.

---

## Gaps

- **Interactive permission prompts**: no TUI dialog to approve/deny a denied call and remember
  the rule, in either reference or generated harnesses — denials surface as tool-result text.
- **Sandbox depth**: command/path blocklist only; no OS-level container (Docker/gVisor) for
  untrusted code execution.
- **Memory recall**: exact-substring keyword match, no stemming (e.g. "games" won't match a
  stored "game").
- **Competitor benchmark**: `scripts/bench-*.ts` exist for internal profile tuning; no published
  head-to-head vs. Claude Code / Codex CLI / OpenCode yet.

---

## Dependencies

```
react ^18        ink ^5.2.1       ink-text-input   yoga-layout (ink dependency)
commander ^15    chalk ^5.6.2     zod ^4
@anthropic-ai/sdk  openai          @modelcontextprotocol/sdk
bun:sqlite (built-in, generated-harness memory)
vitest ^4        biome (lint)     typescript ^5
```
