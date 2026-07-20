import { describe, expect, it } from "vitest";
import {
	MCP_CATALOG,
	recommendMcpServers,
} from "../src/builder/models/mcp-catalog";

describe("recommendMcpServers", () => {
	it("recommends github for a GitHub issue agent", () => {
		const recs = recommendMcpServers("an agent that manages my GitHub issues");
		expect(recs.map((r) => r.name)).toContain("github");
	});

	it("recommends slack for a Slack posting agent", () => {
		const recs = recommendMcpServers("post daily summaries to a Slack channel");
		expect(recs.map((r) => r.name)).toContain("slack");
	});

	it("returns nothing for an unrelated agent", () => {
		const recs = recommendMcpServers("a calculator that adds two numbers");
		expect(recs).toEqual([]);
	});

	it("caps recommendations at 4", () => {
		const recs = recommendMcpServers(
			"github git issue pull request repo postgres sql database slack channel filesystem file browser puppeteer",
		);
		expect(recs.length).toBeLessThanOrEqual(4);
	});

	it("every catalog entry has a real npm package name shape", () => {
		for (const e of MCP_CATALOG) {
			expect(e.npmPackage).toMatch(/^(@[\w-]+\/)?[\w.-]+$/);
			expect(e.command).toBe("npx");
		}
	});
});
