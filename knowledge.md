# Knowledge.md — AgentForge Full System Audit

> Generated 2026-07-11 by 20 parallel audit agents.
> Each finding includes severity, file:line, and suggested fix.

> **STATUS 2026-07-13: RESOLVED/HISTORICAL.** This audit (2026-07-11) is retained for
> history. All CRITICAL findings were fixed by 2026-07-13 (builder E2E green, REPL routing,
> CostTracker singleton, Ollama tools + num_ctx, MCP read scoping, Ink TUI now exists).
> Do not act on this document — verify against code. Current state: see design.md + git log.


---

## CRITICAL (Broken — blocks compilation or core functionality)

### C1. `buildTool` export missing
- **Files:** `src/builder/generate/tool-generator.ts:62,70` + `src/Tool.ts`
- **What:** `file_edit` template imports `buildTool` from `Tool.ts` but it's never defined there. `Tool.ts` only exports interfaces. Every generated project fails compilation.
- **Fix:** Replace `buildTool(...)` wrapper with plain object literal (same pattern as other 8 tools).

### C2. `zod/v4` import path wrong
- **Files:** All 10+ tool templates in `tool-generator.ts` (lines 8,38,61,88,109,139,163,186,216,250,274)
- **What:** Templates use `import { z } from "zod/v4"` but Zod v4.4.3 exports `z4` as default from `/v4`, not `z`. Every tool file fails typecheck.
- **Fix:** Change to `import { z } from "zod"` (matches all real tools in `src/tools/`).

### C3. REPL bypasses command registry — 5 of 8 commands unreachable
- **Files:** `src/components/REPL.tsx:189-219` vs `src/commands.ts:26-76`
- **What:** REPL hardcodes `/exit`, `/clear`, `/init` as if-else. `/cost`, `/help`, `/model`, `/config`, `/doctor` are never dispatched — they're sent to the LLM as plain text.
- **Fix:** Route through `findCommand()` from `commands.ts`.

### C4. Cost tracking always shows $0.0000 — dual CostTracker instances
- **Files:** `src/hooks/useStreaming.ts:109` + `src/cost-tracker.ts:77` + `src/loop/LoopEngine.ts:44,88`
- **What:** Engine creates its own `CostTracker` (records real usage). UI reads singleton `costTracker` (never written to). Two live instances, no connection between them.
- **Fix:** Pass the singleton `costTracker` to `new LoopEngine({costTracker})`.

### C5. OllamaProvider has no tool support
- **File:** `src/services/api/providers/OllamaProvider.ts:18-21`
- **What:** `stream()` method omits `tools?: ToolDefinition[]` parameter from the `Provider` interface. Tools never sent to Ollama; tool_use events never emitted.
- **Fix:** Add `tools` parameter, pass in request body, parse `tool_calls` from response.

### C6. Generated WebSearchTool is non-functional
- **File:** `src/builder/generate/tool-generator.ts:186-213`
- **What:** POSTs to `https://api.duckduckgo.com/` which is not a general web search API. DuckDuckGo Instant Answer only returns zero-click info via GET. Tool always returns "unavailable".
- **Fix:** Replace with Brave Search API, DuckDuckGo HTML scraping, or document SerpAPI requirement.

### C7. No OS-level sandbox — bash runs with host privileges
- **File:** `src/loop/sandbox.ts:102`
- **What:** `Bun.spawn(["bash", "-c", command])` with zero containerization. Application-level blocklist only (trivially bypassed via `python -c`, `perl -e`, etc.).
- **Fix:** Docker per-execution or gVisor container. At minimum: `--read-only --cap-drop=ALL --network=none`.

### C8. MCP server reads arbitrary host files
- **File:** `src/main.tsx:294-308`
- **What:** `ReadResourceRequestSchema` strips `file://` prefix and reads any path. No prefix check against project root.
- **Fix:** `path.resolve(filePath)` + verify it starts with `process.cwd()` or `homedir()`.

