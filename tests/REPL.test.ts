import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/builder/spec";
import { findCommand, parseSlashCommand } from "../src/commands";
import { CostTracker } from "../src/cost-tracker";
import { LoopEngine } from "../src/loop/LoopEngine";
import { createProvider } from "../src/services/api/client";
import { getTool, getToolNames } from "../src/tools";

describe("REPL Integration", () => {
	it("parseSlashCommand parses /help correctly", () => {
		const result = parseSlashCommand("/help");
		expect(result?.name).toBe("/help");

		const cmd = findCommand("/help");
		expect(cmd?.command.name).toBe("/help");
		expect(cmd?.command.type).toBe("local");
	});

	it("parseSlashCommand with arguments works", () => {
		const result = parseSlashCommand("/model claude-sonnet-4");
		expect(result?.name).toBe("/model");
		expect(result?.args[0]).toBe("claude-sonnet-4");
	});

	it("CostTracker integrates with AppState format", () => {
		const tracker = new CostTracker();
		tracker.recordUsage(1000, 500);
		const usage = tracker.getSessionUsage();
		expect(usage.promptTokens).toBe(1000);
		expect(usage.completionTokens).toBe(500);
		expect(usage.cost).toBe(1000 * 0.000003 + 500 * 0.000015);
	});

	it("Tool registry can load BashTool", async () => {
		const names = getToolNames();
		expect(names).toContain("BashTool");
		const tool = await getTool("BashTool");
		expect(tool.name).toBe("BashTool");
		expect(tool.isReadOnly!({ command: "ls" })).toBe(true);
	});

	it("LoopEngine can be constructed", () => {
		const engine = new LoopEngine({
			provider: createProvider({
				type: "ollama",
				model: "llama3",
				maxTokens: 4096,
			}),
			tools: [],
			toolContext: {
				cwd: "/",
				env: {},
				permissions: { mode: "default", rules: [] },
				sandbox: "none",
			},
		});
		expect(engine).toBeTruthy();
	});

	it("Builder parseIntent works", () => {
		const spec = parseIntent(
			"Build a TypeScript coding assistant that runs tests",
		);
		expect(spec.purpose).toBeTruthy();
		expect(spec.language).toContain("typescript");
		expect(spec.tools).toContain("bash");
	});
});
