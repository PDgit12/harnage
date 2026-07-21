import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { MAIN_ENTRY_TEMPLATE } from "../src/builder/assemble/templates";

// ux-parity-spec.md §7 (classic-REPL / non-Ink parity): the generated
// harness's classic REPL banner should match the reference harness's
// gradient-wordmark + accent-badge + accent prompt system (src/repl.ts,
// src/ui/brand.ts), scoped to the harness's OWN name/description instead
// of "harnage". No new deps — chalk only.

const plan: HarnessPlan = {
	name: "pr-review-agent",
	description: "Reviews TypeScript pull requests",
	tools: ["bash"],
	commands: [],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
};

describe("banner/prompt parity with the reference harness's ACCENT system", () => {
	const code = MAIN_ENTRY_TEMPLATE(plan);

	it("defines the same ACCENT/ACCENT_DIM brand constants as src/ui/brand.ts", () => {
		expect(code).toContain('const ACCENT = "#22d3ee";');
		expect(code).toContain('const ACCENT_DIM = "#0e7490";');
	});

	it("wordmark uses the harness's own name via a per-character gradient, not a static box banner", () => {
		expect(code).toContain("const HARNESS_NAME = ");
		expect(code).toContain("function gradientWordmark(");
		expect(code).toContain("gradientWordmark(HARNESS_NAME)");
		// old static box-drawing banner must be gone
		expect(code).not.toContain("╔══");
		expect(code).not.toContain("╚══");
	});

	it("shows a provider·model badge chip using the accent background, replacing the old plain dim line", () => {
		expect(code).toContain("function chalkBadge(");
		expect(code).toContain("chalk.bgHex(ACCENT).black.bold(");
		// the separator is GLYPH_DOT (ASCII-fallback aware), not a raw "·" literal
		expect(code).toContain("chalkBadge(`${config.type} ${GLYPH_DOT} ${config.model}`)");
		expect(code).not.toContain('chalk.dim(`Provider: ${config.type} | Model: ${config.model}`)');
	});

	it("command hints use the accent color and mention running a goal, not /init (generated harnesses don't build harnesses)", () => {
		const bannerStart = code.indexOf("function showBanner");
		const bannerEnd = code.indexOf("\n}", bannerStart);
		const banner = code.slice(bannerStart, bannerEnd);
		expect(banner).toContain('chalk.hex(ACCENT)("/help")');
		expect(banner).toContain('chalk.hex(ACCENT)("/exit")');
		expect(banner).toContain("type a goal to run the agent");
		expect(banner).not.toContain("/init");
	});

	it("prompt arrow is the accent-colored ❯ (GLYPH_PROMPT, ASCII-fallback aware), matching the reference REPL, not a plain cyan >", () => {
		expect(code).toContain("chalk.hex(ACCENT)(GLYPH_PROMPT)");
		expect(code).toContain('const GLYPH_PROMPT = ASCII_MODE ? ">" : "❯";');
		expect(code).not.toContain('chalk.cyan("> ")');
	});

	it("showBanner is called with the resolved provider config so the badge has real data", () => {
		expect(code).toContain("showBanner(config);");
	});
});
