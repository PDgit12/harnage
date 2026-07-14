import * as readline from "node:readline";
import chalk from "chalk";
import type { LocalCommandHandler } from "./commands";
import { COMMANDS, findCommand } from "./commands";
import { conversation } from "./conv";
import { costTracker } from "./cost-tracker";
import { LoopEngine } from "./loop/LoopEngine";
import { createProvider, type ProviderConfig } from "./services/api/client";
import { loadMcpTools } from "./services/mcp/tools";
import { buildSystemPrompt, DEFAULT_BLOCKS } from "./services/system-prompt";
import type { Tool, ToolContext } from "./Tool";
import { getAllTools } from "./tools";
import { formatInline } from "./utils/md";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function printBanner() {
	console.log(chalk.cyan(chalk.bold("  ⚙ AgentForge  ")) + chalk.dim("v0.1.0"));
	console.log(chalk.dim("  ─────────────────────────────────────"));
	console.log(chalk.dim("  Model = Brain · Harness = Hands"));
	console.log();
	console.log(
		"  Type " +
			chalk.cyan("/init") +
			chalk.dim(" to build a harness  ·  ") +
			chalk.cyan("/help") +
			chalk.dim(" for commands  ·  ") +
			chalk.cyan("/exit") +
			chalk.dim(" to quit"),
	);
	console.log();
}

function printStatus(config: ProviderConfig) {
	const u = costTracker.getSessionUsage();
	const c = u.cost > 0.1 ? chalk.red : chalk.yellow;
	process.stdout.write(
		chalk.dim(
			`\u2500 model: ${config.model} \u2500 cost: ${c(`$${u.cost.toFixed(4)}`)} \u2500 tokens: ${(u.promptTokens + u.completionTokens).toLocaleString()}\n`,
		),
	);
}

function toolLabel(
	name: string | undefined,
	input: Record<string, unknown>,
): string {
	const cmd = (input.command ?? input.cmd ?? "") as string;
	const preview = cmd
		? `\`${cmd.slice(0, 100).replace(/\n/g, "\\n")}${cmd.length > 100 ? "..." : ""}\``
		: "";
	const n = name ?? "Tool";
	return preview ? `${chalk.yellow(n)} ${chalk.dim(preview)}` : chalk.yellow(n);
}

export async function initEngine(
	config: ProviderConfig,
	allTools: Tool[],
	toolContext: ToolContext,
): Promise<LoopEngine> {
	const { loadSkills, skillsPromptBlock } = await import("./skills");
	const skills = await loadSkills();
	const systemPrompt =
		buildSystemPrompt(DEFAULT_BLOCKS, {
			name: "agentforge",
			description: "AI Model = Brain. Harness = Hands.",
			tools: allTools.map((t) => t.name),
		}) + skillsPromptBlock(skills);
	return new LoopEngine({
		provider: createProvider(config),
		tools: allTools,
		toolContext,
		model: config.model,
		systemPrompt,
		costTracker,
	});
}

