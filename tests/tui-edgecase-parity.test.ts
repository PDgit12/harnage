import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder/index";
import { MAIN_ENTRY_TEMPLATE } from "../src/builder/assemble/templates";

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
