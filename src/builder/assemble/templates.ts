import type { HarnessPlan } from "../index";

export const PACKAGE_JSON_TEMPLATE = (plan: HarnessPlan) => ({
	name: plan.name,
	module: "src/main.tsx",
	type: "module",
	private: true,
	bin: {
		[plan.name]: "./src/main.tsx",
	},
	scripts: {
		start: "bun src/main.tsx",
		dev: "bun --watch src/main.tsx",
		// Offline deployment: one self-contained binary (bun runtime + all deps
		// bundled), runs on an air-gapped box with no node_modules. See DEPLOY.md.
		build: `bun build src/main.tsx --compile --outfile ${plan.name}`,
		typecheck: "tsc --noEmit",
		test: "vitest run",
		lint: "echo 'No linter configured yet'",
	},
	dependencies: {
		commander: "^15.0.0",
		chalk: "^5.6.2",
		zod: "^4.4.3",
		// always included: generated main.tsx embeds the --mcp server mode
		"@modelcontextprotocol/sdk": "^1.29.0",
		// TUI (framed input, streaming, tool status) — --classic skips it
		react: "^18.3.1",
		ink: "^5.2.1",
		"ink-text-input": "^6.0.0",
		// ink statically imports this; without it `bun build --compile` can't
		// resolve it and the offline binary fails to build.
		"react-devtools-core": "^6.1.1",
		...(plan.providers.includes("anthropic")
			? { "@anthropic-ai/sdk": "^0.110.0" }
			: {}),
		...(plan.providers.includes("openai") ? { openai: "^6.45.0" } : {}),
	},
	devDependencies: {
		typescript: "^5.7.0",
		vitest: "^4.1.10",
		"@types/bun": "latest",
		"@types/react": "^18.3.0",
	},
	peerDependencies: {
		typescript: "^5",
	},
});

