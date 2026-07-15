import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { COMMANDS_REGISTRY } from "../src/builder/assemble/templates";

// The build brain plans bespoke slash commands; the registry must inject them
// alongside the base set so findCommand + the TUI slash-menu surface them. These
// assertions guard that wiring (custom command code is compile-checked by the
// offline generated-harness E2E build).
const base = {
	name: "pr-agent",
	description: "reviews PRs",
	tools: ["file_read"],
	commands: ["help"],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
} as HarnessPlan;

describe("COMMANDS_REGISTRY", () => {
	it("keeps the base commands", () => {
		const code = COMMANDS_REGISTRY(base);
		expect(code).toContain('name: "/help"');
		expect(code).toContain('name: "/model"');
		expect(code).toContain("export function findCommand");
	});

	it("injects planned custom commands with their import", () => {
		const code = COMMANDS_REGISTRY({
			...base,
			customCommands: [
				{
					name: "/review",
					description: "Review the diff",
					behavior: "git diff",
				},
			],
		});
		expect(code).toContain('name: "/review"');
		expect(code).toContain('description: "Review the diff"');
		expect(code).toContain('import("./commands/review.ts")');
	});

	it("sanitizes command names to a safe id", () => {
		const code = COMMANDS_REGISTRY({
			...base,
			customCommands: [
				{ name: "Ship It!", description: "ship", behavior: "deploy" },
			],
		});
		expect(code).toContain('name: "/ship_it"');
		expect(code).toContain('import("./commands/ship_it.ts")');
	});
});
