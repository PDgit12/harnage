import type { CostTracker } from "../cost-tracker";

export interface SafetyConfig {
	maxIterations: number;
	maxCostUsd: number;
	maxDurationMs: number;
	maxRepeatedFailures: number;
}

export interface SafetyVerdict {
	shouldStop: boolean;
	reason?: string;
}

export class SafetyMonitor {
	private config: SafetyConfig;
	private startTime: number;
	private costTracker: CostTracker;
	private consecutiveFailures: number;

	constructor(costTracker: CostTracker, config?: Partial<SafetyConfig>) {
		this.costTracker = costTracker;
		this.config = {
			maxIterations: 25,
			maxCostUsd: 1.0,
			maxDurationMs: 300_000,
			maxRepeatedFailures: 3,
			...config,
		};
		this.startTime = Date.now();
		this.consecutiveFailures = 0;
	}

	recordFailure(): void {
		this.consecutiveFailures++;
	}

	recordSuccess(): void {
		this.consecutiveFailures = 0;
	}

	check(iteration: number): SafetyVerdict {
		if (iteration >= this.config.maxIterations) {
			return {
				shouldStop: true,
				reason: `max iterations (${this.config.maxIterations}) exceeded`,
			};
		}

		const elapsed = Date.now() - this.startTime;
		if (elapsed >= this.config.maxDurationMs) {
			return {
				shouldStop: true,
				reason: `max duration (${this.config.maxDurationMs}ms) exceeded`,
			};
		}

		const budget = this.costTracker.checkBudget(this.config.maxCostUsd);
		if (!budget.withinBudget) {
			return {
				shouldStop: true,
				reason: `max cost ($${this.config.maxCostUsd.toFixed(2)}) exceeded ($${this.costTracker.getSessionUsage().cost.toFixed(4)})`,
			};
		}

		if (this.consecutiveFailures >= this.config.maxRepeatedFailures) {
			return {
				shouldStop: true,
				reason: `repeated failures (${this.consecutiveFailures}) exceeded max (${this.config.maxRepeatedFailures})`,
			};
		}

		return { shouldStop: false };
	}

	reset(): void {
		this.startTime = Date.now();
		this.consecutiveFailures = 0;
	}
}