export const MAIN_ENTRY_TEMPLATE = (plan: HarnessPlan) => `#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as stdIn, stdout as stdOut } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { Command } from "commander";

import { LoopEngine, type ProviderConfig } from "./engine.ts";
import { makeAgentTool } from "./subagent.ts";
import { resolveProfile } from "./profiles.ts";
import { loadSession } from "./session.ts";
import { loadSkills } from "./skills.ts";
import { printTrace } from "./trace.ts";

// ─── Config ──────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".${plan.name}");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

async function resolveProviderConfig(): Promise<ProviderConfig> {
  let type: ProviderConfig["type"] = "openrouter";
  let model = "gpt-4o";
  let baseUrl: string | undefined;
  let maxTokens = 8192;
  if (existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<ProviderConfig>;
      type = saved.type ?? type;
      model = saved.model ?? model;
      baseUrl = saved.baseUrl;
      maxTokens = saved.maxTokens ?? maxTokens;
    } catch { /* ignore */ }
  }
  const envKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (envKey) return { type, model, apiKey: envKey, baseUrl, maxTokens };
  const localModel = await detectLocalModel();
  return { type: "ollama", model: localModel, baseUrl: "http://localhost:11434", maxTokens: 4096, contextTokens: 8192 };
}

// This harness was packed for "${plan.defaultLocalModel ?? "llama3"}" at build
// time; at runtime we prefer what's installed AND runs at usable speed on
// this machine (speed-first caps: 16GB→8B, 32GB→14B, 64GB→33B, 96GB+→70B).
async function detectLocalModel(): Promise<string> {
  const packed = "${plan.defaultLocalModel ?? "llama3"}";
  try {
    const { totalmem } = await import("node:os");
    const ramGb = totalmem() / 1024 ** 3;
    const maxParams = ramGb >= 96 ? 70 : ramGb >= 64 ? 33 : ramGb >= 32 ? 14 : ramGb >= 16 ? 8 : 4;
    const size = (n: string) => Number.parseFloat(n.match(/(\\d+(?:\\.\\d+)?)b/i)?.[1] ?? "0");
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      const all = (data.models ?? []).map(m => m.name).filter(n => !n.includes("embed"));
      // Agents need tool calling — keep only models whose capabilities include "tools".
      const capable: string[] = [];
      for (const n of all) {
        try {
          const show = await fetch("http://localhost:11434/api/show", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: n }), signal: AbortSignal.timeout(2000),
          });
          if (show.ok) {
            const info = await show.json() as { capabilities?: string[] };
            if (info.capabilities?.includes("tools")) capable.push(n);
          }
        } catch { /* skip */ }
      }
      const names = capable.length ? capable : all;
      const fitting = names.filter(n => size(n) <= maxParams);
      if (fitting.includes(packed)) return packed;
      if (fitting.length) return fitting.sort((a, b) => size(b) - size(a))[0];
      if (names.includes(packed)) return packed;
      if (names.length) return names[0];
    }
  } catch { /* ollama not running */ }
  return packed;
}

async function listLocalModels(): Promise<string[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map(m => m.name).filter(n => !n.includes("embed"));
  } catch { return []; }
}

async function ensureConfig(): Promise<ProviderConfig> {
  const existing = await resolveProviderConfig();
  if (existing.apiKey || existing.type === "ollama") return existing;

  console.log(chalk.yellow("\\nNo provider configured. Quick setup:"));
  const rl = createInterface({ input: stdIn, output: stdOut });
  console.log("  1) OpenRouter (many models, needs API key)");
  console.log("  2) Ollama (local, free)");
  const choice = (await rl.question("  Choice [2]: ")).trim();
  const type = choice === "1" ? "openrouter" : "ollama";
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let modelDefault = type === "openrouter" ? "gpt-4o" : "${plan.defaultLocalModel ?? "llama3"}";
  if (type === "openrouter") {
    apiKey = (await rl.question("  API key: ")).trim();
  } else {
    baseUrl = (await rl.question("  Ollama URL [http://localhost:11434]: ")).trim() || "http://localhost:11434";
    const installed = await listLocalModels();
    if (installed.length) {
      console.log(chalk.dim("  Installed models:"));
      installed.forEach((m, i) => console.log(\`    \${i + 1}) \${m}\`));
      const pick = (await rl.question(\`  Pick a model [1]: \`)).trim();
      const idx = Number.parseInt(pick, 10);
      modelDefault = installed[Number.isFinite(idx) && idx >= 1 && idx <= installed.length ? idx - 1 : 0];
    }
  }
  const model = (await rl.question(\`  Model [\${modelDefault}]: \`)).trim() || modelDefault;
  const config: ProviderConfig = { type, model, maxTokens: type === "ollama" ? 4096 : 8192, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
  await mkdir(CONFIG_DIR, { recursive: true });
  // ponytail: never persist apiKey to disk; set OPENROUTER_API_KEY or OPENAI_API_KEY env var instead
  await writeFile(CONFIG_PATH, JSON.stringify({ type: config.type, model: config.model, baseUrl: config.baseUrl, maxTokens: config.maxTokens }, null, 2));
  rl.close();
  return config;
}

function showBanner(): void {
  console.log(chalk.cyan(\`
╔══════════════════════════════════╗
║    ${plan.name.padEnd(30)}║
║    ${plan.description.slice(0, 28).padEnd(30)}║
╚══════════════════════════════════╝\`));
}

// ─── REPL ────────────────────────────────────────────────────────

async function startTuiApp(resume: boolean): Promise<void> {
  const config = await ensureConfig();
  const profile = resolveProfile(config.model, config.contextTokens);
  const { getAllTools } = await import("./tools.ts");
  const tools = await getAllTools();
  tools.push(makeAgentTool(tools, { tools, providerConfig: config, profile }));
  const skills = await loadSkills();
  const session = loadSession();
  const initialMessages = resume ? (session?.messages ?? undefined) : undefined;
  const unfinishedGoal = session && session.done === false && session.goal ? session.goal : undefined;
  // With --resume, continue the unfinished goal automatically; without it,
  // just surface a hint so an interrupted task is never silently forgotten.
  const resumeGoal = resume ? unfinishedGoal : undefined;
  const unfinishedHint = !resume ? unfinishedGoal : undefined;

  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("./ui.tsx");
  const { waitUntilExit } = render(
    React.createElement(App, { config, tools, skills, initialMessages, profile, resumeGoal, unfinishedHint }),
  );
  await waitUntilExit();
  process.exit(0);
}

async function startRepl(resume = false): Promise<void> {
  try {
    const config = await ensureConfig();
    showBanner();
    const profile = resolveProfile(config.model, config.contextTokens);
    console.log(chalk.dim(\`Provider: \${config.type} | Model: \${config.model}\`));
    console.log(chalk.dim(\`Scaffold: \${profile.tier} tier · \${profile.loop} loop · \${profile.toolCalling} dispatch · \${profile.maxTools} tools\\n\`));
    const { getAllTools } = await import("./tools.ts");
    const tools = await getAllTools();
    tools.push(makeAgentTool(tools, { tools, providerConfig: config, profile }));

    const skills = await loadSkills();
    if (skills.length) console.log(chalk.dim(\`Skills loaded: \${skills.map(s => s.name).join(", ")}\`));

    let initialMessages: Array<Record<string, unknown>> | undefined;
    let resumeGoal: string | undefined;
    if (resume) {
      const session = loadSession();
      if (session) {
        initialMessages = session.messages;
        console.log(chalk.dim(\`Resumed session from \${session.savedAt} (\${session.messages.length} messages)\`));
        if (session.done === false && session.goal) resumeGoal = session.goal;
      } else {
        console.log(chalk.dim("No saved session to resume."));
      }
    } else {
      // Continuous-loop affordance: a run that crashed or was killed left
      // done=false on disk — surface it instead of silently starting fresh.
      const prev = loadSession();
      if (prev && prev.done === false && prev.goal) {
        console.log(chalk.yellow(\`Unfinished task from last session: "\${prev.goal.slice(0, 120)}" — restart with --resume to continue it.\`));
      }
    }

    const rl = createInterface({ input: stdIn, output: stdOut });
    rl.setPrompt(chalk.cyan("> "));

    // Mid-task resume: the saved session ended with an unfinished goal, so
    // continue it immediately — the transcript already holds all prior steps.
    if (resumeGoal) {
      console.log(chalk.yellow(\`Resuming unfinished task: "\${resumeGoal.slice(0, 120)}"\`));
      const engine = new LoopEngine({ tools, providerConfig: config, skills, initialMessages, profile });
      const result = await engine.run("Continue the unfinished task from this transcript exactly where it left off: " + resumeGoal);
      initialMessages = engine.getMessages();
      console.log(result);
    }
    rl.prompt();

    rl.on("line", async (line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("/")) {
        try {
          const { COMMANDS, findCommand } = await import("./commands.ts");
          const found = findCommand(trimmed);
          if (found) {
            const handler = await found.command.load();
            const result = await handler.call(() => {}, { config }, found.args);
            if (result.value) console.log(result.value);
          } else {
            console.log(chalk.yellow(\`Unknown command. Type /help.\`));
          }
        } catch (e) {
          console.log(chalk.red(\`Error: \${e instanceof Error ? e.message : e}\`));
        }
      } else if (trimmed) {
        console.log(chalk.dim(\`[Processing: \${config.model}]\\n\`));
        const engine = new LoopEngine({ tools, providerConfig: config, skills, initialMessages, profile });
        const result = await engine.run(trimmed);
        initialMessages = engine.getMessages();
        console.log(result);
      }
      rl.prompt();
    });

    rl.on("close", () => { console.log("\\nGoodbye!"); process.exit(0); });
  } catch (e) {
    console.error(chalk.red(\`Fatal: \${e instanceof Error ? e.message : e}\`));
    process.exit(1);
  }
}

// ─── MCP Server ─────────────────────────────────────────────────

async function startMcpServer(): Promise<void> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const { getAllTools } = await import("./tools.ts");
  const tools = await getAllTools();
  const ctx = { cwd: process.cwd(), env: process.env as Record<string, string | undefined>, permissions: { mode: "default" as const, rules: [] }, sandbox: "none" };

  const server = new Server({ name: "${plan.name}", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema.toJSONSchema?.() ?? t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) throw new Error(\`Unknown tool: \${req.params.name}\`);
    const result = await tool.call(req.params.arguments ?? {}, ctx);
    return { content: [{ type: "text", text: result.content ?? JSON.stringify(result.data ?? "") }], isError: result.isError };
  });
  await server.connect(new StdioServerTransport());
}

// ─── Entry ───────────────────────────────────────────────────────

const program = new Command();
program.name("${plan.name}").description("${plan.description}").version("0.1.0").option("--mcp", "Run as MCP server").option("--resume", "Resume the previous session").option("--classic", "Use the classic readline REPL instead of the TUI").action(async (opts) => {
  if (opts.mcp) { await startMcpServer(); return; }
  if (!opts.classic && process.stdout.isTTY && process.stdin.isTTY) {
    await startTuiApp(Boolean(opts.resume));
    return;
  }
  await startRepl(Boolean(opts.resume));
});
program.command("trace").description("Summarize the local audit trail: runs, latency, tool calls, eval pass rate").action(() => { printTrace(); });
program.parse();
`;

