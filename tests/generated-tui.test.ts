import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { GENERATED_TUI } from "../src/builder/assemble/harness-templates";

// The generated harness TUI must wire the harness's own command registry and
// surface a live slash-command menu — not just hardcode /clear and /exit. These
// assertions guard that wiring against regressions (the JSX is verified to
// compile by the offline generated-harness E2E build).
const code = GENERATED_TUI({ name: "testagent" } as HarnessPlan);

describe("generated harness TUI — slash commands", () => {
	it("imports the command registry", () => {
		expect(code).toContain(
			'import { COMMANDS, findCommand } from "./commands.ts"',
		);
	});

	it("routes slash input through the registry, not just hardcoded cases", () => {
		expect(code).toContain("void handleCommand(trimmed)");
		expect(code).toContain("matched.command.load()");
	});

	it("renders a live, filtered slash-command menu", () => {
		expect(code).toContain("slashMatches");
		expect(code).toContain("COMMANDS.filter");
		expect(code).toContain("c.description");
	});

	it("highlights the prompt when composing a command", () => {
		// command-mode → magenta; normal → brand ACCENT (post beauty-parity port)
		expect(code).toContain('input.startsWith("/") ? "magenta" : ACCENT');
	});
});

// TUI beauty parity (ported from reference src/ui/brand.ts + App.tsx): every
// generated harness boots a branded banner showing its OWN name.
describe("generated harness TUI — beauty parity banner", () => {
	const plan = {
		name: "nebula-agent",
		description: "A `smart` file agent ${with} \"quotes\"",
	} as HarnessPlan;
	const code = GENERATED_TUI(plan);

	it("bakes the harness's own name into the wordmark", () => {
		expect(code).toContain('const WORDMARK = "nebula-agent"');
	});

	it("escapes a hostile description into a valid double-quoted TAGLINE", () => {
		// JSON.stringify → backtick and ${ are inert inside double quotes, so the
		// generated source stays valid (no outer-template-literal breakage)
		expect(code).toContain(
			'const TAGLINE = "A `smart` file agent ${with} \\"quotes\\""',
		);
	});

	it("reads the version from the harness's own package.json (single source)", () => {
		expect(code).toContain('import pkg from "../package.json"');
		expect(code).toContain('const VERSION = "v" + ((pkg as { version?: string }).version ?? "0.1.0")');
		// no drift-prone hardcoded version literal
		expect(code).not.toContain('const VERSION = "v0.1.0"');
	});

	it("renders the accent, gradient wordmark, spinner, and Banner", () => {
		expect(code).toContain('const ACCENT = "#22d3ee"');
		expect(code).toContain("function wordmarkChars(");
		expect(code).toContain("const SPINNER_FRAMES = [");
		expect(code).toContain("function Banner(");
		expect(code).toContain("<Banner config={config} profile={profile} />");
	});

	it("animates the spinner only while busy", () => {
		expect(code).toContain("setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length)");
		expect(code).toContain("<Text color={ACCENT}>{SPINNER_FRAMES[spinnerFrame]}</Text>");
	});

	it("colors the Agent label with the brand accent, not raw cyan", () => {
		expect(code).toContain('<Text bold color={ACCENT}>Agent</Text>');
		expect(code).not.toContain('<Text bold color="cyan">Agent</Text>');
	});

	it("uses no new deps — ink + react + chalk primitives only", () => {
		expect(code).not.toContain("figlet");
		expect(code).not.toContain("gradient-string");
		expect(code).not.toContain("boxen");
	});
});

// UX/edge-case audit (parity with the harnage CLI pass).
describe("generated harness TUI — edge-case hardening", () => {
	const code = GENERATED_TUI({ name: "testagent" } as HarnessPlan);

	it("resolves a permission prompt exactly once (rapid double-key / esc guard)", () => {
		expect(code).toContain("const permSettledRef = useRef(false)");
		expect(code).toContain("if (permSettledRef.current) return;");
		expect(code).toContain("permSettledRef.current = true;");
		// re-armed for each new prompt
		expect(code).toContain("permSettledRef.current = false;");
	});

	it("ignores empty submits", () => {
		expect(code).toContain("if (!trimmed) return;");
	});

	it("surfaces a busy-submit as an info line instead of silently dropping input", () => {
		// data-loss visibility parity with the CLI: a mid-run submit (incl. a
		// multi-line paste that submits per newline) must not vanish silently
		expect(code).toContain("if (busyRef.current) {");
		expect(code).toContain('"⏳ busy — finish the current run first. Not sent: " + trimmed.slice(0, 80)');
	});

	it("esc cancels the in-flight run instead of aborting the process, and only quits when idle", () => {
		expect(code).toContain("if (busyRef.current) activeEngineRef.current?.cancel();");
		expect(code).toContain("else exit();");
	});

	it("surfaces a provider/stream error instead of crashing the run loop", () => {
		expect(code).toContain('push({ kind: "error", text: err instanceof Error ? err.message : String(err) });');
	});
});
