# Harness Excellence — How to Make ANY Model Perform at Its Ceiling

> Research deep-dive, 2026-07-13. Goal: generated harnesses that extract a model's
> benchmark-best behavior — better than most harnesses on the market.
> Sources: SWE-agent/ACI paper, Agentless, Aider edit-format research, CodeAct,
> ReAct/Reflexion, BFCL tool-calling findings, Ollama/llama.cpp constrained decoding,
> Anthropic/OpenAI agent guides, plus our own field data (qwen2.5:3b demo failures).
> 2026 verification (Harness-Bench, arXiv 2605.27922; HarnessBridge, arXiv 2606.12882;
> particula.tech scaffolding study): harness changes ALONE swing the same model
> 42%→78% on coding benchmarks; on SWE-bench Pro the scaffold accounts for a 22+ point
> swing while frontier model swaps account for ~1 point; local models went 2/10 → 10/10
> on a SWE-bench subset purely by SHRINKING THE TOOL SPACE — loop structure, not model
> size, is the binding constraint. Our L1-L8 levers align with all of it.

---

## 1. The core insight from the literature

**The same model swings 2-4x on agentic benchmarks depending on scaffold.**
Documented examples:

- SWE-agent's ACI paper: GPT-4 went from ~3% (raw shell) to 12.5% (SWE-bench) purely
  by redesigning the *agent-computer interface* — same model, better tool ergonomics.
- Agentless beat many full agent loops on SWE-bench with a fixed 3-phase pipeline
  (localize → repair → validate), showing **structure beats autonomy** for mid models.
- Aider's leaderboards: edit format alone (whole-file vs unified-diff vs search/replace)
  moves pass rates by 10-20 points per model — and **the best format differs per model**.
- BFCL (Berkeley Function-Calling Leaderboard): small models' tool-call accuracy
  collapses with >5-8 tools exposed, long schemas, or deep nesting; short flat
  schemas + fewer tools recover most of the gap.

Conclusion: a harness is not plumbing. It is **the other half of the model's weights.**

## 2. The eight levers (ranked by measured impact)

### L1. Constrained decoding for tool calls (biggest small-model lever)
Never *ask* a small model to emit valid JSON — *force* it. Ollama supports
`format: <json-schema>` per request (grammar-constrained sampling); llama.cpp GBNF
underneath. A 3B model physically cannot produce a malformed tool call under grammar
constraint. This converts our #1 field failure (narration instead of tool_calls)
from a prompt problem into a solved decoding problem.
**Design:** when a turn REQUIRES action (dispatch decision), issue the call with
`format` set to a decision schema `{action: "tool"|"final", tool?, args?, answer?}`
instead of relying on native tool_calls. Native tool-call path stays for models
that are strong at it (capability-tiered, see L8).

