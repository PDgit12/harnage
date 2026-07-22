import { Chalk } from "chalk";
import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder/index";
import {
	DEPLOY_MD_TEMPLATE,
	MAIN_ENTRY_TEMPLATE,
} from "../src/builder/assemble/templates";

// chassis's TUI edge-case audit (3d34b7f, .claude/orchestration/reports/
// chassis-tui-edgecase-audit.md) flagged two items to build's scope
// (assemble/templates.ts). Both turned out to already be correctly handled
// — these tests lock that in rather than leave it as "verified by reading".

const plan: HarnessPlan = {
	name: "edge-case-agent",
	description: "Tests edge cases",
	tools: ["bash"],
	commands: [],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
};

describe("non-TTY fallback (chassis audit item 1)", () => {
	// Ink's useInput requires raw mode; on a non-TTY (piped/CI) stdin the
	// GENERATED_TUI App throws on mount because its hooks are unconditional.
	// The App can't self-guard, so main entry must decide TUI-vs-classic
	// before ever rendering it.
	it("only launches the Ink TUI when both stdout and stdin are a TTY, and --classic is not set", () => {
		const code = MAIN_ENTRY_TEMPLATE(plan);
		expect(code).toContain(
			"if (!opts.classic && process.stdout.isTTY && process.stdin.isTTY) {",
		);
		expect(code).toContain("await startTuiApp(Boolean(opts.resume));");
	});

	it("falls through to the classic REPL for every other case (non-TTY, piped, --classic)", () => {
		const code = MAIN_ENTRY_TEMPLATE(plan);
		const entryStart = code.indexOf("const program = new Command();");
		const entry = code.slice(entryStart);
		// startRepl must be reachable outside the isTTY branch, not nested
		// inside it — i.e. it's the unconditional fallback at the end of
		// the action handler.
		const ttyBranchEnd = entry.indexOf("return;\n  }", entry.indexOf("isTTY"));
		const afterTtyBranch = entry.slice(ttyBranchEnd);
		expect(afterTtyBranch).toContain("await startRepl(Boolean(opts.resume));");
	});

	// The classic REPL falls back to for non-TTY stdin also writes to
	// stdout via chalk. chalk's own default export auto-detects stream
	// TTY-ness and drops to level 0 (no ANSI at all) when not attached to
	// a terminal. Constructing an explicit `new Chalk({ level: 0 })` here
	// (rather than asserting on the ambient default export's level) proves
	// the underlying mechanism deterministically — the real generated
	// harness's default `import chalk from "chalk"` resolves to level 0
	// the same way on an actual non-TTY stdout, but this test doesn't
	// depend on the test runner's own environment being non-TTY.
	it("chalk at level 0 (what non-TTY stdout resolves to) emits plain text — no raw ANSI leaks to piped/CI output", () => {
		const plainChalk = new Chalk({ level: 0 });
		expect(plainChalk.hex("#22d3ee")("test")).toBe("test");
		expect(plainChalk.dim("test")).toBe("test");
		expect(plainChalk.bgHex("#22d3ee").black.bold(" test ")).toBe(" test ");
		const src = MAIN_ENTRY_TEMPLATE(plan);
		expect(src).not.toMatch(/chalk\.level\s*=/);
		expect(src).not.toContain("FORCE_COLOR");
	});
});

