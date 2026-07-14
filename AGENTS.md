# AGENTS.md — AgentForge Agent Topology

> **Project:** AgentForge (TypeScript/Bun)
> **Owner:** Piyush Dua
> **Last Updated:** 2026-07-11
> **Stack:** TypeScript 5, Bun, React 18 + Ink 5, Commander, Zod 4, Vitest, Biome

---

## Philosophy

AgentForge is a **terminal-based goal-driven AI coding agent** with MCP dual-mode.  
An agentic workflow builds the agent platform. Verification gates, parallel execution.

---

## Agent Roles

```
ORCHESTRATOR (Lead) ──→ Engine Agent ──→ Provider Agent ──→ Tool Agent ──→ Quality Agent
                              │                                                   │
                              └─── MCP Agent ──────────────────────────────────────┘
```

| Role | Area | Verification |
|------|------|-------------|
| **Engine Agent** | `src/loop/` — LoopEngine, safety, state, persistence, sandbox | `bun run typecheck && bun test tests/loop.test.ts tests/state.test.ts` |
| **Provider Agent** | `src/services/api/providers/` — Anthropic, OpenAI, Ollama, OpenRouter | `bun test tests/providers.test.ts` |
| **Tool Agent** | `src/tools/` — 9 built-in tools + `src/services/mcp/` | `bun test tests/BashTool.test.ts` |
| **MCP Agent** | `src/main.tsx` (MCP server mode) + `src/services/mcp/` (client) | Manual: `agentforge --mcp` + protocol handshake |
| **Quality Agent** | Tests, lint, typecheck, security | `bun test && bun run typecheck && bun run lint` |
| **Builder Agent** | `src/builder/` — /init code generation pipeline | `bun test tests/builder.test.ts` |

### Context Files
```
/Users/piyushdua/Harness/knowledge.md
/Users/piyushdua/Harness/design.md
/Users/piyushdua/Harness/AGENTS.md
```

---

## Current State (2026-07-11)

20-parallel-agent audit completed. Full findings in `knowledge.md`.

### Critical Bugs Found (compilation blockers)
1. `buildTool` export missing — generated projects fail
2. `zod/v4` import path wrong — no `z` export from `/v4`
3. REPL bypasses command registry — 5/8 commands unreachable
4. Dual CostTracker instances — cost always shows $0.0000
5. OllamaProvider has no tool support — tools not sent to Ollama

### Top Fix Priorities
1. Fix `buildTool` (1 line) + `zod/v4` import (1 line/file) — unblocks compilation
2. Wire REPL through `findCommand()` — restores 5 dead commands
3. Pass singleton `costTracker` to LoopEngine — fixes cost display
4. Add tools parameter to OllamaProvider — enables tool calling on Ollama
5. Delete builder module (~300 lines, 8 files) — removes largest over-engineering

---

## Key Differentiator

**MCP Dual-Mode:** AgentForge can both consume MCP servers (like Claude Code) AND serve as one (`--mcp` flag). No other tool in the 2026 market does both. This is the wedge.

---

## Iteration Tracking

| Iteration | Date | Agents Spawned | Goal | Outcome |
|-----------|------|----------------|------|---------|
| 0 | 2026-07-03 | Orchestrator only | Context acquisition + file creation | ✅ AGENTS.md created |
| 1 | 2026-07-11 | 20 parallel audit agents | Full system audit + knowledge.md | ✅ knowledge.md created; 10 critical, 10 high, 20 medium, 20 low, 10 over-engineering findings |

---

*Update the iteration tracking table after every build session.*