### L2. Fewer, better tools (ACI principle)
- ≤7 tools exposed per task; select the subset by goal relevance (skills/keyword map).
- One-line descriptions, flat schemas, ≤3 params, no nested objects for small models.
- Merge read/glob/grep into ergonomic compound behaviors where possible
  (SWE-agent's `search_file`/`edit` beat raw bash for every model tested).
- Tool RESULTS must be compact + structured: truncate with head/tail windows,
  line numbers on file reads, exit codes surfaced explicitly. Garbage-in loops kill
  small models faster than weak reasoning does.

### L3. Structure over autonomy (Agentless principle)
Mid/small models do better executing a *pipeline* than free-form ReAct:
plan phase (produce numbered step list, grammar-constrained) → execute steps with a
tight per-step tool budget → verify phase (run checks) → synthesize.
The loop should DEGRADE toward structure as models get smaller: frontier = free loop;
8B = plan-then-act; 3B = fixed pipeline w/ single tool per step.

### L4. Edit/action format matched to model (Aider principle)
For file edits: whole-file replace for <8B (search/replace anchors fail on weak
models), search/replace blocks for strong models (cheaper). Benchmark once per model
family, store in a **model profile** (see L8).

### L5. Context engineering
- System prompt SHORT for small models (<600 tokens); every extra instruction
  degrades instruction-following below ~7B. Skills injected only on trigger match.
- Tool results and history windowed aggressively (we have compaction; tighten:
  keepRecent by tokens not message count).
- Few-shot ONE example of a correct tool call in-context beats paragraphs of rules.
- Put critical instructions LAST (Ollama truncates the head on overflow; recency
  bias helps everywhere).

### L6. Self-verification loops (Reflexion, our verify-repair)
Cheap deterministic checks (exit codes, tsc, tests, file-exists) fed back as
structured failure messages outperform asking the model "are you sure?".
Never burn an LLM call on YES/NO goal checks (we removed this — keep it removed).
Retry budget per step (2-3), then fail loudly with state preserved.

### L7. Decoding discipline
temperature 0-0.2 for action selection; top_p 0.9; optionally higher temp only for
final prose synthesis. Repeat-penalty ~1.1 for small models prevents tool-call loops
(same call repeated forever — a known qwen/llama failure).

### L8. Model profiles — the meta-lever (our differentiator)
Everything above varies per model. THE architecture move for AgentForge: a
**ModelProfile** resolved at runtime that configures the whole engine:

```ts
interface ModelProfile {
  tier: "frontier" | "strong" | "mid" | "small";   // by params + family
  loop: "free" | "plan-act" | "pipeline";           // L3
  toolCalling: "native" | "constrained-json";       // L1
  maxTools: number;                                  // L2
  editFormat: "search-replace" | "whole-file";       // L4
  systemPromptBudget: number;                        // L5
  temperature: number; repeatPenalty?: number;       // L7
  nudge: boolean;                                    // narration backstop
  contextTokens: number;
}
```

Profiles ship with the harness (table keyed by family+size, e.g. `qwen3-8b`,
`qwen2.5-3b`, `llama3.1-8b`, `claude-*`, `gpt-*`), with a conservative default for
unknown models. This is what "any model at its best" means concretely: the harness
*reconfigures itself around the brain that's plugged in.* No shipping harness we've
studied (Claude Code, Codex, OpenCode, OpenHands) does per-model scaffold adaptation —
they assume frontier models. That's the moat.

## 3. Engine v3 architecture (generated harness)

```
goal ─► ModelProfile.resolve(model)          ← /api/show + profile table
        │
        ▼
   ┌─ DISPATCH (per turn) ─────────────────────────────┐
   │ profile.toolCalling == "native"                    │
   │   → normal chat w/ tools, nudge backstop           │
   │ profile.toolCalling == "constrained-json"          │
   │   → format: DecisionSchema (grammar-forced):       │
   │     {action:"tool", tool, args} | {action:"final", answer}
   └────────────────────────────────────────────────────┘
        │
        ▼
   loop mode by profile:
     free      → current loop (tools until no-tools reply)
     plan-act  → 1 plan call (numbered steps, constrained) → act per step
     pipeline  → fixed stages for the harness's domain (from PLAN stage!)
        │
        ▼
   tool subset selection (≤ profile.maxTools, trigger-ranked)
   compact tool results (head/tail, line numbers, exit codes)
   deterministic verify per step → structured failure feedback
   session/compaction/permissions as today
```

Key point: the BUILDER already knows the domain (spec/plan) — it can generate the
*pipeline stages* for small-model mode at build time. A codebase-analysis harness
ships with a baked pipeline: `glob files → count by ext → read key files → report`.
Small model just fills slots. That's how a 3B beats a naive 70B loop on its niche.

## 4. Implementation order

1. **ModelProfile module** (generated `profiles.ts` + resolution in engine) — table + /api/show introspection.
2. **Constrained-json dispatch** — Ollama `format` param with decision schema for small tier; parse + execute. (Biggest single win; kills narration class of failures permanently.)
3. **Tool subset + schema flattening** — cap exposed tools by profile; compress descriptions.
4. **Tool result compaction** — head/tail truncation + exit codes in BashTool et al. templates.
5. **Plan-act mode** — one constrained planning call, per-step execution for mid tier.
6. **Builder-generated pipelines** — PLAN stage emits domain pipeline for small tier.
7. **Repeat-penalty + per-phase temperature** in streamProvider options.
8. **Profile benchmarking script** — `bun scripts/bench-profile.ts <model>` runs a fixed task battery, records pass/latency, tunes the profile table with data.

## 5. What "better than most harnesses" means, measurably

Acceptance tests (scripts/bench-profile.ts battery):
- T1 file census: "count files by language in <dir>" — must produce correct table.
- T2 targeted read: "what does <file> export?" — must read the actual file.
- T3 multi-step: "find the largest .ts file and show its first 10 lines."
- T4 write path: "create hello.txt containing X" (permissions allow-rule test).
- T5 recovery: goal referencing a nonexistent path — must report cleanly, not loop.

Bar: qwen3-8b passes 5/5; qwen2.5:3b passes ≥4/5 in pipeline mode. Compare same
tasks driven through raw Ollama chat (no harness) and through OpenHands/OpenCode
defaults where feasible — that's the head-to-head claim.
