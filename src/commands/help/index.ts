import chalk from "chalk";
import type { LocalCommandHandler } from "../../commands";
import { COMMANDS } from "../../commands";

const handler: LocalCommandHandler = {
	async call(): Promise<{ value: string }> {
		const lines: string[] = [];
		lines.push(chalk.bold("harnage v0.2.0"));
		lines.push(chalk.dim("AI Model = Brain. Harness = Hands."));
		lines.push(
			chalk.dim(
				"Describe what you want to build, and the goal-driven loop builds it.",
			),
		);
		lines.push("");
		lines.push(chalk.bold("Commands"));
		for (const cmd of COMMANDS) {
			lines.push(`  ${chalk.bold(cmd.name)}  ${chalk.dim(cmd.description)}`);
		}
		lines.push("");
		lines.push(chalk.dim("Ctrl+C Exit"));
		return { value: lines.join("\n") };
	},
};

export default handler;
