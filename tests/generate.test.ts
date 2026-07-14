import { describe, expect, it } from "vitest";
import { pascalCase, runGenerate } from "../src/builder/llm/generate";
import type { LLMSpec } from "../src/builder/llm/schemas";
import type { Provider } from "../src/services/api/client";

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

const spec: LLMSpec = {
	name: "review-agent",
	purpose: "Reviews PRs",
	language: ["typescript"],
	tools: ["bash"],
	commands: ["/help"],
	models: ["ollama"],
	customTools: [
		{ name: "jira_fetch", description: "Fetch a Jira ticket by key" },
	],
};

const VALID_CODE = `import { z } from "zod";

const inputSchema = z.object({ key: z.string().describe("Ticket key") });

export const JiraFetchTool = {
  name: "jira_fetch",
  description: "Fetch a Jira ticket by key",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { key: string }) {
    if (!process.env.JIRA_TOKEN) return { error: "JIRA_TOKEN not set", isError: true };
    return { content: "ok " + input.key };
  },
};
`;

describe("pascalCase", () => {
	it("converts snake_case tool ids", () => {
		expect(pascalCase("jira_fetch")).toBe("JiraFetch");
		expect(pascalCase("bash")).toBe("Bash");
	});
});

describe("runGenerate", () => {
	it("generates a tool file at the registry-derived path", async () => {
		const provider = mockProvider([JSON.stringify({ code: VALID_CODE })]);
		const result = await runGenerate(provider, spec);
		expect(result).toHaveLength(1);
		expect(result[0].toolId).toBe("jira_fetch");
		expect(result[0].path).toBe("tools/JiraFetchTool/JiraFetchTool.ts");
		expect(result[0].code).toContain("export const JiraFetchTool");
	});

	it("re-prompts when the export name is wrong, then succeeds", async () => {
		const wrong = VALID_CODE.replace("JiraFetchTool", "WrongNameTool");
		const provider = mockProvider([
			JSON.stringify({ code: wrong }),
			JSON.stringify({ code: VALID_CODE }),
		]);
		const result = await runGenerate(provider, spec);
		expect(result).toHaveLength(1);
		expect(result[0].code).toContain("export const JiraFetchTool");
	});

	it("returns empty for specs without customTools", async () => {
		const provider = mockProvider(["should never be called"]);
		const result = await runGenerate(provider, { ...spec, customTools: [] });
		expect(result).toEqual([]);
	});
});
