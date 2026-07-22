import { CostTracker } from "../cost-tracker";
import type { Provider, ToolDefinition } from "../services/api/client";
import type { StreamEvent } from "../services/api/types";
import type { Tool, ToolContext } from "../Tool";
import { type ContextConfig, compactMessages, estimateTokens } from "./context";
import { saveLoop } from "./persistence";
import { type SafetyConfig, SafetyMonitor } from "./safety";
import type { LoopState, SafetyRails, ToolUse } from "./types";

export class LoopEngine {
	private state!: LoopState;
	private provider: Provider;
	private tools: Tool[];
	private toolContext: ToolContext;
	private safety: SafetyMonitor;
	private costTracker: CostTracker;
	private id: string;
	private model: string;
	private ctxCfg: ContextConfig;
	private pendingToolCalls: ToolUse[] = [];
	private failures: string[] = [];
	private systemPrompt: string;

	constructor(config: {
		provider: Provider;
		tools: Tool[];
		toolContext: ToolContext;
		safetyRails?: SafetyRails;
		safetyConfig?: Partial<SafetyConfig>;
		costTracker?: CostTracker;
		model?: string;
		contextConfig?: Partial<ContextConfig>;
		systemPrompt?: string;
	}) {
		this.provider = config.provider;
		this.tools = config.tools;
		this.toolContext = config.toolContext;
		this.id = crypto.randomUUID();
		this.model = config.model ?? "claude-sonnet-5";
		this.costTracker = config.costTracker ?? new CostTracker();
		this.safety = new SafetyMonitor(this.costTracker, {
			maxIterations: config.safetyRails?.maxIterations,
			maxDurationMs: config.safetyRails?.maxTimeMs,
			...config.safetyConfig,
		});
		this.ctxCfg = {
			maxTokens: 32000,
			summaryTokens: 2000,
			compactionThreshold: 24000,
			...config.contextConfig,
		};
		this.systemPrompt = config.systemPrompt ?? "";
	}

	async *run(goal: string): AsyncGenerator<StreamEvent> {
		this.id = crypto.randomUUID();
		this.state = {
			id: this.id,
			goal,
			phase: "planning",
			messages: [{ role: "user", content: goal }],
			toolResults: [],
			iteration: 0,
			startedAt: Date.now(),
		};
		this.pendingToolCalls = [];
		this.failures = [];
		this.safety.reset();
		yield* this.mainLoop();
	}

	private async *runStream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamEvent> {
		this.costTracker.setModel(this.model);
		const stream = this.provider.stream(messages, tools);
		for await (const event of stream) {
			if (
				event.usage &&
				(event.type === "text" ||
					event.type === "tool_use" ||
					event.type === "done")
			) {
				this.costTracker.recordUsage(
					event.usage.promptTokens,
					event.usage.completionTokens,
				);
			}
			yield event;
		}
	}

	async *resume(state: LoopState): AsyncGenerator<StreamEvent> {
		this.id = state.id;
		this.state = {
			...state,
			messages: [...state.messages],
			toolResults: [...state.toolResults],
		};
		this.pendingToolCalls = [];
		this.failures = [];
		this.safety.reset();
		yield* this.mainLoop();
	}

	getState(): LoopState {
		return {
			...this.state,
			messages: [...this.state.messages],
			toolResults: [...this.state.toolResults],
		};
	}

