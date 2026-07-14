# AgentForge — Architecture

> **AI Model = Brain. Harness = Hands.** `agentforge --mcp` for MCP server mode.

---

## Overview

```
main.tsx
  ├── --mcp flag → MCP server (tools, resources, prompts via SDK)
  └── default    → Ink REPL
         ├── <StoreProvider> + <ThemeProvider>
         │     └── <REPL>
         │           ├── <Banner>
         │           ├── <Messages>       ← virtualized message list
         │           │     └── <StreamingMarkdown>
         │           ├── <Spinner>
         │           ├── <ToolCall>       ← live tool status
         │           ├── <PromptInput>    ← auto-complete for /commands
         │           ├── <StatusLine>     ← model, cost, MCP count, tasks
         │           └── <Dialogs>
         │                 ├── <PermissionDialog>
         │                 ├── <CostThreshold>
         │                 └── <ExitFlow>
         └── LoopEngine (AsyncGenerator)
               └── Provider (Anthropic | OpenAI | Ollama | OpenRouter)
```

Two entry modes declared via Commander: `agentforge` (REPL) or `agentforge --mcp`.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│              LoopEngine                      │
│  planning → executing → verifying →        │
│  checking_goal → (adapting on failure) → done/failed
├─────────────────────────────────────────────┤
│  SafetyRails │ ContextManager │ ToolParser  │
├─────────────────────────────────────────────┤
│  Anthropic │ OpenAI │ Ollama │ OpenRouter   │
└─────────────────────────────────────────────┘
```

## Current Modules

| Module | Purpose |
|--------|---------|
| `loop/` | Goal-driven loop engine — `LoopEngine.ts` (`run`/`resume`/`getState`), `types.ts` defines `LoopPhase` state machine, `safety.ts` enforces rails, `context.ts` compaction/summarization, `sandbox.ts` bash sandbox, `persistence.ts` loop state |
| `services/api/providers/` | LLM providers: Anthropic, OpenAI, Ollama, OpenRouter (each its own class implementing `Provider`) |
| `tools/` | 9 tools including BashTool sandboxed via `runSandboxed` from `loop/sandbox.ts` |
| `ui/` | Ink + React TUI — `App.tsx` (framed ❯ input, streaming, tool lines, mode line), `index.tsx` launcher |
| `permissions.ts` / `skills.ts` | Path-rule policy (`~/.agentforge/permissions.json`) · skills-as-markdown (`./skills/`) |
| `builder/` | Description-to-harness code generator |
| `builder/llm/` | LLM pipeline: interview → plan → generate → repair (Zod-validated JSON at every stage) |

---

## REPL & UI

Two frontends over the same `LoopEngine` stream:

**Ink TUI** (default on TTY) — `src/ui/App.tsx` + `src/ui/index.tsx`:
- Framed `❯` input box (round border), streaming agent text, `↳ tool` status lines
- `⏵⏵ ready/working` mode line with right-aligned `branch · model · $cost`
- `/command` dispatch via `findCommand`, `esc` quits, `--resume` replays interrupted loop
- History via Ink `<Static>`; live area re-renders only current turn

**Classic readline REPL** (`src/repl.ts`, `--classic` flag or piped stdin):
- chalk-styled streaming, spinner, tool labels, `/command` completion
- Same permission policy, skills injection, and `--resume` support

Both load the permission policy (`src/permissions.ts`) and skills (`src/skills.ts`)
at startup. No theme system or dialog overlays yet — permission denials surface as
tool results the model adapts to; interactive permission prompts are a known gap.

---

## LoopEngine

THE query engine. Goal-driven agent loop (not a generic LLM caller) — persists messages as conversation context and orchestrates tool execution turns across a state machine. `QueryEngine.ts` is legacy and being deleted; `useStreaming` is typed to `LoopEngine`.

State machine phases (`LoopPhase`): `planning → executing → verifying → checking_goal → adapting → done | failed`.

```
run(goal) → AsyncGenerator<StreamEvent>
  loop until done/failed or safety rails trip:
    planning     → provider.stream(messages, toolDefs); collect text + tool_uses
    executing    → for each tool_use: checkPermissions → tool.call → append result
    verifying    → provider checks tool results for errors
    checking_goal → provider answers YES/NO; YES → done, NO → adapting
    adapting     → re-plan with failure context, then executing again