### C9. AGENTS.md describes a Rust/Cargo project
- **File:** `AGENTS.md:50-396` (entire squad A section)
- **What:** Every agent's verification uses `cargo check`, `cargo test`, `cargo clippy`. Zero Rust code exists — it's TypeScript/Bun/Ink/Vitest.
- **Fix:** Complete rewrite for actual tech stack, or quarantine as aspirational roadmap.

### C10. `design.md` claims 12 tools / 10 commands — 9 tools / 8 commands exist
- **Files:** `design.md:127-141,191-208`
- **What:** SkillTool, TaskTool, MCPTool don't exist. `/compact`, `/resume` don't exist. `buildTool()` factory doesn't exist. Theme shape is wrong (lists `diffAdded`/`diffRemoved`/`bashBorder`/`userMessageBackground` — none exist).
- **Fix:** Sync design.md to actual interface shapes, tool counts, and command counts.

---

## HIGH (Blocks functionality or causes data loss)

### H1. PromptInput has its own stale COMMANDS list
- **File:** `src/components/PromptInput.tsx:11-21`
- **What:** Lists `/theme` and `/status` (no handlers) but missing `/config` (registered). Dual source of truth.
- **Fix:** Import `COMMANDS` from `../../commands.ts`.

### H2. Generated JSXCommandHandler broken in template REPL
- **Files:** `src/builder/assemble/templates.ts:367-368` + `commands/doctor/index.tsx:242-258`
- **What:** Generated REPL always calls `handler.call(args, context)` but JSXCommandHandler.call has signature `(onDone, context, args)`. Args/callback mismatch — returns `[object Object]` on stdout.
- **Fix:** Unify to single handler type. Delete JSXCommandHandler.

### H3. Three dialog components rendered but never triggered
- **Files:** `src/components/REPL.tsx:55,292-316` — ExitFlow, CostThreshold, PermissionDialog
- **What:** `activeDialog` is always `null`. Nothing ever calls `setActiveDialog("exit"|"cost"|"permission")`. ~200 lines of dead UI.
- **Fix:** Wire from LoopEngine events or delete.

### H4. `onChangeAppState` single-timer race loses writes
- **File:** `src/state/AppStateProvider.tsx:8-26,35-40`
- **What:** One `saveTimer` for all file paths. Two saves in same tick — second clears first's timer. Settings writes silently lost.
- **Fix:** Per-path timers (`Map<string, Timer>`) or batch all changes.

### H5. `recoverLastLoop()` and `resume()` are dead code
- **Files:** `src/loop/persistence.ts:93-97` + `LoopEngine.ts:97`
- **What:** Functions exist, zero callers. Crash mid-loop → snapshot on disk → nothing reads it. Blank slate every restart.
- **Fix:** Wire `recoverLastLoop()` → `resume()` in main.tsx after config load.

### H6. No process-level error handlers
- **File:** `src/main.tsx` (entire file — no handlers)
- **What:** Zero `unhandledRejection` or `uncaughtException` handlers. Async generator throws outside try/catch → silent process death.
- **Fix:** `process.on("unhandledRejection", ...)` in startRepl.

### H7. Config parse failure silently swallowed
- **File:** `src/main.tsx:48`
- **What:** Corrupted `config.json` → empty catch block → silent fallback. User has no way to debug.
- **Fix:** `console.warn` with the file path and error.

### H8. Permission mode "bypass" and "auto" allow all writes
- **Files:** `src/tools/BashTool/BashTool.ts:80-88` + `FileEditTool/FileEditTool.ts:45-52`
- **What:** Both modes return `{ allowed: true }` for every call including destructive. MCP server hardcodes `mode: "bypass"`, `rules: []`. Permission system is a no-op.
- **Fix:** Remove "bypass" mode or require explicit flag.

### H9. API keys in plaintext on disk
- **File:** `src/builder/assemble/templates.ts:297-333`
- **What:** Generated `main.tsx` writes `apiKey` to `~/.{projectName}/config.json` as plain JSON. Readline prompt → file on disk.
- **Fix:** Read from env only; set file permissions 0600 if persisted.