export const TOOLS_REGISTRY = (
	plan: HarnessPlan,
) => `import type { Tool } from "./Tool.ts";

const toolModules = {
${plan.tools
	.map((t) => {
		const name =
			t.charAt(0).toUpperCase() +
			t.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
		return `  ${name}: () => import("./tools/${name}Tool/${name}Tool.ts"),`;
	})
	.join("\n")}
} as const;

export type ToolName = keyof typeof toolModules;

const toolNames: ToolName[] = Object.keys(toolModules) as ToolName[];

export function getTool(name: string): Promise<Tool> {
  const mod = toolModules[name as ToolName];
  if (!mod) {
    const withSuffix = toolModules[\`\${name}Tool\` as ToolName];
    if (withSuffix) return withSuffix().then((m: any) => (m.default ?? m[\`\${name}Tool\`] ?? m) as Tool);
    throw new Error(\`Unknown tool: \${name}. Available: \${toolNames.join(", ")}\`);
  }
  return mod().then((m: any) => {
    const tool = (m.default ?? m[\`\${name}Tool\`] ?? m) as Tool;
    return tool;
  });
}

export function getAllTools(): Promise<Tool[]> {
  return Promise.all(toolNames.map((name) => getTool(name)));
}
`;

export const TOOL_TYPESCRIPT = `import { z } from "zod";

export interface ToolContext {
  cwd: string;
  env: Record<string, string | undefined>;
  permissions: { mode: "default" | "plan" | "bypass" | "auto"; rules: Array<{ pattern: string; allow: boolean }> };
  sandbox: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

export interface ToolResult<T = unknown> {
  data?: T;
  error?: string;
  content?: string;
  isError?: boolean;
  newMessages?: Array<{ role: string; content: string }>;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  validateInput?(input: TInput): ValidationResult | Promise<ValidationResult>;
  checkPermissions?(input: TInput, context: ToolContext): PermissionResult | Promise<PermissionResult>;
  call(input: TInput, context: ToolContext): ToolResult<TOutput> | Promise<ToolResult<TOutput>>;
  isReadOnly?(input: TInput): boolean;
}
`;

