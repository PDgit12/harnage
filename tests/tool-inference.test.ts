import { describe, expect, it } from "vitest";
import { generatePlan } from "../src/builder";
import { parseIntent } from "../src/builder/spec";

// field defect (2026-07-17): the offline keyword path had no LLM to infer
// tool needs from prose, so "research assistant that can search the web"
// silently produced a harness with only ALWAYS_TOOLS (bash/file_read/glob/
// grep/file_edit/file_write) and no web capability at all — functionally
// broken for its own stated purpose. Only the LLM path (runInterview) ever
// added web_search/web_fetch.

describe("parseIntent tool inference (offline keyword path)", () => {
	it("infers web_search from a search-the-web prompt", () => {
		const spec = parseIntent(
			"A research assistant that can search the web for facts",
		);
		expect(spec.tools).toContain("web_search");
	});

	it("infers web_search from a hyphenated slug prompt (field's exact repro)", () => {
		const spec = parseIntent("research-assistant-that-can-search-the-web");
		expect(spec.tools).toContain("web_search");
	});

	it("infers web_fetch from a scrape/crawl prompt", () => {
		const spec = parseIntent("A bot that can crawl and scrape product pages");
		expect(spec.tools).toContain("web_fetch");
	});

	it("does not add web tools to an unrelated prompt", () => {
		const spec = parseIntent("A code review agent that checks pull requests");
		expect(spec.tools).not.toContain("web_search");
		expect(spec.tools).not.toContain("web_fetch");
	});

	it("always keeps ALWAYS_TOOLS alongside inferred web tools", () => {
		const spec = parseIntent("A research assistant that can search the web");
		for (const t of ["bash", "file_read", "glob", "grep", "file_edit", "file_write"]) {
			expect(spec.tools).toContain(t);
		}
	});

	it("generatePlan carries the inferred web tool through to the harness plan", () => {
		const spec = parseIntent(
			"A research assistant that can search the web for facts",
		);
		const plan = generatePlan(spec);
		expect(plan.tools).toContain("web_search");
	});
});