### H10. Blocklist in BashTool is trivially bypassable
- **Files:** `src/tools/BashTool/BashTool.ts:44-57`
- **What:** Five patterns (`rm -rf /`, `dd`, `mkfs`, fork bomb, `/dev/sda`). All bypassable with alternative syntax, aliases, or indirect execution.
- **Fix:** Invert to allowlist of read-only commands.

---

## MEDIUM (Limits utility, maintainability, or correctness)

### M01. No coverage config in vitest.config.ts
- **Files:** `vitest.config.ts` (no coverage section), `package.json` (no `test:coverage` script)
- **Fix:** Configure `@vitest/coverage-v8` with threshold.

### M02. Generated project has `react`/`ink` as unconditional deps
- **Files:** `src/builder/assemble/templates.ts:20-21`
- **What:** Added for every project even though `main.tsx` is CLI-only (no JSX). Adds ~30MB to node_modules.
- **Fix:** Make conditional or remove.

### M03. Generated `@modelcontextprotocol/sdk` is unconditional
- **File:** `src/builder/assemble/templates.ts:25`
- **What:** Always in package.json even for projects that don't use MCP. ~15MB dead dep.
- **Fix:** Guard behind `plan.hasMcp` or similar.

### M04. Output dir name uses unsanitized spec.name
- **File:** `src/builder/index.ts:27`
- **What:** `spec.name` is raw prompt text. `.agentforge-build-Build a code review agent` has spaces.
- **Fix:** Use `plan.name` (sanitized) for directory name.

### M05. `plan.files` array is cosmetic — assembly ignores it
- **Files:** `src/builder/plan/index.ts:34-112` vs `src/builder/assemble/index.ts`
- **What:** 40+ file entries with purposes and deps tracked in plan but never consumed. Assembly writes its own hardcoded set.
- **Fix:** Delete `plan.files` as dead metadata.

### M06. Generated `providers/` directory is entirely dead
- **Files:** `src/builder/generate/provider-generator.ts` lines 5-168
- **What:** 4 provider files + barrel generated. Never imported by generated `main.tsx` (which has its own inline streaming). ~120 lines dead code per project.
- **Fix:** Delete provider-generator.ts and the `providers` entry from plan.

### M07. Three generated barrels are dead (`tools/index.ts`, `commands/index.ts`, `providers/index.ts`)
- **Files:** Generated `src/tools/index.ts`, `src/commands/index.ts`, `src/providers/index.ts`
- **What:** Never imported. Main runtime uses `tools.ts` and `commands.ts` directly.
- **Fix:** Remove barrel generation.

### M08. `src/context.ts` and `src/state/AppState.ts` in generated project are dead
- **Files:** Generated `src/context.ts`, `src/state/AppState.ts`
- **What:** Never imported by REPL, commands, tools, or MCP server. `main.tsx` defines ToolContext inline.
- **Fix:** Remove from generation.

### M09. No string template tests (full build path coverage)
- **File:** `tests/builder.test.ts` (89 lines, covers only parseIntent + generatePlan structure)
- **What:** Zero tests for `validateAgentPrompt`, `buildHarness`, `assembleAndVerify`, template output validity.
- **Fix:** Add integration test: generate project → `bun install` → `bun run typecheck`.

### M10. SetupWizard reads stale React state in synchronous callback
- **File:** `src/components/SetupWizard.tsx:40-53`
- **What:** `useInput` callback reads `provider` state variable (stale) instead of local `choice` variable. Choosing Anthropic/OpenRouter sends wrong next step.
- **Fix:** Read `choice` variable directly.

### M11. No retry logic for transient errors
- **What:** Zero retry anywhere in providers or tools. Single attempt on every fetch/spawn.
- **Fix:** Add `withRetry<T>(fn, maxAttempts=3)` with exponential backoff + jitter.

### M12. `StreamingMarkdown` not used for live streaming text
- **Files:** `design.md:15-18` claims it; `REPL.tsx:271` uses plain `<Text wrap="wrap">`.
- **What:** Streaming text doesn't get markdown formatting. Only committed messages are rendered.
- **Fix:** Use StreamingMarkdown for live text too, or update design doc.

