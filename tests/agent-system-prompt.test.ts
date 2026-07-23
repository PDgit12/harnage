import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../src/services/system-prompt";

describe("buildAgentSystemPrompt — deterministic, domain-grounded, correct tool names", () => {
	const sp = buildAgentSystemPrompt({
		name: "github-repo-gtm",
		purpose: "analyze GitHub repos and rank them for product-market fit",
		domainKnowledge: "Weigh stars, commit activity, and issue throughput.",
		tools: ["bash", "file_read", "glob", "grep", "web_fetch"],
	});

	it("grounds identity in the real purpose + domain knowledge", () => {
		expect(sp).toContain("github repo gtm");
		expect(sp).toContain("product-market fit");
		expect(sp).toContain("Weigh stars");
	});

	it("lists the harness's REAL tool names (not the old wrong read/write/GlobTool)", () => {
		expect(sp).toContain("- file_read:");
		expect(sp).toContain("- glob:");
		expect(sp).toContain("- web_fetch:");
		expect(sp).not.toContain("GlobTool");
		expect(sp).not.toMatch(/^- read:/m);
	});

	it("only lists tools the harness actually has", () => {
		expect(sp).not.toContain("- web_search:");
		expect(sp).not.toContain("- mcp:");
	});

	it("includes the grounding rules that fight small-model failure modes", () => {
		expect(sp).toContain("Act, don't narrate");
		expect(sp).toContain("Never state a fact");
	});

	it("fits the small-tier system-prompt budget (~1600 chars)", () => {
		expect(sp.length).toBeLessThan(1600);
	});

	it("omits the Safety block when the agent has no write/exec tools", () => {
		const readOnly = buildAgentSystemPrompt({
			name: "researcher",
			purpose: "answer questions from the web",
			tools: ["web_fetch", "web_search"],
		});
		expect(readOnly).not.toContain("## Safety");
	});
});
