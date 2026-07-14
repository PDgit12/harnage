import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Provider } from "../src/services/api/client";
import type { StreamEvent } from "../src/services/api/types";
import type { Tool, ToolContext } from "../src/Tool";
import AgentTool from "../src/tools/AgentTool/AgentTool";

function createMockProvider(): Provider {
	return {
		async *stream() {
			yield { type: "text", content: "yes, goal satisfied" } as StreamEvent;
			yield { type: "done" } as StreamEvent;
		},
	};
}

const echoTool: Tool = {
	name: "echo",
	description: "Echo input back",
	inputSchema: z.object({ text: z.string() }),
	call: async (input: { text: string }) => ({ data: input.text }),
	isReadOnly: () => true,
};

const toolContext: ToolContext = {
	cwd: process.cwd(),
	env: process.env as Record<string, string | undefined>,
	permissions: { mode: "auto", rules: [] },
	sandbox: "none",
	provider: createMockProvider(),
	tools: [echoTool],
};

describe("AgentTool multi-agent orchestration", () => {
	it("spawns a nested LoopEngine and returns non-empty content", async () => {
		const result = await AgentTool.call({ task: "do something" }, toolContext);
		expect(result.isError).toBeFalsy();
		expect(result.content).toBeTruthy();
		expect(result.content).not.toContain("not yet implemented");
	});

	it("returns an error when the agent runtime is not configured", async () => {
		const result = await AgentTool.call(
			{ task: "do something" },
			{ ...toolContext, provider: undefined, tools: undefined },
		);
		expect(result.isError).toBe(true);
		expect(result.content).toBe("Agent runtime not configured");
	});
});
