import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { HARNESS_MCP_CLIENT } from "../src/builder/assemble/harness-templates";

// HARNESS_MCP_CLIENT emits src/mcp-client.ts into the generated harness, which
// consumes external MCP servers. These guard the emitted STRING (structure +
// the escaping that a template-in-template is prone to); functional round-trip
// is covered by the offline MCP E2E (renders it + tsc against the real SDK) and
// field's PTY battery against a live stdio server.
const code = HARNESS_MCP_CLIENT({ name: "nebula-agent", description: "demo" } as HarnessPlan);

describe("HARNESS_MCP_CLIENT template", () => {
	it("exports the loader and the disconnect hook", () => {
		expect(code).toContain("export async function loadMcpTools(): Promise<Tool[]>");
		expect(code).toContain("export async function disconnectMcp(): Promise<void>");
	});

	it("reads mcp.json from the harness root (cwd)", () => {
		expect(code).toContain('join(process.cwd(), "mcp.json")');
	});

	it("connects each server over the stdio MCP client", () => {
		expect(code).toContain('import("@modelcontextprotocol/sdk/client/index.js")');
		expect(code).toContain('import("@modelcontextprotocol/sdk/client/stdio.js")');
		expect(code).toContain("new StdioClientTransport(");
		// client identity baked with the harness's own name
		expect(code).toContain('name: "nebula-agent-mcp-client"');
	});

	it("names wrapped tools mcp__<server>__<tool> and never marks them read-only", () => {
		expect(code).toContain('"mcp__" + sanitize(server) + "__" + sanitize(remote.name)');
		expect(code).toContain("isReadOnly: () => false");
	});

	it("surfaces the remote tool's schema to the model", () => {
		expect(code).toContain("toJSONSchema = () => remoteSchema");
	});

	it("degrades gracefully — missing/invalid config and dead servers never throw", () => {
		expect(code).toContain("if (!existsSync(CONFIG_PATH)) return [];");
		expect(code).toContain("is not valid JSON — skipping external MCP tools.");
		expect(code).toContain("failed to connect (");
		// a broken call returns an error string, not a throw
		expect(code).toContain('"MCP call to " + toolName + " failed: "');
	});

	it("emits an escaped newline in the content join, not a collapsed linebreak", () => {
		expect(code).toContain('.join("\\n")');
		expect(code).not.toContain('.join("\n")');
	});
});