describe("setup-wizard Ctrl-C safety (chassis audit item 2)", () => {
	const code = MAIN_ENTRY_TEMPLATE(plan);

	it("writes config.json only once, after every prompt has resolved — Ctrl-C during a prompt writes nothing", () => {
		const wizardStart = code.indexOf("async function ensureConfig");
		const wizardEnd = code.indexOf("\n}", code.indexOf("return config;"));
		const wizard = code.slice(wizardStart, wizardEnd);

		const writeIndex = wizard.indexOf("await writeFile(CONFIG_PATH");
		expect(writeIndex).toBeGreaterThan(-1);
		// every rl.question() prompt must appear BEFORE the write — none
		// after it, confirming the write is the last side effect, not
		// interleaved with further user input
		const questionsBeforeWrite = wizard
			.slice(0, writeIndex)
			.split("rl.question(").length - 1;
		const questionsAfterWrite = wizard
			.slice(writeIndex)
			.split("rl.question(").length - 1;
		expect(questionsBeforeWrite).toBeGreaterThan(0);
		expect(questionsAfterWrite).toBe(0);
	});

	it("degrades a corrupt/partially-written config.json to defaults instead of crashing on next launch", () => {
		const resolveStart = code.indexOf("async function resolveProviderConfig");
		const resolveEnd = code.indexOf("\n}", code.indexOf("return { type: \"ollama\""));
		const resolve = code.slice(resolveStart, resolveEnd);
		expect(resolve).toContain("JSON.parse(readFileSync(CONFIG_PATH");
		expect(resolve).toContain("catch { /* ignore */ }");
	});

	it("registers the SIGINT handler at module scope, before ensureConfig() can ever run", () => {
		const sigintIndex = code.indexOf('process.on("SIGINT"');
		const ensureConfigDefIndex = code.indexOf("async function ensureConfig");
		expect(sigintIndex).toBeGreaterThan(-1);
		expect(sigintIndex).toBeLessThan(ensureConfigDefIndex);
	});
});

describe("HARNAGE_ASCII opt-in glyph fallback (chassis audit item 3)", () => {
	const code = MAIN_ENTRY_TEMPLATE(plan);

	it("swaps every unicode glyph for ASCII behind HARNAGE_ASCII=1, colors untouched", () => {
		expect(code).toContain('const ASCII_MODE = process.env.HARNAGE_ASCII === "1";');
		expect(code).toContain('const GLYPH_GEAR = ASCII_MODE ? "*" : "⚙";');
		expect(code).toContain('const GLYPH_PROMPT = ASCII_MODE ? ">" : "❯";');
		expect(code).toContain("GLYPH_RULE = ASCII_MODE ?");
		expect(code).toContain('const GLYPH_DOT = ASCII_MODE ? "-" : "·";');
		expect(code).toContain('const GLYPH_DASH = ASCII_MODE ? "--" : "—";');
	});

	it("showBanner() and the prompt use the glyph consts, not the raw unicode characters directly", () => {
		const bannerStart = code.indexOf("function showBanner");
		const bannerEnd = code.indexOf("\n}", bannerStart);
		const banner = code.slice(bannerStart, bannerEnd);
		expect(banner).toContain("GLYPH_GEAR");
		expect(banner).toContain("GLYPH_RULE");
		expect(banner).toContain("GLYPH_DOT");
		expect(banner).not.toContain('"⚙"');
		expect(banner).not.toContain('"─────────────────────────────────────"');
		expect(banner).not.toContain(" · ");

		expect(code).toContain("chalk.hex(ACCENT)(GLYPH_PROMPT)");
		expect(code).not.toContain('chalk.hex(ACCENT)("❯")');
	});

	it("no raw unicode glyph survives outside the glyph-const definitions in any live console.log/chalk call", () => {
		// every non-ASCII char in the generated file must appear only on the
		// four `const GLYPH_* = ASCII_MODE ? ... : "<unicode>"` definition
		// lines — never re-embedded as a raw literal in a console.log call.
		const lines = code.split("\n");
		const offenders = lines.filter((line, i) => {
			if (!/[^\x00-\x7F]/.test(line)) return false;
			if (line.trim().startsWith("//")) return false;
			if (i === 0) return false; // shebang-adjacent comment line, if any
			return !line.includes("GLYPH_") && !line.trim().startsWith("const HARNESS_");
		});
		expect(offenders).toEqual([]);
	});

	it("is documented in DEPLOY.md alongside the other HARNAGE_* env vars", () => {
		const deploy = DEPLOY_MD_TEMPLATE(plan);
		expect(deploy).toContain("HARNAGE_ASCII=1");
		expect(deploy).toContain("HARNAGE_JUDGE=on");
	});
});
