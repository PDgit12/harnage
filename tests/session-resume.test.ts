import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import {
	ENGINE_TEMPLATE,
	GENERATED_TUI,
	HARNESS_SESSION,
} from "../src/builder/assemble/harness-templates";
import { MAIN_ENTRY_TEMPLATE } from "../src/builder/assemble/templates";

const plan = { name: "demo", description: "demo harness" } as HarnessPlan;

// Mid-task resume: every session write carries {goal, done}; a crash leaves
// done=false on disk and the next startup offers/continues the goal.
describe("session mid-task resume", () => {
	it("session state carries goal and done marker", () => {
		const code = HARNESS_SESSION(plan);
		expect(code).toContain("goal?: string");
		expect(code).toContain("done?: boolean");
		expect(code).toContain("meta?: { goal?: string; done?: boolean }");
	});

	it("engine marks the run unfinished at start and finished at end", () => {
		const code = ENGINE_TEMPLATE(plan);
		expect(code).toContain("saveSession(this.messages, { goal, done: false })");
		expect(code).toContain("saveSession(this.messages, { goal, done: true })");
		// mid-loop saves keep the unfinished marker
		expect(code).toContain(
			"saveSession(this.messages, { goal: this.activeGoal, done: false })",
		);
		// no bare saves left that would silently mark the session done
		expect(code).not.toContain("saveSession(this.messages);");
	});

	it("TUI auto-continues an unfinished goal on --resume and hints otherwise", () => {
		const code = GENERATED_TUI(plan);
		expect(code).toContain("resumeGoal?: string");
		expect(code).toContain("unfinishedHint?: string");
		expect(code).toContain("Continue the unfinished task from this transcript");
		expect(code).toContain("restart with --resume to continue");
	});

	it("main entry surfaces the unfinished goal in REPL and TUI paths", () => {
		const code = MAIN_ENTRY_TEMPLATE(plan);
		expect(code).toContain("session.done === false && session.goal");
		expect(code).toContain("Resuming unfinished task");
		expect(code).toContain("unfinishedHint");
	});
});
