export type LoopPhase =
	| "planning"
	| "executing"
	| "verifying"
	| "checking_goal"
	| "adapting"
	| "done"
	| "failed";

export interface LoopState {
	id: string;
	goal: string;
	phase: LoopPhase;
	messages: Array<{ role: string; content: string }>;
	toolResults: Array<{
		tool: string;
		input: unknown;
		output: string;
		success: boolean;
	}>;
	iteration: number;
	contextSummary?: string;
	startedAt: number;
}

export interface SafetyRails {
	maxIterations?: number;
	maxTimeMs?: number;
}

export interface ToolUse {
	name: string;
	input: Record<string, unknown>;
	id: string;
}