resume(state)  → restart the loop from a persisted LoopState
getState()     → returns the current LoopState (messages, toolResults, phase)
```

Defaults: `maxIterations = 25`, `maxTimeMs = 300_000`. `StreamEvent` types: `text`, `tool_use`, `tool_result`, `thinking`, `error`, `done`.

**`useStreaming.ts`** — React hook wrapping the engine. Consumes the `AsyncGenerator` and produces React state: `streamingText`, `thinkingText`, `toolUses`, `isDone`, `isStreaming`, `error`. Supports cancellation via `cancelRef`.

---

## Tool System

Each tool defines (via `Tool` interface in `src/Tool.ts`):

```
name, description, inputSchema (Zod),
call(input, context) → ToolResult,
validateInput?, checkPermissions?, isReadOnly?
```

9 tools, lazily loaded via `getAllTools()`:

| Tool | Purpose |
|------|---------|
| `BashTool` | Shell execution (sandboxed via `runSandboxed`) |
| `FileReadTool` | Read files (text, images, PDFs) |
| `FileEditTool` | String-replacement edits |
| `FileWriteTool` | Create/overwrite files |
| `GlobTool` | File pattern matching |
| `GrepTool` | Regex content search |
| `WebFetchTool` | Fetch URL content |
| `WebSearchTool` | Web search |
| `AgentTool` | Spawn sub-agent |

**Permissions:** `PermissionContext` with modes `default` (prompt), `plan` (ask once), `bypass` (auto-approve), `auto` (auto-approve).

`ToolContext`: `{ cwd, env, permissions, sandbox }`.

---

## Provider System

`createProvider(config)` in `src/services/api/client.ts` selects provider by `config.type`. Each provider implements `Provider.stream(messages, tools?) → AsyncGenerator<StreamEvent>`.

| Provider | File | SDK / Transport |
|----------|------|-----------------|
| `anthropic` | `AnthropicProvider.ts` | `@anthropic-ai/sdk` |
| `openai` | `OpenAIProvider.ts` | `openai` |
| `openrouter` | `OpenRouterProvider.ts` | `openai` (custom `baseUrl`, own class) |
| `ollama` | `OllamaProvider.ts` | plain fetch |

**OpenRouter:** `OpenRouterProvider` is a dedicated class (not a re-cast OpenAI provider). Free models available via the `:free` suffix (e.g., `mistralai/mixtral-8x22b-instruct:free`).

**Provider resolution** (`main.tsx`): checks `~/.agentforge/config.json` → `ANTHROPIC_API_KEY` env → `OPENAI_API_KEY` env → Ollama local discovery → `SetupWizard` interactive prompt.

---

## State System

`createStore(initial, onChange?)` — lightweight pub/sub store, no external deps.

```
getState() → T
setState(updater: Partial<T> | ((prev) => Partial<T>))
subscribe(listener) → unsubscribe
```

**`StoreProvider`** — React context wrapper. `useAppState(selector)` reads a slice, `useSetAppState()` returns stable setter.

**`AppState`:**
```
settings: UserSettings { theme, model, provider, maxTokens, costCeilingUsd, permissionMode }
messages: Message[]
streamingText (plain Text for perf, not StreamingMarkdown), streamingToolUses
toolPermissionContext, costState (tokens + USD), notifications, theme
```

**Side effects** (`onChangeAppState`): debounced persist of messages + settings to `~/.agentforge/state.json` and `~/.agentforge/settings.json`.

Selectors: `getActiveToolCalls`, `getCurrentCost`, `getNotificationCount`, `getLastUserMessage`.

---

## Slash Commands

8 commands, registered in REPL. All use `local` (string return, in-process handler).

| Command | Type | Description |
|---------|------|-------------|
| `/cost` | local | Show token usage and cost |
| `/doctor` | local | System diagnostics screen |
| `/help` | local | Available commands |
| `/clear` | local | Clear conversation |
| `/model` | local | Switch/view model |
| `/init` | local | Generate a new harness from description |
| `/config` | local | Configure provider (API key, model) |
| `/exit` | local | Exit CLI |

Dispatch: `/exit/quit`, `/clear`, `/init` handled directly in REPL. All others routed through `findCommand()` from `commands.ts` → lazy-load handler → call with args.

Dispatch: `findCommand` parses `/name args`, matches against registry, loads handler, calls with context.

---

## Builder Module

Description-to-harness generator. Takes a user description and generates a complete `agentforge`-style project.

```
buildHarness(prompt, cwd?, onProgress?)
  → parseIntent(prompt)     → StructuredSpec
  → generatePlan(spec)      → HarnessPlan { files, tools, commands, providers, ... }
  → assembleAndVerify(plan) → BuildResult { success, outputDir, errors }
