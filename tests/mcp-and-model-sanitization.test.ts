import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { MAIN_ENTRY_TEMPLATE } from "../src/builder/assemble/templates";

const basePlan: Omit<HarnessPlan, "defaultLocalModel"> = {
	name: "evil-agent",
	description: "desc",
	tools: ["bash"],
	commands: [],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
};

// N3: plan.defaultLocalModel was interpolated raw into generated main.tsx at
// three sites — a `//` comment (newline breaks out into real code) and two
// double-quoted string literals (a quote breaks the literal).
describe("N3 — defaultLocalModel sanitization at generation sites", () => {
	const MALICIOUS_MODEL = 'llama3"; process.exit(1); //\ninjected';

	it("both string-literal sites use JSON.stringify, never a raw double-quoted interpolation", () => {
		const plan: HarnessPlan = { ...basePlan, defaultLocalModel: MALICIOUS_MODEL };
		const code = MAIN_ENTRY_TEMPLATE(plan);

		expect(code).toContain(`const packed = ${JSON.stringify(MALICIOUS_MODEL)};`);
		expect(code).toContain(
			`: ${JSON.stringify(MALICIOUS_MODEL)};`, // the ensureConfig() modelDefault site
		);
		expect(code).not.toContain(`"${MALICIOUS_MODEL}"`);
	});

	it("the packed-for comment strips line terminators so it can't break out of the // comment", () => {
		const plan: HarnessPlan = { ...basePlan, defaultLocalModel: MALICIOUS_MODEL };
		const code = MAIN_ENTRY_TEMPLATE(plan);

		const commentLine = code
			.split("\n")
			.find((l) => l.includes("This harness was packed for"));
		expect(commentLine).toBeDefined();
		expect(commentLine).not.toContain("\n");
		// "injected" must stay on the same comment line, not become live code
		expect(commentLine).toContain("injected");
	});

	it("falls back to llama3 when defaultLocalModel is unset", () => {
		const code = MAIN_ENTRY_TEMPLATE(basePlan as HarnessPlan);
		expect(code).toContain('const packed = "llama3";');
	});
});

// N6: startMcpServer called tool.call() directly with unvalidated arguments
// and a hardcoded { mode: "default", rules: [] } policy stand-in — no schema
// validation, no real permission check, so any MCP client could run bash
// (or anything else) unrestricted regardless of the harness's actual policy.
describe("N6 — MCP tool calls go through the real permission policy + schema", () => {
	const code = MAIN_ENTRY_TEMPLATE(basePlan as HarnessPlan);
	const mcpStart = code.indexOf("async function startMcpServer");
	const mcpEnd = code.indexOf("\n}", code.indexOf("await server.connect"));
	const mcpBody = code.slice(mcpStart, mcpEnd);

	it("loads the real persisted policy instead of a hardcoded always-default stand-in", () => {
		expect(mcpBody).toContain("loadPolicy");
		expect(mcpBody).not.toContain('permissions: { mode: "default" as const, rules: [] }');
	});

	it("validates arguments against the tool's zod schema before calling it", () => {
		expect(mcpBody).toContain("tool.inputSchema.safeParse(");
		expect(mcpBody).toContain("if (!parsed.success)");
		expect(mcpBody).toContain("isError: true");
	});

	it("checks the tool call against checkPermission and denies on a non-allowed verdict", () => {
		expect(mcpBody).toContain("checkPermission(policy, tool.name, parsed.data)");
		expect(mcpBody).toContain("if (!verdict.allowed)");
		expect(mcpBody).toContain("Permission denied for");
	});

	it("only calls the tool with validated, permission-checked arguments", () => {
		expect(mcpBody).toContain("await tool.call(parsed.data, ctx)");
		expect(mcpBody).not.toContain("tool.call(req.params.arguments");
	});
});
