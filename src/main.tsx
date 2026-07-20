#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import chalk from "chalk";
import { Command } from "commander";
import { glob } from "glob";
import pkg from "../package.json";
import { repl } from "./repl";
import { resolveMcpConfig } from "./services/mcp/config";
import { buildSystemPrompt, DEFAULT_BLOCKS } from "./services/system-prompt";
import { setupWizard } from "./setup";
import type { ToolContext } from "./Tool";
import { getAllTools } from "./tools";
import { toErrorMessage } from "./utils/displayError";

export interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	maxTokens: number;
}

import { CONFIG_PATH, resolveProvider } from "./services/api/resolve";

async function ensureConfig(): Promise<{
	config: ProviderConfig;
	showBanner: boolean;
}> {
	if (existsSync(CONFIG_PATH)) {
		return { config: await resolveProvider(), showBanner: false };
	}

	if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
		return { config: await resolveProvider(), showBanner: false };
	}

	const { checkOllamaRunning, listOllamaModels } = await import(
		"./services/ollama/discovery"
	);
	const ollamaRunning = await checkOllamaRunning();
	if (ollamaRunning) {
		const { detectOllamaConfig } = await import("./services/ollama/discovery");
		const config = await detectOllamaConfig();
		if (config) {
			const models = await listOllamaModels();
			console.warn(`✓ Using Ollama (${models.length} models)`);
			return { config, showBanner: false };
		}
		return { config: await resolveProvider(), showBanner: false };
	}

	const config = await setupWizard();
	return { config, showBanner: true };
}

async function startRepl(classic = false, resume = false): Promise<void> {
	try {
		const { config, showBanner } = await ensureConfig();

		process.on("SIGINT", async () => {
			process.removeAllListeners("SIGINT");
			await cleanup();
			process.exit(0);
		});

		process.on("SIGTERM", async () => {
			process.removeAllListeners("SIGTERM");
			await cleanup();
			process.exit(0);
		});

		// Ink TUI needs a real terminal; pipes/CI get the classic readline REPL.
		if (!classic && process.stdout.isTTY && process.stdin.isTTY) {
			const { startTui } = await import("./ui/index");
			await startTui(config, resume);
			await cleanup();
			process.exit(0);
		}

		await repl(config, showBanner, resume);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(toErrorMessage(msg)));
		process.exit(1);
	}
}

async function cleanup(): Promise<void> {
	const mcpConfig = await resolveMcpConfig();
	for (const [name] of Object.entries(mcpConfig.servers)) {
		try {
			const { McpClientManager } = await import("./services/mcp/client");
			const mgr = new McpClientManager();
			await mgr.disconnectServer(name);
		} catch {
			/* ignore */
		}
	}
}

async function startMcpServer(): Promise<void> {
	const tools = await getAllTools();
	const toolCtx: ToolContext = {
		cwd: process.cwd(),
		env: process.env,
		permissions: { mode: "bypass", rules: [] },
		sandbox: "none",
	};

	const server = new Server(
		{ name: "harnage", version: pkg.version },
		{ capabilities: { tools: {}, resources: {}, prompts: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: ((
				t.inputSchema as { toJSONSchema?: () => Record<string, unknown> }
			)?.toJSONSchema?.() ?? t.inputSchema) as Record<string, unknown>,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = tools.find((t) => t.name === req.params.name);
		if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
		const result = await tool.call(req.params.arguments ?? {}, toolCtx);
		return {
			content: [
				{
					type: "text",
					text: result.content ?? JSON.stringify(result.data ?? result),
				},
			],
			isError: result.isError,
		};
	});

	server.setRequestHandler(ListResourcesRequestSchema, async () => {
		const configDir = join(homedir(), ".harnage");
		const projectFiles: Array<{ uri: string; name: string; mimeType: string }> =
			[];
		try {
			const files = await glob("**/*", {
				cwd: process.cwd(),
				ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
				nodir: true,
				absolute: false,
			});
			for (const file of files.slice(0, 50)) {
				projectFiles.push({
					uri: `file://${join(process.cwd(), file)}`,
					name: file,
					mimeType: "text/plain",
				});
			}
		} catch {
			/* ignore glob errors */
		}
		projectFiles.push({
			uri: `file://${join(configDir, "config.json")}`,
			name: ".harnage/config.json",
			mimeType: "application/json",
		});
		return { resources: projectFiles };
	});

	server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
		const uri = req.params.uri;
		if (!uri.startsWith("file://"))
			throw new Error(`Unsupported URI scheme: ${uri}`);
		const filePath = resolve(uri.slice(7));
		const cwd = process.cwd();
		const home = homedir();
		if (!filePath.startsWith(cwd) && !filePath.startsWith(home))
			throw new Error(
				`Access denied: ${filePath} is outside allowed directories`,
			);
		try {
			const content = await readFile(filePath, "utf-8");
			return { contents: [{ uri, mimeType: "text/plain", text: content }] };
		} catch (e) {
			throw new Error(`Failed to read resource: ${(e as Error).message}`);
		}
	});

	server.setRequestHandler(ListPromptsRequestSchema, async () => ({
		prompts: [
			{
				name: "system-prompt",
				description: "harnage system prompt template for harness agents",
				arguments: [
					{
						name: "projectName",
						description: "Name of the project",
						required: false,
					},
					{
						name: "projectDescription",
						description: "Brief project description",
						required: false,
					},
				],
			},
			{
				name: "generate-harness",
				description: "Generate a harness config from a user description",
				arguments: [
					{
						name: "description",
						description: "User description of the desired harness",
						required: true,
					},
					{
						name: "providers",
						description:
							"Comma-separated model providers (anthropic,openai,ollama)",
						required: false,
					},
				],
			},
		],
	}));

	server.setRequestHandler(GetPromptRequestSchema, async (req) => {
		const { name, arguments: args = {} } = req.params;
		if (name === "system-prompt") {
			const projectName = (args.projectName as string) || "harnage Project";
			const projectDescription =
				(args.projectDescription as string) || "An AI-powered agent harness";
			return {
				description: `System prompt for ${projectName}`,
				messages: [
					{
						role: "system",
						content: {
							type: "text",
							text: buildSystemPrompt(DEFAULT_BLOCKS, {
								name: projectName,
								description: projectDescription,
							}),
						},
					},
				],
			};
		}
		if (name === "generate-harness") {
			const description = args.description as string;
			const providers = (args.providers as string) || "anthropic,openai,ollama";
			return {
				description: `Generate harness config for: ${description}`,
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `Generate a complete harnage harness configuration (.harnage/config.json) for the following requirement:\n\n**User Description:** ${description}\n\n**Model Providers to Include:** ${providers}\n\nThe config should include:\n1. Model provider configurations with appropriate models\n2. Routing rules (complexity thresholds, fallback chains)\n3. Cost budgets and rate limits\n4. Tool permissions and sandbox settings\n5. Loop engine safety rails (max iterations, timeout, budget)\n\nOutput valid JSON only.`,
						},
					},
				],
			};
		}
		throw new Error(`Unknown prompt: ${name}`);
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

