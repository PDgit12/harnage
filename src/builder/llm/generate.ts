import { z } from "zod";
import type { Provider } from "../../services/api/client";
import type { ProjectContext } from "../spec/context";
import { completeJSON } from "./client";
import type { LLMSpec } from "./schemas";

export interface GeneratedTool {
	/** snake_case tool id, e.g. "jira_fetch" — registry derives JiraFetchTool */
	toolId: string;
	/** relative path under the generated src/ dir */
	path: string;
	code: string;
}

export function pascalCase(id: string): string {
	return (
		id.charAt(0).toUpperCase() +
		id.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
	);
}

const EXAMPLE_TOOL = `import { z } from "zod";

const inputSchema = z.object({
  query: z.string().describe("Search query"),
  limit: z.number().optional().describe("Max results"),
});

export const IssueSearchTool = {
  name: "issue_search",
  description: "Search the issue tracker for matching issues",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { query: string; limit?: number }) {
    try {
      const res = await fetch("https://api.example.com/search?q=" + encodeURIComponent(input.query));
      if (!res.ok) return { error: "Search failed: HTTP " + res.status, isError: true };
      const data = await res.json();
      return { data, content: JSON.stringify(data).slice(0, 2000) };
    } catch (err) {
      return { error: String(err), isError: true };
    }
  },
};
`;

/**
 * GENERATE stage: LLM writes real implementations for the spec's customTools.
 * Each tool follows the exact template convention so the generated registry
 * picks it up by naming alone. Output is compile-checked by verifyBuild and
 * fixed by the repair loop like any other generated file.
 */
export async function runGenerate(
	provider: Provider,
	spec: LLMSpec,
	_context?: ProjectContext,
): Promise<GeneratedTool[]> {
	const custom = spec.customTools ?? [];
	const generated: GeneratedTool[] = [];

	for (const tool of custom) {
		const toolId = tool.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 30);
		if (!toolId) continue;
		const pascal = pascalCase(toolId);

		const schema = z.object({
			code: z
				.string()
				.min(100)
				.refine((c) => c.includes(`export const ${pascal}Tool`), {
					message: `code must contain: export const ${pascal}Tool = { ... }`,
				})
				.refine((c) => c.includes('from "zod"'), {
					message:
						'code must import { z } from "zod" and define a zod inputSchema',
				}),
		});

		const prompt = `Write a complete TypeScript tool module for an AI agent harness.

Tool to implement:
- id: "${toolId}"
- purpose: ${tool.description}
- agent purpose (context): ${spec.purpose}

It must follow EXACTLY this structure (example of a different tool):
${EXAMPLE_TOOL}

Rules:
- Export exactly one const named ${pascal}Tool with fields: name ("${toolId}"), description, inputSchema (zod), isReadOnly, async call(input)
- call() returns { data?, content? } on success or { error, isError: true } on failure — never throw
- Only use Bun/Node built-ins (node:fs, node:path, node:child_process, fetch) and zod — no other packages
- If the tool needs credentials, read them from process.env and return a clear error when missing

Respond with ONLY JSON: {"code": "<the complete file content>"}`;

		const result = await completeJSON(provider, prompt, schema);
		generated.push({
			toolId,
			path: `tools/${pascal}Tool/${pascal}Tool.ts`,
			code: result.code,
		});
	}

	return generated;
}
