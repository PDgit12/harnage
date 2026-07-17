# AGENTS.md — harnage Agent Topology

> **Project:** harnage (TypeScript/Bun) — prompt-to-harness builder + reference harness.
> **Stack:** TypeScript 5, Bun, React 18 + Ink 5, Commander, Zod 4, Vitest, Biome.
> Full architecture: [design.md](design.md). Builder pipeline detail: [docs/builder-architecture.md](docs/builder-architecture.md).

---

## Philosophy

harnage is two things at once: a terminal AI coding agent (the **reference harness**, MCP
dual-mode) and a builder that generates new harnesses from a prompt (the **build brain**,
`/init`'s interview→plan→generate→verify-repair pipeline). Real subagents, scoped to real
directories, mirror that split — not an aspirational org chart.

---

## Real agent topology (`.claude/agents/*.md`)

13 scoped Claude Code subagents, each locked to one directory, `Read/Grep/Glob/Edit/Write` only,
posting findings to the knitbrain team board:

| Agent | Scope | Domain |
|-------|-------|--------|
| `src` | `src/` (broad) | Whole-source fallback for cross-cutting changes |
| `loop` | `src/loop/**` | `LoopEngine`, safety rails, context/compaction, sandbox, persistence |
| `providers` | `src/services/api/providers/**` (`providers` trigger) | Anthropic/OpenAI/Ollama/OpenRouter |
| `api` | `src/services/api/**` | Provider client, `FallbackProvider` |
| `mcp` | MCP domain (`mcp` trigger) | `src/main.tsx` MCP-server mode + `src/services/mcp/` client |
| `ui` | `src/ui/**`, `src/repl.ts`, `GENERATED_TUI` template | Ink TUI (reference + generated) |
| `llm` | LLM domain (`llm` trigger) | `src/builder/llm/*` — interview, plan, generate, repair |
| `spec` | `src/builder/spec/**` | Intent parsing / project-context analysis |
| `assemble` | `src/builder/assemble/**` | Harness template assembly + build verification |
| `generate` | `src/builder/generate/**` | Deterministic tool/command file generators |
| `tests` | tests domain (`tests` trigger) | `tests/*.test.ts` (25 files) |
| `scripts` | scripts domain (`scripts` trigger) | `scripts/*.ts` benchmarks (bench-profile, bench-editformat, bench-archetype, egress-check) |
| `utils` | `src/utils/**` | Shared helpers |

Orchestration for multi-domain work uses Claude Code's native `Agent` tool + knitbrain's team
board — not a custom multi-agent runtime in this repo. Verified: agent files live at
`.claude/agents/{api,assemble,generate,llm,loop,mcp,providers,scripts,spec,src,tests,ui,utils}.md`.

---

## Two-brain split (see design.md for detail)

```
BUILD BRAIN                          RUNTIME BRAIN
src/builder/llm/*                    whatever model the generated harness runs
  interview → plan → generate          resolved to a ModelProfile (tier/loop/
  → repair, only during /init            toolCalling/maxTools/editFormat/...)
```

The `llm`, `spec`, `assemble`, `generate` subagents own the build brain's code. `loop`, `ui`,
`providers` own the reference harness that both the runtime brain and the generated-harness
templates are modeled on.

---

## Verification per domain

- Whole-repo gate (any agent, before reporting done): `bun run typecheck && bun run test && bun run lint`.
- `loop` / `providers` / `api`: relevant `tests/loop*.test.ts`, `tests/providers.test.ts`,
  `tests/ollama.test.ts`.
- `llm` / `assemble` / `generate` / `spec`: `tests/llm-stages.test.ts`,
  `tests/llm-enrichment-hardening.test.ts`, `tests/repair.test.ts`, `tests/generate.test.ts`,
  `tests/builder.test.ts`, `tests/chassis-config.test.ts`, `tests/profiles.test.ts`,
  `tests/memory.test.ts`, `tests/eval.test.ts`, `tests/harness-permissions.test.ts`,
  `tests/generated-tui.test.ts`, `tests/custom-commands.test.ts`, `tests/model-catalog.test.ts`,
  `tests/multiagent.test.ts`.
- `ui`: manual TUI smoke run (`bun src/main.tsx`) — no headless test harness for Ink render yet.
- `mcp`: manual `harnage --mcp` + protocol handshake.
- `scripts`: `bun scripts/bench-profile.ts <model>` battery (see docs/harness-excellence.md §5).

---

## knitbrain pairing (mandatory, all agents)

Session start: `knitbrain_load_session`. Every non-trivial task: `knitbrain_run` →
obey verdict → `knitbrain_search_code` before reading → verify claims with real command output
→ `knitbrain_record_learning` → `knitbrain_save_handoff` at session end. See `CLAUDE.md` for the
full protocol; this file only maps agents to code, not workflow (that lives in CLAUDE.md so it
has one owner).

---

## Key differentiators (from the reference harness + generated harnesses)

- **MCP dual-mode** — harnage both serves an MCP server (`--mcp`) and consumes external MCP
  servers. Most competitors do one or the other.
- **Per-model scaffold adaptation (Engine v3 / ModelProfile)** — generated harnesses reconfigure
  loop mode, tool budget, edit format, and decoding params to the plugged-in model instead of
  assuming a frontier model. See docs/harness-excellence.md.
- **Four-tier memory + eval-in-loop + terminal LLMops** shipped in every generated harness
  (semantic/episodic sqlite, procedural skills, working compaction; deterministic evals + opt-in
  LLM judge; a `trace` command over the local audit log) — sovereign, nothing leaves the machine.

---

*This file describes code structure and agent scope. Session workflow, verification gates, and
hard constraints live in CLAUDE.md — don't duplicate them here.*
