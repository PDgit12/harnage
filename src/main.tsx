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
		{ name: "harnage", version: "0.1.0" },
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
	.version("0.1.0")
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

// The BUILDER, separate from the reference-harness REPL. Generating a harness
// needs no model (the deterministic chassis builds offline); a model only makes
// the plan smarter. So `harnage init` never connects to one unless you ask.
program
	.command("init <description...>")
	.description("Generate a new harness from a description (no model required)")
	.option(
		"--model <id>",
		"optionally use a local Ollama model to plan the harness",
	)
	.option("--out <dir>", "output directory (default: current directory)")
	.action(async (descriptionParts: string[], opts) => {
		const description = descriptionParts.join(" ").trim();
		const { buildHarness } = await import("./builder");
		let options: Parameters<typeof buildHarness>[3];
		if (opts.model) {
			const { createProvider } = await import("./services/api/client");
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
		}
		console.log(
			chalk.dim(
				`Building "${description}"${opts.model ? ` — planning with ${opts.model}` : " — offline"}…`,
			),
		);
		const result = await buildHarness(
			description,
			opts.out,
			(p) => {
				process.stdout.write(
					`\r  ${chalk.dim(p.stage.padEnd(10))} ${chalk.dim(p.message)}\x1b[K`,
				);
			},
			options,
		);
		process.stdout.write("\r\x1b[K");
		if (result.success) {
			console.log(chalk.green.bold("✓ Harness built"));
			console.log(`  ${chalk.bold("Output:")} ${result.outputDir}`);
			console.log(
				chalk.dim(`  cd ${result.outputDir} && bun install && bun start`),
			);
		} else {
			console.log(chalk.red.bold("✗ Build failed"));
			for (const e of result.errors) console.log(chalk.red(`  - ${e}`));
			process.exit(1);
		}
	});

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
