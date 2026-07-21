import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { BuildOptions } from "../../builder";
import { buildHarness } from "../../builder";
import type { CommandContext, LocalCommandHandler } from "../../commands";
import { createProvider } from "../../services/api/client";
import {
	pickSharedProxyModel,
	resolveProvider,
} from "../../services/api/resolve";

const STEP_LABELS: Record<string, string> = {
	analyzing: "Analyzing your request...",
	planning: "Generating build plan...",
	building: "Building harness files...",
	verifying: "Running verification...",
	repairing: "Repairing build errors...",
};

async function runBuild(
	description: string,
	ask: BuildOptions["ask"] | undefined,
	write: (s: string) => void,
): Promise<string> {
	let options: BuildOptions | undefined;
	try {
		let config = await resolveProvider();
		if (config.type === "ollama") {
			config.contextTokens = config.contextTokens ?? 8192;
		}
		// Shared build-brain tier only: offer the short vetted model choice.
		// No-op for every other provider, and a no-op whenever `ask` just
		// returns its default (non-interactive callers above never block).
		config = await pickSharedProxyModel(config, ask);
		options = { provider: createProvider(config), ask };
	} catch {
		options = undefined;
	}

	const setProgress = (p: { stage: string; message: string }) => {
		const label = STEP_LABELS[p.stage] ?? "Working...";
		write(`\r\x1b[K  ${chalk.yellow("⠋")} ${chalk.dim(label)}`);
	};

	write(`  ${chalk.yellow("⠋")} ${chalk.dim("Analyzing...")}`);

	const lines: string[] = [];
	try {
		const result = await buildHarness(
			description,
			undefined,
			setProgress,
			options,
		);
		write("\r\x1b[K");

		if (result.success) {
			lines.push(chalk.green.bold("✓ Build Complete"));
			if (result.repairs) {
				lines.push(
					chalk.dim(
						`  (self-repaired in ${result.repairs} iteration${result.repairs > 1 ? "s" : ""})`,
					),
				);
			}
			lines.push("");
			lines.push(`  ${chalk.bold("Output:")} ${result.outputDir}`);
			lines.push("");
			lines.push(chalk.bold("Next Steps"));
			lines.push(`  ${chalk.green("$")} cd ${result.outputDir}`);
			lines.push(`  ${chalk.green("$")} bun start`);
		} else {
			lines.push(chalk.red.bold("✗ Build Failed"));
			for (const e of result.errors) lines.push(`  ${chalk.red("-")} ${e}`);
		}
	} catch (err) {
		write("\r\x1b[K");
		lines.push(chalk.red.bold("✗ Build Failed"));
		lines.push(
			`  ${chalk.red("-")} ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return lines.join("\n");
}

const handler: LocalCommandHandler = {
	async call(
		args: string[],
		context: CommandContext,
	): Promise<{ value: string }> {
		const inline = args.join(" ").trim();

		// Inside the Ink TUI, stdin is in raw mode for useInput — a readline
		// interface opened here would never receive input and hangs forever
		// (the original bug: "/init ... nothing happened"). Require the
		// description as an argument instead of prompting.
		if (!context.interactive) {
			if (!inline) {
				return {
					value: chalk.yellow(
						"Usage: /init <description> — e.g. /init an agent that reviews git diffs and posts to Slack",
					),
				};
			}
			const value = await runBuild(
				inline,
				async (_q, def) => def,
				() => {},
			);
			return { value };
		}

		// Classic REPL: real cooked-mode stdin, readline.question() is safe.
		if (inline) {
			const value = await runBuild(
				inline,
				async (_q, def) => def,
				(s) => output.write(s),
			);
			return { value };
		}

		const rl = createInterface({ input, output });
		try {
			const prompt = await rl.question(
				chalk.dim("Describe the AI agent you want to build: "),
			);
			if (!prompt.trim()) {
				return { value: chalk.yellow("No description provided. Cancelled.") };
			}
			const value = await runBuild(
				prompt.trim(),
				async (question, defaultAnswer) => {
					output.write("\r\x1b[K");
					const answer = await rl.question(
						`  ${chalk.cyan("?")} ${question} ${chalk.dim(`[${defaultAnswer}]`)}: `,
					);
					return answer.trim() || defaultAnswer;
				},
				(s) => output.write(s),
			);
			return { value };
		} finally {
			rl.close();
		}
	},
};

export default handler;
