# Harness Excellence — How to Make ANY Model Perform at Its Ceiling

> Research deep-dive, 2026-07-13; **implemented** as of this rewrite (2026-07-17) — every lever
> below cites the generated-harness code that runs it. Goal: generated harnesses that extract a
> model's benchmark-best behavior.
> Sources: SWE-agent/ACI paper, Agentless, Aider edit-format research, CodeAct, ReAct/Reflexion,
> BFCL tool-calling findings, Ollama/llama.cpp constrained decoding, Anthropic/OpenAI agent
> guides, plus this project's own field data (qwen2.5:3b demo failures).
> 2026 verification (Harness-Bench, arXiv 2605.27922; HarnessBridge, arXiv 2606.12882;
> particula.tech scaffolding study): harness changes ALONE swing the same model 42%→78% on
> coding benchmarks; on SWE-bench Pro the scaffold accounts for a 22+ point swing while frontier
> model swaps account for ~1 point; local models went 2/10 → 10/10 on a SWE-bench subset purely
> by SHRINKING THE TOOL SPACE — loop structure, not model size, is the binding constraint.

---

## 1. The core insight from the literature

**The same model swings 2-4x on agentic benchmarks depending on scaffold.** Documented examples:

- SWE-agent's ACI paper: GPT-4 went from ~3% (raw shell) to 12.5% (SWE-bench) purely by
  redesigning the *agent-computer interface* — same model, better tool ergonomics.
- Agentless beat many full agent loops on SWE-bench with a fixed 3-phase pipeline
  (localize → repair → validate) — **structure beats autonomy** for mid models.
- Aider's leaderboards: edit format alone (whole-file vs. search/replace) moves pass rates by
  10-20 points per model, and **the best format differs per model**.
- BFCL: small models' tool-call accuracy collapses with >5-8 tools exposed, long schemas, or
  deep nesting; short flat schemas + fewer tools recover most of the gap.

Conclusion: a harness is not plumbing. It is **the other half of the model's weights.**

---

## 2. The eight levers — implementation status

All eight are implemented in `src/builder/assemble/harness-templates.ts` (`HARNESS_PROFILES` +
`ENGINE_TEMPLATE`) and shipped in every generated harness's `profiles.ts`/`engine.ts`.

### L1. Constrained decoding for tool calls — `toolCalling: "constrained-json"`
`DECISION_SCHEMA` (harness-templates.ts:808) is a grammar-forced JSON schema
(`{action:"tool"|"final", tool?, args?, answer?}`) passed as Ollama's `format` param on decision
turns (`engine.ts` decision-loop path, `format: DECISION_SCHEMA` at the streamProvider call site).
Native tool-call path (`this.profile.toolCalling === "native"`) is kept for models strong at it
(dispatch, harness-templates.ts:1172).

### L2. Fewer, better tools — `maxTools`
Per-tier tool budget (frontier 9, strong 8, mid 5, small 4) enforced by trigger-ranked subset
selection before the call is built. Tool results are compacted (`compactToolOutput`) before
being appended to the transcript.

### L3. Structure over autonomy — `loop: "free" | "plan-act" | "pipeline"`
`dispatch(goal)` (harness-templates.ts:1169-1175) picks the loop mode from the resolved profile:
native/free for strong models, `runPlanAct` (one constrained planning call, then per-step
execution) for mid, `runPipeline` (fixed, builder-baked stages) for small. Loop degrades toward
structure as the model shrinks, exactly per the design thesis.

### L4. Edit/action format matched to model — `editFormat`
`"search-replace"` for frontier/strong, `"whole-file"` for mid/small — a per-model
`profileOverrides` entry in the catalog can override this per specific model id (e.g.
`qwen2.5-coder:3b` forces `search-replace` + `temperature: 0` even at 3B, since it's
code-specialized).

