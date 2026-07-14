# LLM-Driven Builder — Architecture (researched 2026-07-12)

> Replaces keyword `parseIntent` with an LLM pipeline. Synthesis of Lovable, Emergent,
> bolt.diy, OpenHarness (HKUDS), ruflo (ruvnet) — mapped to prompt-to-harness.

## What the leaders actually do

| Platform | Pipeline | Key lesson for us |
|---|---|---|
| **Lovable** | Agent mode default: chat → autonomous research/debug/generate → live preview → auto-deploy | Interface (chat + agent autonomy) IS the product; agent researches and self-debugs |
| **Emergent** | 5 specialized agents: Planner (prompt→structured requirements) → Developer → Testing (screenshot analysis + conflict review) → Deploy → Optimize | Multi-agent split by phase; autonomous debugging loop (detect→analyze→fix, no human) |
| **bolt.diy** (open source) | Sandboxed env where agent owns fs/npm/dev-server/console: generate → run → read errors → fix. 15+ starter templates. 19+ providers incl. Ollama via AI SDK | **Verify-repair loop is the core**, not one-shot generation. Templates as starting points. Multi-provider from day one |
| **OpenHarness** | Harness = Tools + Knowledge + Observation + Action + Permissions. Skills-as-markdown, permission modes, compaction | Component checklist for what a generated harness must contain |
| **ruflo** | Hooks-based semantic routing, vector memory, trust-gated agents, background workers | Features generated harnesses should ship with (differentiators) |

Cross-cutting best practice (2026): spec-first — LLM asks clarifying questions until
requirements/edge cases are pinned, THEN plans, THEN codes. Never one-shot from vague prompt.
Security review is a dedicated pass; no model catches its own security mistakes.

## AgentForge pipeline (v2 — replaces `parseIntent`)

```
prompt
  │
  ▼
1. INTERVIEW (LLM)        clarifying Qs until spec pinned (skippable: --yes uses defaults)
  │                        output: StructuredSpec — Zod-validated JSON, retry ≤3 on invalid
  ▼
2. PLAN (LLM)             spec → HarnessPlan: tools, commands, providers, custom files,
  │                        system prompt, permission policy. Zod-validated, user-approvable
  ▼
3. SCAFFOLD (deterministic) proven chassis from templates: loop engine, provider layer,
  │                        tool interface, sandbox, persistence, MCP dual-mode
  ▼
4. GENERATE (LLM)         only the custom ~20%: bespoke tools, commands, system prompt,
  │                        domain knowledge/skills — per-file, schema-constrained output
  ▼
5. VERIFY-REPAIR (loop)   bun install + tsc --noEmit + vitest in output dir;
  │                        errors fed back to LLM, ≤N repair iterations (bolt.diy pattern)
  ▼
6. REVIEW (LLM)           quality + security pass over generated custom code
  ▼
owned harness (compiles, tests green, user's code entirely)
```

## Design decisions

1. **Hybrid, not full-LLM.** Lovable/bolt LLM-generate everything — works with frontier
   models, flaky with local ones. Our thesis is local-model efficiency: deterministic
   chassis (already-verified template code) + LLM for the custom surface. Smaller
   generation surface = smaller model succeeds = thesis proven.
2. **Reuse LoopEngine for the builder itself.** The builder is a goal-driven agent task:
   goal = "generate harness matching spec, all gates green". Verify-repair = existing
   verifying→adapting phases. Dogfood.
3. **Provider-agnostic via existing `Provider` interface.** Anthropic/OpenAI/Ollama/
   OpenRouter all drive the builder. Ollama path = the demo that proves the thesis.
4. **Structured output enforcement.** Every LLM stage returns JSON validated by Zod;
   malformed → re-prompt with the validation error, ≤3 attempts (closes design.md gap
   "no structured output enforcement").
5. **Keyword `parseIntent` demoted to fallback** for offline/no-provider mode, not deleted.

## What generated harnesses must contain (parity checklist)

Loop engine · ≥N tools · permissions (modes + path rules) · sandboxed bash ·
MCP dual-mode · slash commands · skills-as-markdown dir · persistence/resume ·
cost tracking · context compaction. TUI optional per spec.

## Implementation order

1. `src/builder/llm/` — `interview.ts`, `plan.ts` (LLM stages, Zod schemas, retry wrapper)
2. Wire into `buildHarness()`: interview→plan→scaffold(existing assemble)→generate→verify-repair
3. Repair loop: feed tsc/vitest stderr back, cap iterations, keep last-good
4. Review pass + parity checklist assertion
5. Benchmark: same prompt via Ollama local vs Anthropic — both must produce green harness

## Sources

- https://muz.li/blog/lovable-for-designers-the-complete-guide-to-building-apps-with-ai-2026/
- https://www.ml6.eu/en/blog/the-anatomy-of-a-lovable-app-and-its-boundaries-in-enterprise-software
- https://www.closefuture.io/blogs/deep-dive-emergent-ai-vibe-coding-platform
- https://aiindigo.com/tool/emergent-sh
- https://github.com/stackblitz-labs/bolt.diy
- https://github.com/HKUDS/OpenHarness
- https://github.com/ruvnet/ruflo
- https://addyosmani.com/blog/ai-coding-workflow/