export const GITIGNORE_TEMPLATE = `node_modules/
.harnage-build-*/
config.json
`;

export const TSCONFIG_TEMPLATE = {
	compilerOptions: {
		target: "ESNext",
		module: "ESNext",
		moduleResolution: "bundler",
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		allowImportingTsExtensions: true,
		jsx: "react-jsx",
		paths: { "@/*": ["./src/*"] },
	},
	include: ["src"],
};

export const VITEST_CONFIG = `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
`;

export const COMMANDS_REGISTRY = (plan: HarnessPlan) => {
	// Bespoke commands the build brain generated for this harness's domain,
	// registered alongside the base set so the TUI slash-menu surfaces them.
	const custom = (plan.customCommands ?? [])
		.map((c) => {
			const id = c.name
				.toLowerCase()
				.replace(/^\//, "")
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "")
				.slice(0, 30);
			return `  { type: "local", name: "/${id}", description: ${JSON.stringify(c.description).replace(/`/g, "\\`")}, load: () => import("./commands/${id}.ts") },`;
		})
		.join("\n");
	return `export interface Command {
  type: "local";
  name: string;
  description: string;
  load: () => Promise<any>;
}

export const COMMANDS: Command[] = [
  { type: "local", name: "/cost", description: "Show token usage and cost", load: () => import("./commands/cost.ts") },
  { type: "local", name: "/doctor", description: "Run system diagnostics", load: () => import("./commands/doctor.ts") },
  { type: "local", name: "/help", description: "Show available commands", load: () => import("./commands/help.ts") },
  { type: "local", name: "/clear", description: "Clear the conversation", load: () => import("./commands/clear.ts") },
  { type: "local", name: "/model", description: "Switch or view current model", load: () => import("./commands/model.ts") },
  { type: "local", name: "/config", description: "Configure provider", load: () => import("./commands/config.ts") },
  { type: "local", name: "/exit", description: "Exit the CLI", load: () => import("./commands/exit.ts") },
  { type: "local", name: "/calibrate", description: "Measure this model and pick its best loop/edit-format", load: () => import("./commands/calibrate.ts") },
${custom}
];

