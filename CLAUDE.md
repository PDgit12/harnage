# AgentForge — CLAUDE.md

> **AI Model = Brain. Harness = Hands.**
> Prompt-to-harness builder: anyone describes an agent harness → gets a fully-owned,
> Claude Code-level, custom harness. Good harness makes any model (even local Ollama)
> outperform. This repo = reference harness + the builder (`/init` pipeline).

## Stack

TypeScript 5 · Bun · Commander · Zod 4 · Vitest · Biome · chalk
Entry: `src/main.tsx` (`agentforge` REPL | `agentforge --mcp` server)

## Verify (definition of done — all must pass, show output)

```bash
bun run typecheck   # tsc --noEmit
bun run test        # vitest, 8 suites
bun run lint        # biome check src/
bun run build       # compile binary
```

Generated harnesses must themselves pass `bun install && tsc --noEmit` in their output dir.
Never claim done without command output. Tests fail → say so, quote output.

## Bun rules

- `bun <file>`, `bun test`, `bun install`, `bunx` — never node/npm/npx/jest/vitest-global
- `Bun.serve()` (no express), `bun:sqlite`, `Bun.file`, `Bun.$`, built-in `WebSocket`
- Bun auto-loads .env — no dotenv

## Architecture map

| Area | Path | Notes |
|------|------|-------|
| Loop engine | `src/loop/` | LoopEngine state machine: planning→executing→verifying→checking_goal→adapting |
| Providers | `src/services/api/providers/` | Anthropic, OpenAI, Ollama, OpenRouter |
| Tools (9) | `src/tools/` | Bash (sandboxed), FileRead/Edit/Write, Glob, Grep, WebFetch, WebSearch, Agent |
| Commands | `src/commands/` + `src/commands.ts` | REPL routes via `findCommand()` |
| Builder | `src/builder/` | parseIntent → generatePlan → assembleAndVerify |
| MCP | `src/main.tsx` + `src/services/mcp/` | Dual-mode: serves AND consumes MCP |
| REPL | `src/repl.ts` | readline + chalk (Ink TUI not yet built — planned) |

Docs: `design.md` (architecture — partially stale re: Ink UI), `knowledge.md` (audit — stale,
verify against code before acting), `AGENTS.md` (agent topology).

## Hard constraints

- Never delete/force-push/hard-reset without explicit OK
- Never commit secrets or API keys
- Never resurrect deleted Rust code (`crates/` era is dead)
- Never destructively touch `~/.agentforge` user config

## knitbrain pairing (mandatory workflow)

Session start: `knitbrain_load_session` first. Resume unfinished work before anything else.

Every non-trivial task:
1. `knitbrain_run` (or `knitbrain_classify_task`) → obey verdict; autoPlanMode=true → enter plan mode
2. Search code: `knitbrain_search_code` first, then `knitbrain_read` only the hits
3. Complex tasks: spawn scoped agents (`.claude/agents/`: src, tests, providers) — coordinate via `knitbrain_team_post`
4. Before done: verify claims (run commands), then `knitbrain_record_learning`
5. Session end / long pause: `knitbrain_save_handoff`

Wrong classifier verdict → `knitbrain_record_false_positive`. No yes-man: report what is
true, not what is wanted.

## Scoped agents

`.claude/agents/src.md` · `tests.md` · `providers.md` — each locked to its domain,
posts findings to knitbrain team board. Use for parallel work; don't let one agent
edit outside its scope.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- Product ideas/brainstorming → /office-hours
- Strategy/scope → /plan-ceo-review
- Architecture → /plan-eng-review
- Design system/plan review → /design-consultation or /plan-design-review
- Full review pipeline → /autoplan
- Bugs/errors → /investigate
- QA/testing behavior → /qa or /qa-only
- Code review/diff check → /review
- Visual polish → /design-review
- Ship/deploy/PR → /ship or /land-and-deploy
- Save progress → /context-save · Resume → /context-restore

## Tooling doctrine (decided 2026-07-12)

knitbrain = BRAIN (memory/learnings/classify/code graph — sole owner) · Claude Code native
subagents + knitbrain team board = MUSCLE (parallelism) · Claude Code = HANDS (execution,
permissions, skill routing). ruflo/OpenHarness are **blueprints to mine, not dependencies**:
hooks routing, vector memory, trust-gated agents, skills-as-markdown belong in AgentForge's
generated harnesses. One owner per layer — filter for any new MCP addition.

## North star (from charter, 2026-07-12)

1. Builder generates harnesses that compile and run — E2E green (currently broken: missing deps in generated package.json, ToolContext mismatch)
2. Reference harness at Claude Code level: TUI (Ink), permissions, context compaction, multi-agent, session resume
3. Benchmark against Claude Code, Codex CLI, OpenCode, pi, OpenHarness (HKUDS), ruflo (ruvnet)