### M13. No `/save` or `/load` commands
- **What:** Auto-persistence exists but no user-facing snapshot management. User has no visibility into saved sessions.
- **Fix:** Add `/save <name>` and `/sessions` commands.

### M14. `isReadOnlyCommand` misses `\n` and `$()` 
- **File:** `src/tools/BashTool/BashTool.ts:38-41`
- **What:** Split regex only covers `;&|` — newlines and command substitution bypass.
- **Fix:** Shell AST parser or allowlist approach.

### M15. `allTimeCost` is memory-only — cost ceiling resets on restart
- **File:** `src/cost-tracker.ts:27-28,58-64`
- **What:** Not persisted. Safety budget resets when process restarts.
- **Fix:** Persist alongside settings.

---

## LOW (Polish, naming, tiny bugs, cleanup)

### L01. `getUnreadNotifications` returns total count (no unread concept)
- **File:** `src/state/AppStateProvider.tsx:84-86`
- **Fix:** Rename to `getNotificationCount`.

### L02. `AppState.streamingText`/`streamingToolUses` are unused mirrors with stale lag
- **File:** `src/state/AppState.ts:56-57` + `REPL.tsx:132-134`
- **Fix:** Remove from AppState; read from hook directly.

### L03. `displayError()` applies chalk formatting in data pipeline
- **File:** `src/utils/displayError.ts`
- **Fix:** Rename to `toErrorMessage()`, move ANSI styling to REPL.tsx render layer.

### L04. `ValidationError` class never instanceof-checked
- **File:** `src/builder/spec/index.ts:76-81`
- **Fix:** Delete, use `throw new Error("[ValidationError] ...")`.

### L05. 33 empty catch blocks across codebase
- **What:** Errors silently swallowed. No console.warn at minimum.
- **Fix:** Add `console.warn("[agentforge] ...")` to all 33.

### L06. 11 `.catch(() => "")` chains discard error info
- **What:** Error bodies from provider HTTP failures discarded.
- **Fix:** Log before returning default.

### L07. Unsafe `(e as Error).message` casts in 5 tool files
- **Files:** FileReadTool:106, FileEditTool:70, GrepTool:70, WebFetchTool:45, WebSearchTool:45
- **Fix:** `error instanceof Error ? error.message : String(error)`.

### L08. `Tool.ts` permission modes list differs from generated TOOL_TYPESCRIPT
- **Files:** `src/Tool.ts` vs `templates.ts:462-498`
- **What:** Source has `"default"|"plan"|"bypass"|"auto"`. Template has `"bypass"|"auto"|"strict"`.
- **Fix:** Sync template to match source.

### L09. CLAUDE.md mandates `bun test` but package.json uses `vitest run`
- **Files:** `CLAUDE.md:10` vs `package.json:15`
- **Fix:** Pick one and update the other.

### L10. README claims "11 suites" — 9 test files exist
- **File:** `README.md:60`
- **Fix:** Update to "9 test files".

### L11. README claims "10 built-in tools" — 9 registered
- **File:** `README.md:47`
- **Fix:** Update to "9 built-in tools".

### L12. Tool `name` uses 4 different naming conventions
- **What:** PascalCase+Tool suffix (GlobTool, GrepTool), PascalCase no suffix (WebSearch, WebFetch), lowercase (bash, read, write). Lookups unpredictably fail.
- **Fix:** Standardize to one convention.

### L13. Notifications array grows unbounded with no read tracking
- **File:** `src/state/AppState.ts:46-51,61`
- **Fix:** Cap at 50 or add read/dismiss.

### L14. `workdir` parameter silently ignored in BashTool
- **File:** `src/tools/BashTool/BashTool.ts:62,97`
- **Fix:** Wire to `Bun.spawn({ cwd })`.

### L15. GrepTool uses `Bun.spawnSync` — blocks event loop
- **File:** `src/tools/GrepTool/GrepTool.ts:35`
- **Fix:** Use async `Bun.spawn` with `for await`.

