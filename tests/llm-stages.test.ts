import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../src/services/api/client";
import { runInterview } from "../src/builder/llm/interview";
import { runLLMPlan } from "../src/builder/llm/plan";
import type { LLMSpec } from "../src/builder/llm/schemas";

function mockProvider(responses: string[]): Provider {
	let i = 0;
	return {
		async *stream() {
			const text = responses[Math.min(i, responses.length - 1)];
			i++;
			yield { type: "text", content: text };
			yield { type: "done" };
		},
	};
}

const SPEC_JSON = JSON.stringify({
	name: "review-agent",
	purpose: "Reviews TypeScript PRs",
	language: ["typescript"],
	tools: ["bash", "file_read"],
	commands: ["/help", "/clear", "/exit", "/model"],
	models: ["ollama"],
});

describe("runInterview", () => {
	it("skips questions when ready:true", async () => {
		const provider = mockProvider([
			'{"ready": true, "questions": []}',
			SPEC_JSON,
		]);
		const spec = await runInterview(provider, "build a review agent");
		expect(spec.name).toBe("review-agent");
		expect(spec.clarifications).toBeUndefined();
	});

	it("invokes ask callback for each question", async () => {
		const provider = mockProvider([
			'{"ready": false, "questions": [{"question": "Which language?", "defaultAnswer": "typescript"}]}',
			SPEC_JSON,
		]);
		const ask = vi.fn().mockResolvedValue("python");
		const spec = await runInterview(provider, "build an agent", { ask });
		expect(ask).toHaveBeenCalledWith("Which language?", "typescript");
		expect(spec.clarifications).toEqual([
			{ question: "Which language?", answer: "python" },
		]);
	});

	it("uses defaultAnswer when non-interactive", async () => {
		const provider = mockProvider([
			'{"ready": false, "questions": [{"question": "Which language?", "defaultAnswer": "typescript"}]}',
			SPEC_JSON,
		]);
		const spec = await runInterview(provider, "build an agent");
		expect(spec.clarifications).toEqual([
			{ question: "Which language?", answer: "typescript" },
		]);
	});
});

describe("runLLMPlan", () => {
	const spec: LLMSpec = {
		name: "review-agent",
		purpose: "Reviews TypeScript PRs",
		language: ["typescript"],
		tools: ["bash"],
		commands: ["/help"],
		models: ["ollama"],
	};

	it("filters unknown tools, unions ALWAYS_TOOLS, sanitizes name", async () => {
		const provider = mockProvider([
			JSON.stringify({
				name: "my-agent",
				description: "desc",
				tools: ["bash", "made_up_tool", "grep"],
				commands: ["/help", "/re-view"],
				providers: ["ollama"],
				systemPrompt: "x".repeat(60),
				hasMcp: false,
			}),
		]);
		const plan = await runLLMPlan(provider, spec);
		expect(plan.tools).not.toContain("made_up_tool");
		for (const t of ["bash", "file_read", "glob", "grep", "file_edit", "file_write"]) {
			expect(plan.tools).toContain(t);
		}
		expect(plan.commands).toContain("re_view");
		expect(plan.providers).toContain("ollama");
	});

	it("falls back to template system prompt when model output is thin", async () => {
		// PlanSchema requires >=50 chars, so a 55-char prompt of whitespace-padded
		// content passes Zod but trims below the threshold in post-processing.
		const thin = `${"a".repeat(10)}${" ".repeat(45)}`;
		const provider = mockProvider([
			JSON.stringify({
				name: "my-agent",
				description: "desc",
				tools: ["bash"],
				commands: ["/help"],
				providers: ["ollama"],
				systemPrompt: thin,
				hasMcp: false,
			}),
		]);
		const plan = await runLLMPlan(provider, spec);
		expect(plan.systemPrompt.length).toBeGreaterThan(100);
		expect(plan.systemPrompt).not.toBe(thin);
	});

	it("passes pipeline stages through, dropping tool refs not in the tool set", async () => {
		const provider = mockProvider([
			JSON.stringify({
				name: "my-agent",
				description: "desc",
				tools: ["bash", "grep"],
				commands: ["/help"],
				providers: ["ollama"],
				systemPrompt: "x".repeat(60),
				hasMcp: false,
				pipeline: [
					{ name: "locate", instruction: "list files", tool: "glob" },
					{ name: "scan", instruction: "search", tool: "made_up_tool" },
					{ name: "report", instruction: "summarize" },
				],
			}),
		]);
		const plan = await runLLMPlan(provider, spec);
		expect(plan.pipeline).toHaveLength(3);
		expect(plan.pipeline?.[0].tool).toBe("glob"); // glob is unioned via ALWAYS_TOOLS
		expect(plan.pipeline?.[1].tool).toBeUndefined(); // made_up_tool dropped
		expect(plan.pipeline?.[2].tool).toBeUndefined();
	});
});