const program = new Command();

program
	.name("harnage")
	.description("AI Model = Brain. Harness = Hands.")
	.version(pkg.version)
	.option("--mcp", "Run as MCP server instead of interactive REPL")
	.option("--classic", "Use the classic readline REPL instead of the TUI")
	.option("--resume", "Resume the last interrupted loop")
	.action(async (opts) => {
		if (opts.mcp) {
			await startMcpServer();
		} else {
			await startRepl(Boolean(opts.classic), Boolean(opts.resume));
		}
	});

// Conversational, iterative builder (Lovable/Emergent-style): describe → build
// live → refine → rebuild → run. Uses whatever model API is configured as the
// build brain; offline chassis when none.
program
	.command("studio")
	.description(
		"Conversational harness builder — describe, refine, watch it evolve",
	)
	.action(async () => {
		const { studio } = await import("./studio");
		await studio();
	});

// The BUILDER, separate from the reference-harness REPL. By default it drives
// the full bespoke pipeline with the configured build brain (interview → plan →
// generate custom tools/commands/skills → verify-repair). The deterministic
// keyword chassis is the fallback when no brain is reachable, so a harness can
// still be built fully offline.
program
	.command("init [description...]")
	.description(
		"Generate a new harness from a description (uses your build brain)",
	)
	.option(
		"--model <id>",
		"plan with a specific local Ollama model instead of the configured build brain",
	)
	.option("--out <dir>", "output directory (default: current directory)")
	.action(async (descriptionParts: string[] = [], opts) => {
		const description = descriptionParts.join(" ").trim();
		// No description → drop into the conversational studio.
		if (!description) {
			const { studio } = await import("./studio");
			await studio();
			return;
		}
		const { buildHarness } = await import("./builder");
		const { createProvider, createBuildProvider } = await import(
			"./services/api/client"
		);
		let options: Parameters<typeof buildHarness>[3];
		let brainLabel = "offline chassis (no build brain reachable)";
		if (opts.model) {
			options = {
				provider: createProvider({
					type: "ollama",
					model: opts.model,
					baseUrl: "http://localhost:11434",
					maxTokens: 8192,
					contextTokens: 8192,
				}),
				ask: async (_q: string, d: string) => d, // non-interactive: take defaults
			};
			brainLabel = `ollama · ${opts.model}`;
		} else {
			// Build brain by default — same resolution as the studio. If nothing is
			// reachable, options stays undefined and buildHarness uses the keyword path.
			try {
				const { resolveProvider } = await import("./services/api/resolve");
				const cfg = await resolveProvider();
				const reachable =
					cfg.type !== "ollama" ||
					(await fetch(`${cfg.baseUrl ?? "http://localhost:11434"}/api/tags`, {
						signal: AbortSignal.timeout(1500),
					})
						.then((r) => r.ok)
						.catch(() => false));
				if (reachable) {
					options = {
						provider: createBuildProvider(cfg),
						ask: async (_q: string, d: string) => d,
					};
					brainLabel = `${cfg.type} · ${cfg.model}`;
				}
			} catch {
				/* no build brain — fall through to the offline keyword chassis */
			}
		}
		console.log();
		console.log(chalk.bold(`  Building "${description}"`));
		console.log(chalk.dim(`  build brain: ${brainLabel}`));
		console.log();

		// Stage-checklist progress: finished stages stay on screen with their
		// duration; the live stage line redraws with a spinner + elapsed time so
		// a multi-minute build never looks hung.
		const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const t0 = Date.now();
		let stage = "";
		let message = "";
		let stageStart = t0;
		let frame = 0;
		const fmt = (ms: number) =>
			ms < 60_000
				? `${Math.round(ms / 1000)}s`
				: `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
		const drawLive = () => {
			const spin = chalk.cyan(SPIN[frame++ % SPIN.length]);
			process.stdout.write(
				`\r  ${spin} ${chalk.bold(stage.padEnd(10))} ${chalk.dim(message)} ${chalk.dim(`(${fmt(Date.now() - stageStart)})`)}\x1b[K`,
			);
		};
		const ticker = setInterval(() => {
			if (stage) drawLive();
		}, 120);
		const onProgress = (p: { stage: string; message: string }) => {
			if (p.stage !== stage) {
				if (stage) {
					process.stdout.write(
						`\r  ${chalk.green("✓")} ${chalk.bold(stage.padEnd(10))} ${chalk.dim(`(${fmt(Date.now() - stageStart)})`)}\x1b[K\n`,
					);
				}
				stage = p.stage;
				stageStart = Date.now();
			}
			message = p.message;
			drawLive();
		};

		const result = await buildHarness(
			description,
			opts.out,
			onProgress,
			options,
		);
		clearInterval(ticker);
		if (stage) {
			const mark = result.success ? chalk.green("✓") : chalk.red("✗");
			process.stdout.write(
				`\r  ${mark} ${chalk.bold(stage.padEnd(10))} ${chalk.dim(`(${fmt(Date.now() - stageStart)})`)}\x1b[K\n`,
			);
		}
		console.log();
		if (result.success) {
			console.log(
				chalk.green.bold("  ✓ Harness built") +
					chalk.dim(` in ${fmt(Date.now() - t0)}`) +
					(result.repairs ? chalk.dim(` · ${result.repairs} auto-repair`) : ""),
			);
			await printBespokeSummary(result.outputDir);
			console.log(`  ${chalk.bold("Output:")} ${result.outputDir}`);
			console.log(
				chalk.dim(`  cd ${result.outputDir} && bun install && bun start`),
			);
		} else {
			console.log(chalk.red.bold("  ✗ Build failed"));
			for (const e of result.errors)
				console.log(chalk.red(`  - ${e.split("\n")[0]}`));
			process.exit(1);
		}
	});

/** One-glance summary of what makes the generated harness bespoke. */
async function printBespokeSummary(outputDir: string): Promise<void> {
	try {
		const { readdir } = await import("node:fs/promises");
		const baseCommands = new Set([
			"help.ts",
			"clear.ts",
			"model.ts",
			"cost.ts",
			"config.ts",
			"doctor.ts",
			"exit.ts",
		]);
		const commands = (await readdir(`${outputDir}/src/commands`))
			.filter((f) => f.endsWith(".ts") && !baseCommands.has(f))
			.map((f) => `/${f.replace(/\.ts$/, "")}`);
		const skills = (await readdir(`${outputDir}/skills`))
			.filter((f) => f.endsWith(".md") && f !== "verify-before-done.md")
			.map((f) => f.replace(/\.md$/, ""));
		const coreTools = new Set([
			"BashTool",
			"FileReadTool",
			"FileEditTool",
			"FileWriteTool",
			"GlobTool",
			"GrepTool",
			"WebFetchTool",
			"WebSearchTool",
			"AgentTool",
		]);
		const customTools = (await readdir(`${outputDir}/src/tools`)).filter(
			(d) => !d.endsWith(".ts") && !coreTools.has(d),
		);
		if (customTools.length)
			console.log(`  ${chalk.bold("Custom tools:")} ${customTools.join(", ")}`);
		if (commands.length)
			console.log(`  ${chalk.bold("Commands:")} ${commands.join(" · ")}`);
		if (skills.length)
			console.log(`  ${chalk.bold("Skills:")} ${skills.join(" · ")}`);
	} catch {
		/* summary is cosmetic — never fail the build output over it */
	}
}

process.on("unhandledRejection", (reason) => {
	console.error(
		"Unhandled rejection:",
		reason instanceof Error ? reason.message : reason,
	);
});
process.on("uncaughtException", (err) => {
	console.error("Uncaught exception:", err.message);
	process.exit(1);
});

program.parse();
