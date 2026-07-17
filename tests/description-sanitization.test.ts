import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { generatePlan } from "../src/builder";
import { MAIN_ENTRY_TEMPLATE } from "../src/builder/assemble/templates";
import { parseIntent } from "../src/builder/spec";

// audit finding #1 (HIGH): plan.description was interpolated RAW into
// generated source at templates.ts (program.description("${plan.description}")
// double-quoted, and the showBanner backtick literal) - a quote, backtick, or
// ${ in a description broke or injected into generated code. Fixed with
// sanitization in both plan builders (index.ts generatePlan, llm/plan.ts
// runLLMPlan) plus belt-and-braces escaping at the two interpolation sites.

const MALICIOUS = 'agent`); process.exit(1); //${1+1}"';

describe("description sanitization - generated source stays valid", () => {
	it("MAIN_ENTRY_TEMPLATE output has no raw backtick/quote/${ injection from a malicious description", () => {
		const plan: HarnessPlan = {
			name: "evil-agent",
			description: MALICIOUS,
			tools: ["bash"],
			commands: [],
			providers: ["ollama"],
			systemPrompt: "x".repeat(60),
			hasMcp: false,
		};
		const code = MAIN_ENTRY_TEMPLATE(plan);

		// program.description(...) site: must be a JSON.stringify'd JS string
		// literal, never a raw double-quoted interpolation of the value.
		expect(code).toContain(`.description(${JSON.stringify(MALICIOUS)})`);
		expect(code).not.toContain(`.description("${MALICIOUS}")`);

		// showBanner's nested backtick literal must not contain an unescaped
		// backtick or ${ from the description - either would terminate or
		// reopen interpolation in the generated template literal.
		const bannerStart = code.indexOf("function showBanner");
		const bannerEnd = code.indexOf("\n}", bannerStart);
		const banner = code.slice(bannerStart, bannerEnd);
		expect(banner).not.toMatch(/[^\\]`\);\s*process\.exit/);
		expect(banner).not.toContain("${1+1}");
	});

	it("generatePlan (deterministic path) strips backtick/quote/${ from description", () => {
		const spec = parseIntent(
			'A code review agent that checks pull requests for `bugs` and "style" issues${1+1}',
		);
		const plan = generatePlan(spec);
		expect(plan.description).not.toContain("`");
		expect(plan.description).not.toContain('"');
		expect(plan.description).not.toContain("${");
	});

	it("generatePlan collapses CR and U+2028/U+2029 line separators (sanitizeDescription's own regex, not parseIntent's sentence split)", () => {
		// parseIntent's purpose = prompt.split(/\.|\n/)[0] already drops
		// everything after a bare LF, so an LF-only fixture would pass even if
		// sanitizeDescription's line-separator regex were a no-op. Build the
		// fixture with CR and the U+2028/U+2029 unicode escapes, which survive
		// that split, to exercise sanitizeDescription's own regex.
		const CR = "\r";
		const LS = "\u2028"; // LINE SEPARATOR
		const PS = "\u2029"; // PARAGRAPH SEPARATOR
		const withOddSeparators = `A code review agent that checks pull${CR}requests${LS}for bugs${PS}and style issues`;
		const spec = parseIntent(withOddSeparators);
		const plan = generatePlan(spec);
		expect(plan.description).not.toContain(CR);
		expect(plan.description).not.toContain(LS);
		expect(plan.description).not.toContain(PS);
		expect(plan.description).toBe(
			"A code review agent that checks pull requests for bugs and style issues",
		);
	});
});
