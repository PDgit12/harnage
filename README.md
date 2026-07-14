# AgentForge

> **AI Model = Brain. Harness = Hands.** A goal-driven AI coding assistant that runs in your terminal or as an MCP server.

## Quick Start

```bash
# Prerequisites: bun + Ollama (or an Anthropic/OpenAI API key)

# 1. Install
git clone <repo>
cd agentforge
bun install
bun run build
./agentforge
```

That's it. On first run, AgentForge auto-detects:
1. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` env vars → uses those immediately
2. Running Ollama instance → uses `llama3` (or whatever you have pulled)
3. Nothing found → shows setup wizard

Inside the REPL, just type your goal. The loop handles the rest.

## Usage

| Command | What it does |
|---------|--------------|
| `agentforge` | Opens interactive REPL with goal-driven loop |
| `agentforge --mcp` | Runs as MCP server (connect from Claude Code, Cursor, etc.) |

## Slash Commands (inside REPL)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/config` | Change provider/model/settings |
| `/cost` | Show token usage and cost |
| `/clear` | Clear conversation |
| `/model` | Switch model |
| `/doctor` | Run diagnostics |
| `/init` | Generate a harness config from description |
| `/exit` | Quit |

## Tools

All 9 built-in tools are available to the agent: Bash, File Read/Write/Edit, Glob, Grep, Web Search, Web Fetch, and Agent spawning.

## Beta Status

What to expect:
- **Works**: REPL, MCP server, all tools, provider switching, cost tracking, permission dialogs
- **Needs testing**: provider API edge cases, cross-platform terminal behavior, crash recovery
- **Dogfood it**: use it for your daily work, report what breaks

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run test        # vitest (9 suites)
bun run build       # compile to binary
```