export function findCommand(input: string): { command: Command; args: string[] } | null {
  const parsed = parseSlashCommand(input);
  if (!parsed) return null;
  const cmd = COMMANDS.find((c) => c.name === parsed.name);
  if (!cmd) return null;
  return { command: cmd, args: parsed.args };
}

export function parseSlashCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\\s+/);
  const name = parts[0];
  if (!name) return null;
  return { name: \`/\${name}\`, args: parts.slice(1) };
}
`;
};

export const PROVIDER_SERVICE = `type CostTracker = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  requestCount: number;
};

let activeModel = "llama3";
const availableModels = ["llama3", "claude-sonnet-5", "gpt-4o"];
const costTracker: CostTracker = { tokensIn: 0, tokensOut: 0, costUsd: 0, requestCount: 0 };

export function setActiveModel(model: string): void {
  activeModel = model;
}

export function getActiveModel(): string {
  return activeModel;
}

export function getAvailableModels(): string[] {
  return [...availableModels];
}

export function getCostTracker(): CostTracker {
  return costTracker;
}

export function trackUsage(tokensIn: number, tokensOut: number): void {
  costTracker.tokensIn += tokensIn;
  costTracker.tokensOut += tokensOut;
  costTracker.requestCount += 1;
  costTracker.costUsd += (tokensIn * 3 + tokensOut * 15) / 1_000_000;
}
`;

