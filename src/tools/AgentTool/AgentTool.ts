import { z } from "zod";
import { LoopEngine } from "../../loop/LoopEngine";
import type { Tool } from "../../Tool";

type Input = { task: string; context?: string };

const AgentTool: Tool<Input, string> = {
	name: "AgentTool",
	description: "Spawn a sub-agent for complex tasks",
	inputSchema: z.object({
		task: z.string(),
		context: z.string().optional(),
	}),

	isReadOnly: () => false,

	async call(input, context) {
		if (!context.provider || !context.tools) {
			return { content: "Agent runtime not configured", isError: true };
		}

		const subTools = context.tools.filter((t: Tool) => t.name !== "AgentTool");
		const engine = new LoopEngine({
			provider: context.provider,
			tools: subTools,
			toolContext: context,
			safetyConfig: { maxIterations: 10 },
		});

		let result = "";
		for await (const ev of engine.run(input.task)) {
			if (ev.type === "text") {
				result += ev.content ?? "";
			} else if (ev.type === "done") {
				break;
			} else if (ev.type === "error") {
				return {
					content: `sub-agent error: ${ev.content ?? ""}`,
					isError: true,
				};
			}
		}

		return { content: result.trim() || "sub-agent completed (no text output)" };
	},
};

export default AgentTool;
