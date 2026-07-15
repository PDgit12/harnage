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
		expect(code).toContain('input.startsWith("/") ? "magenta" : "cyan"');
	});
});
