import { describe, expect, it } from "vitest";
import {
	ENGINE_TEMPLATE,
	GENERATED_TUI,
} from "../src/builder/assemble/harness-templates";
import type { HarnessPlan } from "../src/builder/index";

// Regression: the generated engine hand-rolls its OpenAI-compatible endpoint
// (harnage's own client uses the OpenAI SDK, which appends only
// "/chat/completions"). It used to append "/v1/chat/completions" to whatever
// base URL it was given — but every provider documents its base WITH the
// version, including the template's own default. A Groq config of
// https://api.groq.com/openai/v1 became .../openai/v1/v1/chat/completions and
// 404'd on the first call, so a generated harness could not talk to any
// remote provider at all.
describe("generated engine builds a correct chat-completions URL", () => {
	const plan = { name: "t", tools: ["bash"] } as unknown as HarnessPlan;
	const engine = ENGINE_TEMPLATE(plan);

	it("no longer concatenates /v1 unconditionally", () => {
		expect(engine).not.toContain("${base}/v1/chat/completions");
		expect(engine).toContain("chatCompletionsUrl");
	});

	it("emits a helper that is version-aware", () => {
		// Exercise the emitted logic itself rather than trusting the string: pull
		// the helper out of the template and run it.
		const match = engine.match(
			/export function chatCompletionsUrl\(baseUrl: string\): string \{([\s\S]*?)\n\}/,
		);
		expect(match).not.toBeNull();
		const chatCompletionsUrl = new Function(
			"baseUrl",
			(match as RegExpMatchArray)[1],
		) as (b: string) => string;

		// Bases that already carry the version — the common case, and the bug.
		expect(chatCompletionsUrl("https://api.groq.com/openai/v1")).toBe(
			"https://api.groq.com/openai/v1/chat/completions",
		);
		expect(chatCompletionsUrl("https://openrouter.ai/api/v1")).toBe(
			"https://openrouter.ai/api/v1/chat/completions",
		);
		expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe(
			"https://api.openai.com/v1/chat/completions",
		);
		// Trailing slash must not produce a double slash.
		expect(chatCompletionsUrl("https://api.groq.com/openai/v1/")).toBe(
			"https://api.groq.com/openai/v1/chat/completions",
		);
		// A base WITHOUT a version still gets one (local proxies).
		expect(chatCompletionsUrl("http://localhost:8080")).toBe(
			"http://localhost:8080/v1/chat/completions",
		);
	});

	it("keeps the Ollama path unversioned", () => {
		expect(engine).toContain("/api/chat");
	});
});

// Every slash command in the generated TUI crashed with
// "undefined is not an object (evaluating '(await matched.command.load()).default.call')"
// because command modules export a NAMED `call`, not a default. The classic
// REPL path always did the right thing, so the bug only hit the default UI.
describe("generated TUI dispatches slash commands", () => {
	const tui = GENERATED_TUI({
		name: "t",
		description: "d",
		tools: [],
		commands: [],
		providers: ["ollama"],
		systemPrompt: "",
		hasMcp: false,
	} as unknown as HarnessPlan);

	it("no longer reads a non-existent default export", () => {
		expect(tui).not.toContain("mod.default as {");
	});

	it("accepts a named call or a default export", () => {
		expect(tui).toContain(".default ?? mod");
	});

	it("fails with a nameable error rather than a type crash", () => {
		expect(tui).toContain("has no exported call()");
	});
});
