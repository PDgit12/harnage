# LLM-Driven Builder — Architecture (as-built)

> Originally researched 2026-07-12 as a replacement for keyword `parseIntent` (synthesis of
> Lovable, Emergent, bolt.diy, OpenHarness, ruflo). The pipeline below is now implemented and
> live in `src/builder/`; this doc has been updated from "proposed" to "as-built" — every stage
> cites the file that runs it. See [design.md](../design.md) for how the builder fits the rest
> of the system (two-brain architecture, model profiles, memory/eval).

## Design thesis (why this shape)

1. **Hybrid, not full-LLM.** Lovable/bolt LLM-generate everything — works great with frontier
   models, flaky with local ones. harnage's thesis is local-model efficiency: a deterministic
   chassis (already-verified template code, `src/builder/assemble/harness-templates.ts`) plus LLM
   generation only for the custom surface (tools, commands, system prompt, domain
   pipeline/skills). Smaller generation surface = smaller model succeeds.
2. **Verify-repair loop is the core**, not one-shot generation (bolt.diy pattern) —
   `src/builder/llm/repair.ts::repairLoop`.
3. **Provider-agnostic.** The same `Provider` interface (Anthropic/OpenAI/Ollama/OpenRouter)
   drives every builder stage; Ollama is the thesis demo.
4. **Structured output enforcement everywhere.** Every LLM call goes through `completeJSON()`
   (`src/builder/llm/client.ts`) against a Zod schema; malformed output gets re-prompted.
5. **Keyword `parseIntent` is the offline fallback**, not deleted — used when `buildHarness()` is
   called without a `provider` (`src/builder/index.ts:234-238`).

## The pipeline (`buildHarness()`, `src/builder/index.ts`)

```
prompt
  │
  ▼
1. INTERVIEW  (src/builder/llm/interview.ts::runInterview)
  │   LLM asks ≤3 clarifying questions (skipped if request is already specific enough);
  │   answered via the `ask` callback (interactive /init) or their own default answers.
  │   Output: LLMSpec — Zod-validated (SpecSchema).
  ▼
2. PLAN  (src/builder/llm/plan.ts::runLLMPlan)
  │   a. CORE call: name, description, tools, commands, systemPrompt, config
  │      (one JSON object sized for a weak local build brain to nail in one shot)
  │   b. enrichment, fired in PARALLEL (independent calls, best-effort):
  │        - pipeline stages (≤6, for the small-model fixed-pipeline loop mode)
  │        - customCommands (≤4 bespoke slash commands)
  │        - customSkills (≤3 procedural-memory recipes)
  │      An empty-array enrichment response gets one bounded retry before being
  │      accepted as "none" (plan.ts:168-173, 195-200) — a weak model's first answer
  │      is sometimes an empty list it will fill in on a second, more insistent ask.
  │   Deterministic post-processing enforces invariants the model can't be trusted
  │   with: tool allowlist intersection, name sanitization, command id normalization.
  ▼
3. GENERATE  (src/builder/llm/generate.ts)
  │   runGenerate(): real TS modules for spec.customTools, one LLM call per tool, in
  │      parallel. A tool that never validates against its schema throws and aborts
  │      the build — generated tools are load-bearing, not best-effort.
  │   runGenerateCommands(): same pattern for plan.customCommands.
  ▼
4. ASSEMBLE  (src/builder/assemble/index.ts::assembleAndVerify — deterministic, no LLM)
  │   Writes package.json/tsconfig/main.tsx/Tool.ts/tools.ts/commands.ts/provider.ts
  │   plus every harness subsystem template: profiles.ts (ModelProfile), pipeline.ts,
  │   engine.ts, compaction.ts, memory.ts, eval.ts, trace.ts, permissions.ts, skills.ts,
  │   session.ts, subagent.ts, ui.tsx — from harness-templates.ts. LLM-GENERATE-stage
  │   files (step 3) are merged in, path-confined to the output src/ dir.
  ▼
5. VERIFY  (assembleAndVerify → verifyBuild: bun install + bun run typecheck)
  ▼
6. REPAIR  (src/builder/llm/repair.ts::repairLoop, ≤ options.maxRepairs, default 2)
      Feeds tsc errors + the implicated file contents (path-safety enforced, capped at
      ~12KB to fit small-model context windows) back to the LLM; applies full-file
      patches; re-verifies. Gives up cleanly (keeps last-good state) if a repair
      attempt produces no valid patch.
  ▼
owned harness (compiles; user's generated code, not a copy of harnage)
```

No `REVIEW` stage (a proposed quality/security pass over generated code) is implemented — see
Gaps.

## What generated harnesses actually contain (verified checklist)

Confirmed by `assembleAndVerify`'s write list: `LoopEngine`-equivalent `engine.ts` with
`ModelProfile` resolution, 9-tool-equivalent `tools.ts`, permissions (modes + path rules),
sandboxed bash, MCP dual-mode (`main.tsx`), slash commands (`commands.ts` + any LLM-generated
custom ones), skills-as-markdown (`skills/`), session persistence + resume (`session.ts`), cost
tracking (baked into `engine.ts`/`trace.ts`), context compaction (`compaction.ts`), four-tier
memory (`memory.ts`), eval-in-loop (`eval.ts`), local audit trail + `trace` command
(`trace.ts`). Ink TUI (`ui.tsx`) ships by default (not gated behind a spec flag).

## Model-aware packing (`src/builder/index.ts:242-336`)

If the spec includes `ollama`, the builder probes `localhost:11434/api/tags` then `/api/show`
per candidate model (filters out embedders/vision models, requires `capabilities: ["tools"]` —
tool-calling is a hard requirement, not best-effort). Interactive mode offers a curated menu from
`recommendModels()` (`src/builder/models/catalog.ts`); non-interactive mode auto-picks the
largest installed model that fits `maxParamsForRam()`. The chosen model's `catalogOverrides()`
are baked into `profiles.ts` as `plan.modelProfileOverrides`.

## Gaps vs. the original research plan

- **No dedicated REVIEW/security pass.** The original design called for a quality+security LLM
  pass over generated custom code before shipping; this stage does not exist — repair only fixes
  compile errors, not security issues in generated tool/command code.
- **No template-parity assertion.** "Parity checklist" from the original doc is enforced by
  `assembleAndVerify` always writing the full template set, not by an explicit runtime check that
  a generated harness matches the checklist.

## Sources (original research)

- https://muz.li/blog/lovable-for-designers-the-complete-guide-to-building-apps-with-ai-2026/
- https://www.ml6.eu/en/blog/the-anatomy-of-a-lovable-app-and-its-boundaries-in-enterprise-software
- https://www.closefuture.io/blogs/deep-dive-emergent-ai-vibe-coding-platform
- https://aiindigo.com/tool/emergent-sh
- https://github.com/stackblitz-labs/bolt.diy
- https://github.com/HKUDS/OpenHarness
- https://github.com/ruvnet/ruflo
- https://addyosmani.com/blog/ai-coding-workflow/