### L16. FileReadTool reads binary files twice
- **File:** `src/tools/FileReadTool/FileReadTool.ts:89-97`
- **Fix:** Read once as buffer, detect binary, decode from same buffer.

### L17. `saveLoop` blocks hot path every iteration
- **File:** `src/loop/LoopEngine.ts:169`
- **Fix:** Debounce persistence — save every N iterations.

### L18. No `.gitignore` in generated projects
- **File:** `src/builder/assemble/templates.ts` (missing)
- **Fix:** Add `.gitignore` with `node_modules/`, `.agentforge-build-*/`.

### L19. Generated `build` script duplicates `typecheck` (both are `tsc --noEmit`)
- **File:** `src/builder/assemble/templates.ts:14-15`
- **Fix:** Change `build` to `bun build src/main.tsx --compile`.

### L20. Ink + React version mismatch in generated deps
- **File:** `src/builder/assemble/templates.ts:20-21`
- **What:** `ink ^5.2.1` requires React 19 peer dep, but `react 18.3.1` pinned.
- **Fix:** Bump React to `^19.0.0` or pin Ink to `^4.0.0`.

---

## OVER-ENGINEERING (Delete or simplify)

### O01. **Builder module** (highest delete priority)
- **Files:** `src/builder/` (~300 lines across 8 files)
- **Why:** Generates a scaffolded copy of AgentForge from a description. Nobody needs AgentForge to recursively generate AgentForge. The `/init` flow, `parseIntent`, `generatePlan`, `assembleAndVerify`, `tool-generator.ts`, `command-generator.ts`, `provider-generator.ts`, `ui-generator.ts` — all of it. If scaffolding is needed, `npx create-agent` is a one-file script.
- **Delete.** ~300 lines gone, 8 files removed, `package.json` builder deps removed.

### O02. **Ink/React REPL** (30MB dependency for a CLI)
- **Files:** `src/components/` (13 files, ~800 lines) + Ink/React/yoga deps
- **Why:** React 18 + Ink 5 + react-reconciler + yoga-layout for a terminal prompt, message list, and status line. Claude Code, Aider, and Codex use chalk + readline and are smaller, faster, and simpler.
- **Replace with:** chalk + readline. 3 files, one dependency.

### O03. **11 agents for a 1-person project** (AGENTS.md)
- **Files:** `AGENTS.md:48-396`
- **Why:** 11 specialized agents (Rust Architect, Router Engineer, Loop Engineer, MCP Engineer, CLI Developer, Web UI Developer, Infra Engineer, Test Architect, Docs Writer, Security Auditor) for a single developer. Only Iteration 0 ever ran. 605 lines of aspirational fiction.
- **Replace with:** 3-4 actual agent roles (engine, ui, builder, quality) mapped to real modules.

### O04. **OpenRouter auto-fallback machinery**
- **Files:** `src/services/api/providers/OpenRouterProvider.ts:26-47,61-62`
- **Why:** `listFreeModels()`, `getBestFreeModel()`, auto-fallback on 429. Hits `/api/v1/models` on every stream call (500-2000ms delay). Speculative — users configure the model they want.
- **Delete:** Keep fallback as explicit config, not auto-discovery.

### O05. **Separate OpenAI vs OpenRouter provider classes**
- **Files:** `OpenAIProvider.ts` vs `OpenRouterProvider.ts`
- **Why:** Both use the `openai` npm SDK. Only difference is `baseUrl`. Could be one class with config.
- **Merge:** Parameterize by `baseUrl`.

### O06. **Dual LoopEngine implementations** (real vs generated)
- **Files:** `src/loop/LoopEngine.ts` (490 lines) vs `src/builder/assemble/templates.ts` (85-line inline version)
- **Why:** Generated template duplicates 80% of logic. Will diverge.
- **Fix:** Generated project should import/wrap LoopEngine, not re-implement.

