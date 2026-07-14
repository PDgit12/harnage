import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelPricing {
	inputPerToken: number;
	outputPerToken: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
	"claude-sonnet-5": {
		inputPerToken: 0.000003,
		outputPerToken: 0.000015,
	},
	"claude-3-haiku-20240307": {
		inputPerToken: 0.00000025,
		outputPerToken: 0.00000125,
	},
	"gpt-4o": { inputPerToken: 0.0000025, outputPerToken: 0.00001 },
	"gpt-4o-mini": { inputPerToken: 0.00000015, outputPerToken: 0.0000006 },
	ollama: { inputPerToken: 0, outputPerToken: 0 },
};

const COST_FILE = join(homedir(), ".agentforge", "cost.json");

export class CostTracker {
	private sessionUsage = {
		promptTokens: 0,
		completionTokens: 0,
		cost: 0,
		startTime: Date.now(),
	};
	private allTimeCost = 0;
	private allTimeTokens = 0;
	private model = "claude-sonnet-5";

	constructor() {
		this.loadCumulative();
	}

	private loadCumulative(): void {
		if (!existsSync(COST_FILE)) return;
		try {
			const data = JSON.parse(readFileSync(COST_FILE, "utf-8")) as {
				cost: number;
				tokens: number;
			};
			this.allTimeCost = data.cost ?? 0;
			this.allTimeTokens = data.tokens ?? 0;
		} catch {
			// reset on corrupt file
		}
	}

	private persistCost(): void {
		try {
			mkdirSync(join(homedir(), ".agentforge"), { recursive: true });
			writeFileSync(
				COST_FILE,
				JSON.stringify({ cost: this.allTimeCost, tokens: this.allTimeTokens }),
			);
		} catch {
			/* best-effort */
		}
	}

	setModel(model: string): void {
		this.model = model;
	}

	recordUsage(promptTokens: number, completionTokens: number): void {
		const pricing = MODEL_PRICING[this.model] ?? MODEL_PRICING.ollama;
		const cost =
			promptTokens * pricing.inputPerToken +
			completionTokens * pricing.outputPerToken;

		this.sessionUsage.promptTokens += promptTokens;
		this.sessionUsage.completionTokens += completionTokens;
		this.sessionUsage.cost += cost;
		this.allTimeCost += cost;
		this.allTimeTokens += promptTokens + completionTokens;
		this.persistCost();
	}

	getSessionUsage() {
		return {
			...this.sessionUsage,
			duration: Date.now() - this.sessionUsage.startTime,
		};
	}

	checkBudget(ceilingUsd: number): {
		withinBudget: boolean;
		percentUsed: number;
	} {
		const percentUsed = (this.allTimeCost / ceilingUsd) * 100;
		return { withinBudget: this.allTimeCost < ceilingUsd, percentUsed };
	}

	reset(): void {
		this.sessionUsage = {
			promptTokens: 0,
			completionTokens: 0,
			cost: 0,
			startTime: Date.now(),
		};
	}
}

// ponytail: single session source of truth, reset per REPL session if needed
export const costTracker = new CostTracker();
