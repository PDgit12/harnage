import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// P3-A/P3-B: two real bugs an audit+qa pass confirmed live in harnage's own
// --mcp server mode (src/main.tsx). Source-level assertions since these are
// process-lifecycle/permission-gate behaviors, not pure functions.
describe("--mcp server mode (main.tsx)", () => {
	const src = readFileSync("src/main.tsx", "utf-8");

	it("P3-A: cleanup() disconnects the real singleton, not a throwaway instance", () => {
		expect(src).toContain("getMcpManager()");
		expect(src).toContain(".disconnectAll()");
		// must not construct a fresh manager just to disconnect it
		expect(src).not.toMatch(/new McpClientManager\(\)[\s\S]{0,80}disconnectServer/);
	});

	it("P3-B: startMcpServer honors the user's saved permission policy, not a hardcoded bypass", () => {
		expect(src).toContain("loadPolicy()");
		expect(src).not.toContain('mode: "bypass", rules: []');
	});

	it("P3-B: CallToolRequestSchema handler gates on ruleVerdict before calling the tool", () => {
		const idx = src.indexOf("CallToolRequestSchema, async (req)");
		const slice = src.slice(idx, idx + 1200);
		expect(slice).toContain("ruleVerdict(");
		expect(slice).toContain("Permission denied");
	});
});