### L5. Context engineering — `systemPromptBudget`
System prompt truncated to the profile's char budget (`decisionSystem()`,
harness-templates.ts:1320+) before assembly; critical instructions placed last in the prompt
(documented rationale: Ollama truncates the head on context overflow).

### L6. Self-verification loops — eval-in-loop, not asking "are you sure?"
No LLM call is spent on a YES/NO goal check (removed deliberately — see engine.ts comment at the
tool-loop: "No separate goal-check call — it doubled latency and confused small models"). Instead
`runDeterministicEvals()` (`eval.ts`) runs cheap checks after the fact.

### L7. Decoding discipline — `temperature`, `repeatPenalty`
Per-tier defaults (frontier/strong: 0.2 + nudge backstop; mid: 0.1 + repeatPenalty 1.1; small:
0 + repeatPenalty 1.15) passed through to every `streamProvider` decode call.

### L8. Model profiles — the meta-lever
`ModelProfile` (`interface`, harness-templates.ts:24-35) ships in every generated harness's
`profiles.ts`. `resolveBase(model)` matches by family/param-size; `src/builder/models/catalog.ts`
supplies per-model `profileOverrides` for the curated shortlist, merged on top of the size-tier
default. This is the differentiator claim: the harness reconfigures around whichever brain is
plugged in, rather than assuming a frontier model.

**Bonus, beyond the original 8-lever research**: `shouldEscalate()`/`escalate()`
(harness-templates.ts:1178-1195) — small/mid tiers get one escalation to more structure
(plan-act) and, if a fallback model is configured, a stronger model, when a run comes back
empty or errored. Not part of the original research doc; added during implementation.

---

## 3. Engine v3 architecture (generated harness, as-built)

```
goal ─► ModelProfile.resolve(model)          (profiles.ts, /api/show + catalog overrides)
        │
        ▼
   dispatch() ─┬─ toolCalling=native      → runFree()      (normal chat + tools, nudge backstop)
               ├─ loop=pipeline           → runPipeline()  (builder-baked stages, DECISION_SCHEMA per step)
               ├─ loop=plan-act          → runPlanAct()   (PLAN_STEPS_SCHEMA once, then act per step)
               └─ else                    → runDecisionLoop() (DECISION_SCHEMA every turn)
        │
        ▼
   tool subset (≤ profile.maxTools) → tool call → compactToolOutput() → transcript
        │
        ▼
   shouldEscalate()? → escalate() once (more structure, optional fallback model)
        │
        ▼
   memory recall/consolidate, session persistence, eval-in-loop, permissions — all as in design.md
```

Key point: the **builder** already knows the domain (from PLAN stage output) — it bakes
`plan.pipeline` (≤6 stages) at build time, so a small model in `pipeline` mode fills slots in a
known-good sequence instead of reasoning about tool choice from scratch.

---

## 4. Verification tooling (as-built)

- `scripts/bench-profile.ts <model>` — fixed task battery, records pass/latency, used to tune the
  profile table with data (not yet a public leaderboard).
- `scripts/bench-editformat.ts`, `scripts/bench-archetype.ts` — narrower benchmarks for edit
  format and archetype-specific behavior.
- `scripts/egress-check.ts` — builds a harness and asserts it makes no network calls by default
  (sovereignty self-check).

## 5. What "better than most harnesses" means, measurably

Acceptance battery (per `scripts/bench-profile.ts`):
- T1 file census: "count files by language in `<dir>`" — must produce a correct table.
- T2 targeted read: "what does `<file>` export?" — must read the actual file.
- T3 multi-step: "find the largest .ts file and show its first 10 lines."
- T4 write path: "create hello.txt containing X" (permissions allow-rule test).
- T5 recovery: goal referencing a nonexistent path — must report cleanly, not loop.

Bar: qwen3-8b passes 5/5; qwen2.5:3b passes ≥4/5 in pipeline mode. No published comparison
against OpenHands/OpenCode/Claude Code defaults yet on this battery — see design.md's Gaps.
