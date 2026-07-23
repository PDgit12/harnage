import { builtinModules } from "node:module";
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

// Generated harnesses ship with a fixed package.json — a tool/command that
// imports an undeclared package (observed: llama-3.3-70b emitting `import fetch
// from "node-fetch"`, then dodging to the invented `node:fetch`) fails `tsc
// --noEmit` with "Cannot find module", which the repair loop can't fix (the
// package genuinely isn't installed / isn't a real module). Only zod, relative
// imports, and REAL node: built-ins are allowed. Crucially `node:fetch` is not
// a builtin — fetch is a global, no import — so validating the node: prefix
// against the actual builtinModules list (not just the prefix) catches that
// exact hallucination. Lists disallowed bare imports so the schema refine can
// reject them and feed the reason back to the model for self-correction.
const NODE_BUILTINS = new Set(builtinModules);

function isRealNodeBuiltin(spec: string): boolean {
	if (!spec.startsWith("node:")) return false;
	// node:fs/promises → fs; the subpath doesn't change builtin-ness.
	return NODE_BUILTINS.has(spec.slice(5).split("/")[0]);
}

export function disallowedImports(code: string): string[] {
	const bad = new Set<string>();
	const re = /(?:from|import|require\s*\()\s*["']([^"']+)["']/g;
	let m: RegExpExecArray | null = re.exec(code);
	while (m !== null) {
		const spec = m[1];
		if (
			!spec.startsWith("./") &&
			!spec.startsWith("../") &&
			!isRealNodeBuiltin(spec) &&
			spec !== "zod"
		) {
			bad.add(spec);
		}
		m = re.exec(code);
	}
	return [...bad];
}

function importRefineMessage(code: string): string {
	return `These imports are not available: ${disallowedImports(code).join(", ")}. This harness ships a fixed package.json — only "zod", relative imports, and real node: built-ins (node:fs, node:path, node:child_process, node:os, node:crypto, …) work. For HTTP use the global fetch() with NO import at all — "node:fetch" is NOT a module (fetch is a global), and node-fetch/axios/got are not installed.`;
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

	// Each tool is an independent LLM call — generate them in parallel so a slow
	// build brain (reasoning models spend ~45s/call) doesn't serialize N tools
	// into minutes. A single tool that fails all attempts throws and aborts the
	// build (tools are load-bearing, unlike best-effort enrichment).
	const results = await Promise.all(
		custom.map(async (tool): Promise<GeneratedTool | null> => {
			const toolId = tool.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "")
				.slice(0, 30);
			if (!toolId) return null;
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
					})
					.refine((c) => disallowedImports(c).length === 0, {
						error: (iss) => importRefineMessage(iss.input as string),
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
			return {
				toolId,
				path: `tools/${pascal}Tool/${pascal}Tool.ts`,
				code: result.code,
			};
		}),
	);

	return results.filter((t): t is GeneratedTool => t !== null);
}

export interface GeneratedCommand {
	/** command id without slash, e.g. "review" */
	id: string;
	description: string;
	/** relative path under the generated src/ dir, e.g. "commands/review.ts" */
	path: string;
	code: string;
}

const EXAMPLE_COMMAND = `export async function call(args: string[], _context: unknown): Promise<{ value: string }> {
  const target = args[0] ?? "HEAD";
  return { value: "Reviewing " + target + "…" };
}`;

/**
 * GENERATE stage for bespoke slash commands. The LLM writes a real command
 * handler module from the planned behavior. Output is zod-validated (must
 * export an async call returning { value }), compile-checked by verifyBuild,
 * and fixed by the repair loop like any other generated file.
 */
export async function runGenerateCommands(
	provider: Provider,
	commands: Array<{ name: string; description: string; behavior: string }>,
	purpose: string,
): Promise<GeneratedCommand[]> {
	// Independent per-command LLM calls, run in parallel — same reason as
	// runGenerate: sequential generation on a slow build brain blows the time
	// budget. A command that fails all attempts throws and aborts the build.
	const results = await Promise.all(
		commands.map(async (cmd): Promise<GeneratedCommand | null> => {
			const id = cmd.name
				.toLowerCase()
				.replace(/^\//, "")
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "")
				.slice(0, 30);
			if (!id) return null;

			const schema = z.object({
				code: z
					.string()
					.min(60)
					.refine((c) => /export\s+async\s+function\s+call\s*\(/.test(c), {
						message: "code must export: async function call(args, context)",
					})
					.refine((c) => disallowedImports(c).length === 0, {
						error: (iss) => importRefineMessage(iss.input as string),
					}),
			});

			const prompt = `Write a complete TypeScript slash-command module for an AI agent harness.

Command: "/${id}"
- purpose: ${cmd.description}
- behavior: ${cmd.behavior}
- agent purpose (context): ${purpose}

It must follow EXACTLY this structure:
${EXAMPLE_COMMAND}

Rules:
- export exactly one async function named call(args: string[], context: unknown) returning { value: string }
- args are the whitespace-split words after the command name
- Only use Bun/Node built-ins (node:fs, node:path, node:child_process, fetch) and no other packages
- Read any credentials from process.env and return a clear message when missing; never throw
- The returned value is printed to the user; keep it concise plain text

Respond with ONLY JSON: {"code": "<the complete file content>"}`;

			const result = await completeJSON(provider, prompt, schema);
			return {
				id,
				description: cmd.description,
				path: `commands/${id}.ts`,
				code: result.code,
			};
		}),
	);
	return results.filter((c): c is GeneratedCommand => c !== null);
}