export const DEPLOY_MD_TEMPLATE = (
	plan: HarnessPlan,
) => `# Deploying ${plan.name} — air-gapped / on-premises

This harness runs entirely on your own hardware. Nothing leaves the machine.
See SECURITY.md for the security posture; this is the install path.

## Option A — self-contained binary (recommended for air-gap)

On a machine WITH network (build once):

\`\`\`bash
bun install
bun run build          # → ./${plan.name}  (bun runtime + all deps bundled)
sha256sum ${plan.name} # record the checksum for your security team
\`\`\`

Ship the single \`${plan.name}\` binary to the air-gapped box. It needs **no
node_modules, no bun, no network** to run:

\`\`\`bash
./${plan.name}            # TUI
./${plan.name} --classic  # plain REPL
\`\`\`

## Option B — run from source (dev / connected)

\`\`\`bash
bun install
bun start
\`\`\`

## The model (also local)

This harness talks to a model you host. For a sovereign deployment that is a
local Ollama instance:

\`\`\`bash
ollama serve                 # http://localhost:11434
ollama pull qwen2.5:3b       # or your approved model, on a connected machine…
\`\`\`

For a fully air-gapped box: pull the model on a connected machine, copy the
Ollama model blobs (\`~/.ollama/models\`) across, or serve from your internal
registry. The harness makes no outbound call other than to this local endpoint —
verify with the egress check in the project it was generated from.

## Verify the deployment

\`\`\`bash
./${plan.name} --classic     # starts with no network → prints its scaffold tier
./${plan.name} trace         # ops summary: runs, latency, tool calls, eval pass rate
# after a run, inspect the local audit trail:
cat ~/.${plan.name}/audit.jsonl
# and the permission policy your security team pins:
cat ~/.${plan.name}/permissions.json
\`\`\`

## Optional hardening

- \`HARNAGE_SANDBOX=docker\` — run every shell command in \`docker run --rm
  --network none\`, working dir mounted, no network.
- \`HARNAGE_AUDIT=off\` — disable the audit trail (on by default).
- \`HARNAGE_MEMORY=off\` — disable long-term memory reads/writes.
- \`HARNAGE_JUDGE=on\` — add an LLM-as-judge score to each run's eval (costs a call).

## Evaluation & ops (LLMops, local)

Every top-level run is graded in-loop: deterministic quality rules always run
(empty/stopped/non-prose/tool-use checks), and \`HARNAGE_JUDGE=on\` adds a 1–5
LLM-as-judge score. Verdicts are appended to the local audit trail — nothing
leaves the machine — and \`${plan.name} trace\` summarizes runs, latency, tool
calls, and eval pass rate in the terminal. No external tracing service.
`;

export const SECURITY_MD_TEMPLATE = (
	plan: HarnessPlan,
) => `# Security posture — ${plan.name}

Written for a security reviewer evaluating an on-premises deployment.

## Data flow
- The harness runs a model through a provider you configure. For a sovereign
  deployment that is a local Ollama endpoint (\`http://localhost:11434\`) — the
  loop's only network call is to that local address.
- Prompts, source, tool output, and model responses **stay on the machine**.
  Nothing is sent to a third party in the local configuration.
- Hosted providers exist in code but are **dormant unless you configure one**.

## No phone-home
There is no telemetry, usage tracking, or crash reporting. The only outbound
endpoint is the model provider you set. (The generator ships an \`egress\` check
that scans generated code for unexpected hosts.)

## Audit trail
Every run appends to \`~/.${plan.name}/audit.jsonl\` (JSONL, local, never
transmitted): run boundaries, every tool execution and its target, and
denied/rejected tool calls. On by default; \`HARNAGE_AUDIT=off\` to disable.

## Long-term memory — local, sovereign
Durable facts and dated events the agent learns are stored in a local SQLite DB
at \`~/.${plan.name}/memory.db\` (semantic + episodic tiers). It is written and
read only on this machine and never transmitted. Inspect it with any SQLite
client; delete the file to wipe memory. On by default; \`HARNAGE_MEMORY=off\`
disables all reads and writes. Retrieval is deterministic keyword matching — no
model decides what to recall, and sub-agents never write to the store.

## Permission model — deny-first, policy-as-file
Tool calls are checked before execution; a tool with no matching allow rule is
blocked, not run. The policy is a plain inspectable file at
\`~/.${plan.name}/permissions.json\` your security team can pin to an allow-list.

## Shell isolation (opt-in)
\`HARNAGE_SANDBOX=docker\` runs every shell command in
\`docker run --rm --network none\` against a pinned image, working directory
mounted, no network. Commands pass as argv, never interpolated into a host shell.

## What you own
The entire harness is generated TypeScript source — no compiled blobs, no runtime
dependency on the generator. Read it, fork it, pin it, review it. Not a black box.
`;
