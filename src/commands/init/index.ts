import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { BuildOptions } from "../../builder";
import { buildHarness } from "../../builder";
import type { LocalCommandHandler } from "../../commands";
import { createProvider } from "../../services/api/client";
import { resolveProvider } from "../../services/api/resolve";

const STEP_LABELS: Record<string, string> = {
	analyzing: "Analyzing your request...",
	planning: "Generating build plan...",
	building: "Building harness files...",
	verifying: "Running verification...",
	repairing: "Repairing build errors...",
};

const handler: LocalCommandHandler = {
	async call(): Promise<{ value: string }> {
		// Keep the readline open through the whole build: the LLM interview
		// stage asks clarifying questions via the same interface. Close once,
		// in finally — double-close hangs stdin.
		const rl = createInterface({ input, output });

		try {
			const prompt = await rl.question(
				chalk.dim("Describe the AI agent you want to build: "),
			);
			if (!prompt.trim()) {
				return { value: chalk.yellow("No description provided. Cancelled.") };
			}

			// LLM-driven path when a provider is reachable; offline keyword
			// fallback otherwise (buildHarness also falls back on LLM errors).
			let options: BuildOptions | undefined;
			try {
				const config = await resolveProvider();
				if (config.type === "ollama") {
					config.contextTokens = config.contextTokens ?? 8192;
				}
				options = {
					provider: createProvider(config),
					ask: async (question, defaultAnswer) => {
						output.write("\r\x1b[K");
						const answer = await rl.question(
							`  ${chalk.cyan("?")} ${question} ${chalk.dim(`[${defaultAnswer}]`)}: `,
						);
						return answer.trim() || defaultAnswer;
					},
				};
			} catch {
				options = undefined;
			}

			const lines: string[] = [];

			const setProgress = (p: {
				stage: string;
				message: string;
				detail?: string;
			}) => {
				const label = STEP_LABELS[p.stage] ?? "Working...";
				output.write(`\r\x1b[K  ${chalk.yellow("⠋")} ${chalk.dim(label)}`);
			};

			output.write(`  ${chalk.yellow("⠋")} ${chalk.dim("Analyzing...")}`);

			try {
				const result = await buildHarness(
					prompt.trim(),
					undefined,
					setProgress,
					options,
				);
				output.write("\r\x1b[K");

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
				output.write("\r\x1b[K");
				lines.push(chalk.red.bold(`✗ Build Failed`));
				lines.push(
					`  ${chalk.red("-")} ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			return { value: lines.join("\n") };
		} finally {
			rl.close();
		}
	},
};

export default handler;