	private get toolDefs() {
		return this.tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema.toJSONSchema(),
		}));
	}

	private async *mainLoop(): AsyncGenerator<StreamEvent> {
		while (true) {
			if (this.state.phase === "done" || this.state.phase === "failed") break;

			this.state.iteration++;
			const verdict = this.safety.check(this.state.iteration);
			if (verdict.shouldStop) {
				this.state.phase = "failed";
				yield {
					type: "error",
					content: verdict.reason ?? "Safety rails triggered stop",
				};
				break;
			}

			await this.maybeCompact();

			const prevFailureCount = this.failures.length;

			switch (this.state.phase) {
				case "planning":
					yield* this.plan();
					break;
				case "executing":
					yield* this.execute();
					break;
				case "verifying":
					yield* this.verify();
					break;
				case "adapting":
					yield* this.adapt();
					break;
			}

			if (this.failures.length > prevFailureCount) {
				this.safety.recordFailure();
			} else if ((this.state as LoopState).phase === "done") {
				this.safety.recordSuccess();
			}

			if (this.state.iteration % 5 === 0) await saveLoop(this.getState());
		}
	}

	private async maybeCompact(): Promise<void> {
		const total = this.state.messages.reduce(
			(sum, m) => sum + estimateTokens(m.content),
			0,
		);
		if (total <= this.ctxCfg.compactionThreshold) return;

		const { messages: toKeep, compactedCount } = compactMessages(
			this.state.messages,
			this.ctxCfg,
		);
		if (compactedCount === 0) return;

		const toCompactMessages = this.state.messages.slice(0, -toKeep.length);

		const summarizeFn = async (
			msgs: Array<{ role: string; content: string }>,
		): Promise<string> => {
			let out = "";
			for await (const ev of this.provider.stream(
				[
					{
						role: "system",
						content:
							"Summarize the following conversation concisely, preserving key facts, decisions, and tool results:",
					},
					...msgs,
				],
				[],
			)) {
				if (ev.type === "text") out += ev.content ?? "";
			}
			return out;
		};

		const summary = await summarizeFn(toCompactMessages);

		this.state.messages = [
			{
				role: "system",
				content: `Summary of earlier conversation:\n${summary}`,
			},
			...toKeep,
		];
	}

	private async *plan(): AsyncGenerator<StreamEvent> {
		const messages = [
			{
				role: "system",
				content: `${this.systemPrompt}\n\nGoal: ${this.state.goal}\n\nCreate a plan to accomplish this goal, then start executing it. Use the available tools.`,
			},
			...this.state.messages,
		];

		let fullText = "";
		const calls: ToolUse[] = [];

		try {
			for await (const event of this.runStream(messages, this.toolDefs)) {
				switch (event.type) {
					case "text":
						fullText += event.content ?? "";
						yield event;
						break;
					case "tool_use":
						calls.push({
							name: event.name ?? "",
							input: event.input ?? {},
							id: event.id ?? "",
						});
						yield event;
						break;
					case "thinking":
						yield event;
						break;
					case "error":
						yield event;
						this.state.phase = "failed";
						return;
				}
			}
		} catch (err) {
			yield { type: "error", content: String(err) };
			this.state.phase = "failed";
			return;
		}

		// A provider call that yields neither text nor a tool call is not a
		// completed task — it's a silent failure (observed with flaky/empty
		// upstream responses). Treating it as "done" hid the real problem
		// behind an empty success. Surface it as an error instead.
		if (calls.length === 0 && fullText.trim().length === 0) {
			this.state.phase = "failed";
			yield {
				type: "error",
				content: "provider returned no output (empty response)",
			};
			return;
		}

		this.state.messages.push({ role: "assistant", content: fullText });

		if (calls.length > 0) {
			this.pendingToolCalls = calls;
			this.state.phase = "executing";
		} else {
			this.state.phase = "done";
			yield { type: "done" };
		}
	}

	private async *execute(): AsyncGenerator<StreamEvent> {
		for (const call of this.pendingToolCalls) {
			const tool = this.tools.find((t) => t.name === call.name);

			yield {
				type: "tool_use",
				name: call.name,
				input: call.input,
				id: call.id,
			};

			let output: string;
			let success: boolean;

			if (!tool) {
				output = `Tool '${call.name}' not found`;
				success = false;
			} else {
				try {
					// Path rules from ~/.harnage/permissions.json take precedence;
					// no matching rule falls through to the tool's own check.
					const { ruleVerdict } = await import("../permissions");
					const permResult =
						ruleVerdict(this.toolContext.permissions, call.name, call.input) ??
						(await tool.checkPermissions?.(call.input, this.toolContext));
					if (permResult && !permResult.allowed) {
						output = `Permission denied: ${permResult.reason || "Not allowed"}`;
						success = false;
					} else {
						const r = await tool.call(call.input, this.toolContext);
						output = r.error
							? r.error
							: typeof r.data === "string"
								? r.data
								: JSON.stringify(r.data ?? "");
						success = !r.error;
					}
				} catch (err) {
					output = String(err);
					success = false;
				}
			}

			this.state.messages.push({
				role: "assistant",
				content: JSON.stringify({
					type: "tool_use",
					name: call.name,
					input: call.input,
					id: call.id,
				}),
			});
			this.state.messages.push({
				role: "user",
				content: JSON.stringify({
					type: "tool_result",
					tool_use_id: call.id,
					content: output,
				}),
			});

			this.state.toolResults.push({
				tool: call.name,
				input: call.input,
				output,
				success,
			});

			yield {
				type: "tool_result",
				name: call.name,
				id: call.id,
				content: output,
			};
		}

		this.pendingToolCalls = [];
		this.state.phase = "verifying";
	}

	// Verification and goal-check used to be two sequential model calls after
	// every tool execution — doubling latency on every task, most visibly on
	// trivial single-tool-call turns where this pair of calls dominated total
	// response time. They ask overlapping questions; one round trip covers
	// both: check the tool results AND answer whether the goal is satisfied.
	private async *verify(): AsyncGenerator<StreamEvent> {
		const messages = [
			...this.state.messages,
			{
				role: "user",
				content: `Verify that the tool results above are correct and complete. Note any errors or issues specifically.\n\nThen answer: has the original goal been fully satisfied?\n\nOriginal goal: ${this.state.goal}\n\nEnd your reply with a line starting with YES if the goal is completely satisfied, or NO if more work is needed.`,
			},
		];

		let fullText = "";

		try {
			for await (const event of this.runStream(messages, [])) {
				switch (event.type) {
					case "text":
						fullText += event.content ?? "";
						yield event;
						break;
					case "thinking":
						yield event;
						break;
					case "error":
						yield event;
						this.state.phase = "failed";
						return;
				}
			}
		} catch (err) {
			yield { type: "error", content: String(err) };
			this.state.phase = "failed";
			return;
		}

		this.state.messages.push({ role: "assistant", content: fullText });

		if (/error|incorrect|wrong|fail|issue|problem/i.test(fullText)) {
			this.failures.push(fullText);
		}

		// ponytail: simple YES/NO heuristic. Upgrade to structured output if needed.
		if (/^yes\b/im.test(fullText.trim())) {
			this.state.phase = "done";
			yield { type: "done" };
		} else {
			this.state.phase = "adapting";
		}
	}

	private async *adapt(): AsyncGenerator<StreamEvent> {
		const failureContext =
			this.failures.length > 0
				? `\nPrevious issues:\n${this.failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
				: "";

		const messages = [
			{
				role: "system",
				content: `Goal: ${this.state.goal}. The previous attempt did not fully satisfy the goal. Adapt your approach based on what has been learned so far.${failureContext}`,
			},
			...this.state.messages,
		];

		let fullText = "";
		const calls: ToolUse[] = [];

		try {
			for await (const event of this.runStream(messages, this.toolDefs)) {
				switch (event.type) {
					case "text":
						fullText += event.content ?? "";
						yield event;
						break;
					case "tool_use":
						calls.push({
							name: event.name ?? "",
							input: event.input ?? {},
							id: event.id ?? "",
						});
						yield event;
						break;
					case "thinking":
						yield event;
						break;
					case "error":
						yield event;
						this.state.phase = "failed";
						return;
				}
			}
		} catch (err) {
			yield { type: "error", content: String(err) };
			this.state.phase = "failed";
			return;
		}

		this.state.messages.push({ role: "assistant", content: fullText });

		if (calls.length > 0) {
			this.pendingToolCalls = calls;
			this.state.phase = "executing";
		} else {
			this.state.phase = "verifying";
		}
	}
}
