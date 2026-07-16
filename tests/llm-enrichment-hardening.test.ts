import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runLLMPlan } from "../src/builder/llm/plan";
import type { LLMSpec } from "../src/builder/llm/schemas";
import type { Provider } from "../src/services/api/client";

// Field-observed flake (2026-07-16): identical prompts against the same
// build brain (openai/gpt-oss-20b:free) yielded 0 custom commands in one
// build and 4 in the next. completeJSON's schema (`commands: z.array(...)`)
// happily validates an empty array, so the model silently satisfying the
// schema with `{"commands":[]}` never surfaced as an error to retry on.

type Msg = { role: string; content: string };

function routedProvider(route: (messages: Msg[]) => string): Provider {
	return {
		async *stream(messages: Msg[]) {
			yield { type: "text", content: route(messages) };
			yield { type: "done" };
		},
	} as Provider;
}

const CORE_JSON = JSON.stringify({
	name: "my-agent",
	description: "Reviews TypeScript pull requests",
	tools: ["bash"],
	commands: ["/help"],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
});

const spec: LLMSpec = {
	name: "review-agent",
	purpose: "Reviews TypeScript PRs",
	language: ["typescript"],
	tools: ["bash"],
	commands: ["/help"],
	models: ["ollama"],
};

function lastUserContent(messages: Msg[]): string {
	return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

describe("custom-commands enrichment hardening", () => {
	it("retries once with a sharper prompt when the model returns zero commands, and recovers", async () => {
		let commandCalls = 0;
		const provider = routedProvider((messages) => {
			const prompt = lastUserContent(messages);
			if (prompt.includes("produce the CORE harness plan")) return CORE_JSON;
			if (prompt.includes("bespoke slash commands")) {
				commandCalls++;
				if (prompt.includes('empty "commands" array')) {
					return JSON.stringify({
						commands: [
							{
								name: "review",
								description: "Review a PR",
								behavior: "Read the diff and report findings.",
							},
						],
					});
				}
				return JSON.stringify({ commands: [] });
			}
			if (prompt.includes("domain skills")) return JSON.stringify({ skills: [] });
			if (prompt.includes("ordered stages"))
				return JSON.stringify({ pipeline: [] });
			return "{}";
		});

		const plan = await runLLMPlan(provider, spec);

		expect(commandCalls).toBe(2); // one initial call + exactly one retry
		expect(plan.customCommands).toBeDefined();
		expect(plan.customCommands?.[0]?.name).toBe("review");
	});

	it("does not retry more than once — stays best-effort if the model still returns zero", async () => {
		let commandCalls = 0;
		const provider = routedProvider((messages) => {
			const prompt = lastUserContent(messages);
			if (prompt.includes("produce the CORE harness plan")) return CORE_JSON;
			if (prompt.includes("bespoke slash commands")) {
				commandCalls++;
				return JSON.stringify({ commands: [] });
			}
			if (prompt.includes("domain skills")) return JSON.stringify({ skills: [] });
			if (prompt.includes("ordered stages"))
				return JSON.stringify({ pipeline: [] });
			return "{}";
		});

		const plan = await runLLMPlan(provider, spec);

		expect(commandCalls).toBe(2); // bounded to one retry, never more
		expect(plan.customCommands).toBeUndefined();
	});

	it("names the domain in the retry prompt so the sharper instruction is concrete", async () => {
		const seenRetryPrompts: string[] = [];
		const provider = routedProvider((messages) => {
			const prompt = lastUserContent(messages);
			if (prompt.includes("produce the CORE harness plan")) return CORE_JSON;
			if (prompt.includes("bespoke slash commands")) {
				if (prompt.includes('empty "commands" array')) {
					seenRetryPrompts.push(prompt);
					return JSON.stringify({
						commands: [
							{ name: "review", description: "d", behavior: "b" },
						],
					});
				}
				return JSON.stringify({ commands: [] });
			}
			if (prompt.includes("domain skills")) return JSON.stringify({ skills: [] });
			if (prompt.includes("ordered stages"))
				return JSON.stringify({ pipeline: [] });
			return "{}";
		});

		await runLLMPlan(provider, spec);

		expect(seenRetryPrompts).toHaveLength(1);
		expect(seenRetryPrompts[0]).toContain("Reviews TypeScript pull requests");
	});
});

describe("custom-skills enrichment hardening", () => {
	it("retries once with a sharper prompt when the model returns zero skills, and recovers", async () => {
		let skillCalls = 0;
		const provider = routedProvider((messages) => {
			const prompt = lastUserContent(messages);
			if (prompt.includes("produce the CORE harness plan")) return CORE_JSON;
			if (prompt.includes("bespoke slash commands"))
				return JSON.stringify({ commands: [] });
			if (prompt.includes("ordered stages"))
				return JSON.stringify({ pipeline: [] });
			if (prompt.includes("domain skills")) {
				skillCalls++;
				if (prompt.includes('empty "skills" array')) {
					return JSON.stringify({
						skills: [
							{
								name: "diff-review",
								trigger: "review this PR",
								guidance: "read the diff, report findings",
							},
						],
					});
				}
				return JSON.stringify({ skills: [] });
			}
			return "{}";
		});

		const plan = await runLLMPlan(provider, spec);

		expect(skillCalls).toBe(2);
		expect(plan.customSkills).toBeDefined();
		expect(plan.customSkills?.[0]?.name).toBe("diff-review");
	});
});

describe("enrichment prompt hardening (source-level)", () => {
	const src = readFileSync(
		new URL("../src/builder/llm/plan.ts", import.meta.url),
		"utf8",
	);

	it("gives the commands and skills enrichment calls a worked JSON example, like CORE_EXAMPLE", () => {
		expect(src).toContain("const COMMANDS_EXAMPLE = `{");
		expect(src).toContain("const SKILLS_EXAMPLE = `{");
		expect(src).toContain("${COMMANDS_EXAMPLE}");
		expect(src).toContain("${SKILLS_EXAMPLE}");
	});

	it("retries exactly once, inside each enrichment's own closure, on a zero-length result", () => {
		expect(src).toContain('if (raw.length === 0) {');
		// two occurrences: one for commands, one for skills
		expect(src.match(/if \(raw\.length === 0\) \{/g)).toHaveLength(2);
	});

	it("keeps the Promise.all parallel structure from PR #22 intact", () => {
		expect(src).toContain("await Promise.all([");
		expect(src).toContain("// Bespoke slash commands.");
		expect(src).toContain("// Bespoke skills (procedural memory).");
		expect(src).toContain("// Pipeline: ordered stages");
	});

	it("still swallows enrichment failures — best-effort, never load-bearing", () => {
		expect(src).toContain("/* no custom commands */");
		expect(src).toContain("/* no custom skills */");
		expect(src).toContain("/* no pipeline");
	});
});
