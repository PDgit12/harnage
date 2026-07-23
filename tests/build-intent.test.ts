import { describe, expect, it } from "vitest";
import { isBuildIntent } from "../src/ui/build-intent";

describe("isBuildIntent — route build requests to the builder, not the chat agent", () => {
	it("routes explicit build requests to the builder", () => {
		for (const t of [
			"build me a harness that reviews PRs",
			"i want to build a harness which i can use as a gtm for github repos",
			"create a harness for analyzing repos",
			"make a harness to draft changelogs",
			"generate a harness that pings slack",
			"i need a harness for code review",
			"set up a harness for triaging issues",
		]) {
			expect(isBuildIntent(t), t).toBe(true);
		}
	});

	it("leaves plain chat / goals as chat", () => {
		for (const t of [
			"Hi",
			"what does the loop engine do",
			"explain the harness architecture",
			"run the tests",
			"how does the verify phase work",
		]) {
			expect(isBuildIntent(t), t).toBe(false);
		}
	});
});
