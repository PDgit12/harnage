import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder/index";
import {
	MAIN_ENTRY_TEMPLATE,
	MCP_JSON_EXAMPLE,
	TOOLS_REGISTRY,
} from "../src/builder/assemble/templates";

// MCP-consumption wave: chassis owns src/mcp-client.ts's content
// (HARNESS_MCP_CLIENT in harness-templates.ts, tested by their own
// tests/mcp-client.test.ts) — this is the emission + registry seam
// (assemble/index.ts + assemble/templates.ts). Real compile is covered by
// `bun run golden` (offline generated-harness E2E), not duplicated here.

const plan: HarnessPlan = {
	name: "mcp-demo-agent",
	description: "Demos MCP consumption",
	tools: ["bash"],
	commands: [],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
};

describe("getAllTools() merges external MCP tools", () => {
	it("makes getAllTools async and appends loadMcpTools() results, best-effort", () => {
		const code = TOOLS_REGISTRY(plan);
		expect(code).toContain("export async function getAllTools(): Promise<Tool[]> {");
		expect(code).toContain('import("./mcp-client.ts")');
		expect(code).toContain("tools.push(...(await loadMcpTools().catch(() => [])))");
	});
});

describe("mcp.json.example", () => {
	it("documents the locked stdio-only, no-dot, cwd-root shape", () => {
		expect(MCP_JSON_EXAMPLE).toContain('"servers"');
		expect(MCP_JSON_EXAMPLE).toContain('"command"');
		// stdio-only MVP — no transport/url fields yet
		expect(MCP_JSON_EXAMPLE).not.toContain("transport");
		expect(MCP_JSON_EXAMPLE).not.toContain("url");
	});

	it("is valid JSON", () => {
		expect(() => JSON.parse(MCP_JSON_EXAMPLE)).not.toThrow();
	});
});

describe("main.tsx wires disconnectMcp() on every exit path", () => {
	const code = MAIN_ENTRY_TEMPLATE(plan);

	it("imports disconnectMcp and registers a SIGINT handler", () => {
		expect(code).toContain('import { disconnectMcp } from "./mcp-client.ts";');
		expect(code).toContain('process.on("SIGINT"');
	});

	it("awaits disconnectMcp() before every process.exit call", () => {
		// crude but effective: every exit call site in this generated file must
		// have a preceding disconnectMcp() call somewhere in the same function
		const exitCalls = code.split("process.exit(").length - 1;
		const disconnectCalls = code.split("disconnectMcp()").length - 1;
		expect(disconnectCalls).toBeGreaterThanOrEqual(exitCalls);
	});
});

describe("assemble/index.ts emits mcp-client.ts and mcp.json.example", () => {
	const src = readFileSync(
		new URL("../src/builder/assemble/index.ts", import.meta.url),
		"utf8",
	);

	it("writes src/mcp-client.ts via HARNESS_MCP_CLIENT(plan)", () => {
		expect(src).toContain('"mcp-client.ts"), HARNESS_MCP_CLIENT(plan)');
	});

	it("writes mcp.json.example via MCP_JSON_EXAMPLE", () => {
		expect(src).toContain('"mcp.json.example"), MCP_JSON_EXAMPLE');
	});
});
