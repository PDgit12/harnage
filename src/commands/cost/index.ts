import type { LocalCommandHandler } from "../../commands";
import { costTracker } from "../../cost-tracker";

const handler: LocalCommandHandler = {
	async call(_args: string[]): Promise<{ value: string }> {
		const usage = costTracker.getSessionUsage();
		return {
			value: `Usage: ${usage.promptTokens.toLocaleString()} in / ${usage.completionTokens.toLocaleString()} out · $${usage.cost.toFixed(4)}`,
		};
	},
};

export default handler;