### O07. **JSX command handler type** (never used for JSX)
- **Files:** `src/commands.ts:12-24` + `COMMANDS_REGISTRY` in template
- **Why:** Two handler types, zero runtime discrimination. All commands return strings.
- **Delete:** Unify to one type.

### O08. **Dual registration in PermissionRule system**
- **Files:** `src/hooks/toolPermission/permissions.ts:1-37`
- **Why:** `PermissionRule` machinery with `matchRule`, `buildDefaultRules` — never populated. Both callers set `rules: []`.
- **Delete:** Inline simple checks; remove rules array.

### O09. **Three dead template files in generated projects**
- **Files:** `STATE_TEMPLATE`, `CONTEXT_TEMPLATE`, `PROVIDER_TEMPLATES` (all)
- **Why:** Generated but never imported by any runtime code.
- **Delete:** Remove from templates.ts.

### O10. **Triple provider streaming implementation**
- **Files:** `providers/*.ts` x4 + `provider-generator.ts` + `templates.ts` streamProvider
- **Why:** Three disconnected implementations with different error handling, tool support, and streaming formats.
- **Consolidate:** Keep the real providers; delete generator/provider template duplicates.

---

## COMPETITIVE GAPS (vs 2026 market)

| Feature | AgentForge | Industry (Claude Code, Cursor, Codex, etc.) | Priority |
|---------|-----------|---------------------------------------------|----------|
| Multi-agent orchestration | AgentTool flat sub-agents, no coordination | 5-level deep sub-agents, dynamic workflows, role-based teams | **P0** |
| Multi-model routing | One model per session | 75+ providers, per-task routing, fallback chains | **P0** |
| Git integration | Zero | auto-commit, PR, branches | **P0** |
| Background execution | Everything synchronous loop | Background cloud agents, scheduled tasks, fire-and-forget | **P0** |
| Observability | Raw cost numbers | Tracing, replay, dashboards (LangSmith, etc.) | **P1** |
| Context window | 32k effective | 1M (Claude Code), 400k (Codex) | **P1** |
| Container sandboxing | Blocklist + path checks | Full sandboxed VMs (Codex) | **P1** |
| IDE integration | Terminal-only or MCP | IDE extensions (Cursor/Copilot/Continue), LSP | **P2** |
| Structured output | Regex on free-form text | JSON schema enforcement + retry | **P2** |
| Plugin/hooks system | None | pre-commit hooks, plugins (Claude Code, OpenCode) | **P2** |

### Key Differentiator
**MCP Dual-Mode** — AgentForge can BE an MCP server (exposing all tools via stdio) AND consume MCP servers. Claude Code, Cursor, and OpenCode all consume MCP but don't serve as one. AgentForge could be the "MCP bridge" — tool provider + agent in one. **This is the wedge. Lean into it.**

---

## SUMMARY: Top 10 Fixes by Impact

| # | Finding | Severity | Effort | Fix |
|---|---------|----------|--------|-----|
| 1 | `buildTool` missing (C1) | Critical | 1 line | Remove wrapper, use plain object |
| 2 | `zod/v4` wrong import (C2) | Critical | 1 line/file | Change to `"zod"` |
| 3 | REPL bypasses command registry (C3) | Critical | 2 lines | Route through `findCommand()` |
| 4 | Dual CostTracker (C4) | Critical | 1 line | Pass singleton to LoopEngine |
| 5 | OllamaProvider no tools (C5) | Critical | 5 lines | Add `tools` param + parsing |
| 6 | WebSearchTool broken (C6) | High | 30 lines | Replace API endpoint |
| 7 | PromptInput stale COMMANDS (H1) | High | 5 lines | Import from commands.ts |
| 8 | syncCostTracker race (H4) | High | 5 lines | Per-path timers |
| 9 | `recoverLastLoop` dead (H5) | High | 8 lines | Wire in main.tsx |
| 10 | Builder module (O01) | Delete | -300 lines | Remove entire builder |

**Quickest critical path** (fixes 1-5): ~10 line changes across 5 files. Unblocks compilation, enables cost tracking, enables Ollama tool calling. ~10 minutes of work.