export async function repl(
	config: ProviderConfig,
	showBanner: boolean,
	resume = false,
): Promise<void> {
	if (showBanner) printBanner();

	const allTools = await getAllTools();
	const mcpTools = await loadMcpTools().catch(() => [] as Tool[]);
	allTools.push(...mcpTools);

	const { loadPolicy } = await import("./permissions");
	const toolContext: ToolContext = {
		cwd: process.cwd(),
		env: process.env as Record<string, string | undefined>,
		permissions: loadPolicy(),
		sandbox: "none",
		tools: allTools,
	};

	const engine = await initEngine(config, allTools, toolContext);

	if (resume) {
		const { recoverLastLoop } = await import("./loop/persistence");
		const state = await recoverLastLoop();
		if (state) {
			console.log(
				chalk.dim(
					`Resuming loop "${state.goal?.slice(0, 60) ?? "?"}" (iteration ${state.iteration})...`,
				),
			);
			try {
				for await (const event of engine.resume(state)) {
					if (event.type === "text")
						process.stdout.write(formatInline(event.content ?? ""));
					else if (event.type === "tool_use")
						process.stdout.write(
							`\n  ${chalk.dim("↳")} ${toolLabel(event.name, event.input ?? {})}\n`,
						);
					else if (event.type === "error")
						process.stdout.write(
							`\n  ${chalk.red("✖")} ${event.content ?? "Error"}\n`,
						);
				}
				process.stdout.write("\n");
			} catch (err) {
				console.log(
					chalk.red(
						`Resume failed: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
			}
		} else {
			console.log(chalk.dim("No interrupted loop to resume."));
		}
	}

	const completer = (line: string): [string[], string] => {
		const hits = line.startsWith("/")
			? COMMANDS.filter((c) => c.name.startsWith(line)).map((c) => `${c.name} `)
			: [];
		return [hits.length > 0 ? hits : COMMANDS.map((c) => `${c.name} `), line];
	};

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: chalk.dim("> "),
		completer,
	});

	let streaming = false;

	rl.on("line", async (line) => {
		const trimmed = line.trim();
		if (!trimmed || streaming) {
			rl.prompt();
			return;
		}

		if (trimmed === "/exit" || trimmed === "/quit") {
			rl.close();
			return;
		}

		if (trimmed === "/clear") {
			console.clear();
			printStatus(config);
			rl.prompt();
			return;
		}

		const matched = findCommand(trimmed);
		if (matched) {
			try {
				const mod = await matched.command.load();
				const handler = mod.default as LocalCommandHandler;
				const result = await handler.call(matched.args, {});
				if (result.value === "EXIT_APP") {
					rl.close();
					return;
				}
				if (result.value === "CLEAR_MESSAGES") {
					console.clear();
					printStatus(config);
				} else {
					console.log(result.value);
				}
			} catch (err) {
				console.log(
					chalk.red(`  ✖ ${err instanceof Error ? err.message : String(err)}`),
				);
			}
			rl.prompt();
			return;
		}

		streaming = true;
		rl.pause();

		conversation.push({
			role: "user",
			content: trimmed,
			timestamp: Date.now(),
		});

		const before = costTracker.getSessionUsage();

		console.log(chalk.bold("  You") + chalk.dim(": ") + trimmed);

		let spinner: ReturnType<typeof setInterval> | null = null;
		let spinI = 0;
		let printedAgent = false;
		let hasText = false;
		let toolOut = false;
		let full = "";

		const startSpin = () => {
			spinI = 0;
			spinner = setInterval(() => {
				process.stdout.write(
					`\r${chalk.cyan(SPINNER[spinI % SPINNER.length])} ${chalk.dim("thinking...")}  `,
				);
				spinI++;
			}, 80);
		};
		const stopSpin = () => {
			if (spinner) {
				clearInterval(spinner);
				spinner = null;
			}
		};
		const showAgent = () => {
			if (!printedAgent) {
				process.stdout.write(chalk.bold("  Agent") + chalk.dim(": "));
				printedAgent = true;
			}
		};

		startSpin();

		try {
			for await (const event of engine.run(trimmed)) {
				switch (event.type) {
					case "text":
						if (!hasText) {
							stopSpin();
							if (toolOut) {
								process.stdout.write("\n");
								toolOut = false;
							}
							showAgent();
							hasText = true;
						}
						full += event.content ?? "";
						process.stdout.write(formatInline(event.content ?? ""));
						break;
					case "tool_use":
						stopSpin();
						hasText = false;
						if (printedAgent) {
							process.stdout.write("\n");
							printedAgent = false;
						}
						process.stdout.write(
							`\n  ${chalk.dim("\u21b3")} ${toolLabel(event.name, event.input ?? {})}`,
						);
						toolOut = true;
						startSpin();
						break;
					case "error":
						stopSpin();
						process.stdout.write(
							`\n  ${chalk.red("\u2716")} ${event.content ?? "Error"}`,
						);
						break;
				}
			}
		} catch (err) {
			stopSpin();
			process.stdout.write(
				`\n  ${chalk.red(`\u2716 Error: ${err instanceof Error ? err.message : String(err)}`)}`,
			);
		} finally {
			stopSpin();
		}

		if (full)
			conversation.push({
				role: "assistant",
				content: full,
				timestamp: Date.now(),
			});

		if (!printedAgent && !toolOut) {
			process.stdout.write("\r\x1b[K");
		} else if (hasText) {
			process.stdout.write("\n");
		} else {
			process.stdout.write("\r\x1b[K");
		}

		const after = costTracker.getSessionUsage();
		const cost = after.cost - before.cost;
		const pt = after.promptTokens - before.promptTokens;
		const ct = after.completionTokens - before.completionTokens;
		console.log(
			chalk.dim(
				`  \u2514 Cost: $${cost.toFixed(4)} \u00b7 ${pt.toLocaleString()} in / ${ct.toLocaleString()} out`,
			),
		);

		printStatus(config);
		streaming = false;
		rl.resume();
		rl.prompt();
	});

	rl.on("SIGINT", () => {
		if (streaming) streaming = false;
		rl.close();
	});

	rl.on("close", () => {
		process.stdout.write("\n");
		process.exit(0);
	});

	printStatus(config);
	rl.prompt();

	await new Promise<void>((resolve) => rl.on("close", resolve));
}