```

- **`parseIntent`** — keyword-matching intent parser (language, tools, commands, models, security, features).
- **`generatePlan`** — builds file map, tool/command lists, system prompt, theme, verification steps.
- **`assembleAndVerify`** — writes generated files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `src/main.tsx`, `src/Tool.ts`, `src/tools.ts`, `src/commands.ts`, `src/context.ts`, `src/services/provider.ts`, `src/state/AppState.ts`), then runs `bun install` + `tsc --noEmit`. Modular generators in `src/builder/generate/`: `tool-generator.ts`, `command-generator.ts`, `provider-generator.ts`, `ui-generator.ts`.

`/init` invokes this flow from the REPL.

---

## Cost Tracking

`CostTracker` class in `src/cost-tracker.ts`:

- Per-session: `promptTokens`, `completionTokens`, `cost`, `startTime`
- Cumulative: `allTimeCost`, `allTimeTokens`
- Model pricing table: `claude-sonnet-5`, `claude-3-haiku`, `gpt-4o`, `gpt-4o-mini`, `ollama` (free)
- `recordUsage(model, prompt, completion)` → computes cost, updates counters
- `checkBudget(ceilingUsd)` → returns `{ withinBudget, percentUsed }`
- Cost displayed in `StatusLine` and `CostThreshold` dialog

---

## MCP Integration

Two modes:

**AgentForge AS MCP server** (`--mcp` flag):
- Exposes all 9 tools via `ListToolsRequestSchema` / `CallToolRequestSchema`
- Resources: project files (top 50), `.agentforge/config.json`, `state.json`
- Prompts: `system-prompt` template, `generate-harness` config generator
- Transport: stdio via `StdioServerTransport`

**AgentForge CONSUMING MCP servers**:
- `McpClientManager` — connects to external MCP servers (stdio or Streamable HTTP)
- `McpTool` — wraps external MCP tools as internal `Tool` instances
- Config resolution: `src/services/mcp/config.ts`
- Connected servers listed in `StatusLine`

---

## Persistence

```
~/.agentforge/
├── config.json     ← Provider configuration
├── state.json      ← Messages (last 100) + theme
└── settings.json   ← Theme, model preferences
```

Debounced writes (2s timer) via `onChangeAppState`. State survives restarts.

---

## Local Model Deployment

### Ollama

Ollama serves models locally via its HTTP API (`localhost:11434`); it manages CUDA/MPS/ROCm. No GPU orchestration code in AgentForge.

**`src/services/api/providers/OllamaProvider.ts`** — plain `fetch` to `POST /api/chat` with OpenAI-compatible message format:
- Streaming via `ReadableStream` body reader (SSE lines `{"message":{"content":"..."}}`)
- Tool calling via OpenAI-format tool definitions in the request body
- `num_ctx` passed per-request via `options` (default 2048). No dynamic windowing — Ollama silently truncates if context exceeds the model limit.
- Token counts/metrics come from Ollama's response.

### Sandbox

`runSandboxed(command, config?)` in `src/loop/sandbox.ts` — used by `BashTool` (`Bun.spawn`, `AbortSignal.timeout`, pipe-only I/O). Enforces:
- Blocked commands: `rm`, `dd`, `mkfs`, `reboot`, `shutdown`, `halt`
- Blocked write paths: `/`, `/etc`, `/usr`, `/bin`, `/boot`, `/dev`
- Network commands blocked unless `allowNetwork` (`curl`, `wget`, `ssh`, `scp`, ...)
- `maxCpuTimeMs` (default 10 000), `maxOutputSize` (default 1 000 000)

`SandboxConfig` is the extension path for richer policy (allow-list, custom paths).

---

## Gaps

Remaining for full Claude Code-level capability (updated 2026-07-13):

- **Interactive permission prompts**: default policy mode auto-denies unmatched writes; a TUI dialog to approve/deny per call (and remember the rule) is missing in both reference and generated harnesses.
- **Web-based dashboard**: no visual interface for monitoring runs or state.
- **Sandbox depth**: command/policy-level only; container isolation (Docker/Firecracker) needed for untrusted code.
- **Competitor benchmark**: no measured comparison against Claude Code / Codex CLI / OpenCode yet.

Resolved since the last revision: multi-agent (AgentTool + generated subagent.ts), structured output enforcement (builder `completeJSON` with Zod re-prompting), Ink TUI (reference + generated), context compaction, path-rule permissions, skills, session resume.

---

## Dependencies

```
react 18.3.1     ink ^5.2.1       yoga-layout-prebuilt
commander ^15    chalk ^5.6.2     zod ^4.4.3
@anthropic-ai/sdk  openai          @modelcontextprotocol/sdk
marked (streaming markdown)  glob  vitest ^4.1
biome (linting)  typescript ^5
```
