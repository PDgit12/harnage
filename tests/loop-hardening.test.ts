import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import {
	ENGINE_TEMPLATE,
	GENERATED_TUI,
} from "../src/builder/assemble/harness-templates";
import { toolTemplates } from "../src/builder/generate/tool-generator";

const plan = { name: "demo", description: "demo harness" } as HarnessPlan;

// Field-test hardening (2026-07-15 run on qwen2.5:3b): raw decision JSON
// leaked into the UI, "hi" triggered the full domain pipeline, and one broken
// command was re-issued identically four times.
describe("small-model loop hardening", () => {
	const code = ENGINE_TEMPLATE(plan);

	it("never emits raw decision JSON as agent text", () => {
		// the decision stream loop must accumulate silently (status event only)
		expect(code).toContain('"deciding next step"');
		expect(code).not.toMatch(
			/for await \(const e of streamProvider\(this\.config, reqMessages[^}]+type: "text", content/,
		);
	});

	it("breaks identical repeated tool calls instead of looping", () => {
		expect(code).toContain("lastCallSig");
		expect(code).toContain("EXACT same tool call");
		expect(code).toContain("repeated the same failing tool call");
	});

	it("small talk skips the pipeline, plan-act, and the act-nudge", () => {
		expect(code).toContain("isSmallTalk");
		expect(code).toContain("PIPELINE.length && !this.isSmallTalk(goal)");
		expect(code).toContain(
			"if (this.isSmallTalk(goal)) return this.runDecisionLoop(goal);",
		);
		expect(code).toContain("!this.isSmallTalk(goal)) {");
		// capability questions count as small talk too
		expect(code).toContain("what (can|do) (u|you) do");
	});

	it("pushes back on a final answer that promises future work", () => {
		expect(code).toContain("intentNudged");
		expect(code).toContain("You announced a next step instead of doing it");
	});

	it("slash menu has no busy gate in the generated TUI", () => {
		const tui = GENERATED_TUI(plan);
		expect(tui).toContain('const slashMatches = input.startsWith("/")');
		expect(tui).not.toContain('input.startsWith("/") && !busy');
	});
});

describe("generated bash tool", () => {
	it("treats a blank cwd as process.cwd()", () => {
		expect(toolTemplates.bash).toContain(
			"input.cwd?.trim() ? input.cwd : process.cwd()",
		);
	});
});
