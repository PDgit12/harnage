# Goal — Build prompt-to-harness builder to production quality: builder E2E green (done 2026-07-12), LLM-driven builder replacing keyword parseIntent, Ink TUI, skills/memory system, benchmarked vs Claude Code / Codex / OpenCode / OpenHarness / ruflo (mined as blueprints, never installed).

DONE MEANS: bun run typecheck + vitest run + biome lint pass, claim backed by command output, never vibes. Generated harnesses must themselves pass bun install + tsc --noEmit.
VERIFY: bun run typecheck · bun run test (vitest, 8 suites) · bun run lint (biome) · bun run build

- [ ] Build prompt-to-harness builder to production quality: builder E2E green (done 2026-07-12), LLM-driven builder replacing keyword parseIntent, Ink TUI, skills/memory system, benchmarked vs Claude Code / Codex / OpenCode / OpenHarness / ruflo (mined as blueprints, never installed).
(covers domains: api, assemble, generate, loop, mcp, providers, spec, src, tests, utils — decompose into per-domain boxes as you go)

Drive hands-off: `/loop goal.md --for 1h` (autonomous external runner) or `/goal` in this session. CLI: `knitbrain loop goal.md`.