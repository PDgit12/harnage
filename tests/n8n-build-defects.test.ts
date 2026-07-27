import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS_REGISTRY } from "../src/builder/assemble/templates";
import type { HarnessPlan } from "../src/builder/index";
import {
	disallowedImports,
	packageRoot,
	stripFetchShimImports,
} from "../src/builder/llm/generate";
import { repairLoop } from "../src/builder/llm/repair";
import { resolveToolByName, splitToolCallName } from "../src/loop/tool-parser";
import type { Tool } from "../src/Tool";

// All four defects below were observed in ONE real build: a user's n8n-automation
// harness generated on qwen2.5:3b (v0.5.0). Each test pins the exact shape of the
// failure, not a paraphrase of it.

// ── Defect 1: the repair loop reintroduced `node:fetch` ──────────────────────
describe("fetch-shim imports are stripped deterministically", () => {
	// Verbatim first line of the generated src/commands/import.ts that failed
	// `tsc --noEmit` with "Cannot find module 'node:fetch'".
	const real = `import fetch from 'node:fetch';
import fs from 'node:fs/promises';

export async function call() {
  const res = await fetch("https://example.test");
  return { value: String(res.status) };
}
`;

	it("removes the bogus import and leaves the rest untouched", () => {
		const out = stripFetchShimImports(real);
		expect(disallowedImports(real)).toEqual(["node:fetch"]);
		expect(disallowedImports(out)).toEqual([]);
		expect(out).toContain('import fs from \'node:fs/promises\';');
		expect(out).toContain("await fetch(");
	});

	it("covers the other spellings the model dodges to", () => {
		for (const spec of [
			"node-fetch",
			"isomorphic-fetch",
			"cross-fetch",
			"whatwg-fetch",
		]) {
			expect(stripFetchShimImports(`import fetch from "${spec}";\nconst a = 1;`))
				.toBe("const a = 1;");
		}
	});

	it("never touches a legitimate import", () => {
		const ok = 'import { z } from "zod";\nimport { join } from "node:path";\n';
		expect(stripFetchShimImports(ok)).toBe(ok);
	});
});

describe("disallowedImports honours the target package.json", () => {
	it("allows declared deps and their subpaths, still flags undeclared ones", () => {
		const code =
			'import { Command } from "commander";\n' +
			'import { Server } from "@modelcontextprotocol/sdk/server/mcp.js";\n' +
			'import axios from "axios";\n';
		const declared = ["commander", "@modelcontextprotocol/sdk"];
		expect(disallowedImports(code, declared)).toEqual(["axios"]);
		// Without the declared list the generate-stage rule still applies.
		expect(disallowedImports(code).sort()).toEqual([
			"@modelcontextprotocol/sdk/server/mcp.js",
			"axios",
			"commander",
		]);
	});

	// Both found by running the build-eval assertion over 10 real generated
	// harnesses: the scanner reported violations in code that compiles fine.
	it("does not mistake a string literal for an import", () => {
		const code =
			'const ok = m.content.startsWith("Observation from ");\n' +
			'const msg = "imported from \'nowhere\'";\n';
		expect(disallowedImports(code)).toEqual([]);
	});

	it("allows Bun built-ins — the chassis itself imports bun:sqlite", () => {
		expect(disallowedImports('import { Database } from "bun:sqlite";')).toEqual(
			[],
		);
		expect(disallowedImports('import { test } from "bun:test";')).toEqual([]);
		// Still not a licence to invent a bun: module.
		expect(disallowedImports('import x from "bun:nope";')).toEqual(["bun:nope"]);
	});

	it("still catches every real import form", () => {
		expect(disallowedImports('import axios from "axios";')).toEqual(["axios"]);
		expect(disallowedImports('export { x } from "lodash";')).toEqual(["lodash"]);
		expect(disallowedImports('import "side-effect-pkg";')).toEqual([
			"side-effect-pkg",
		]);
		expect(disallowedImports('const m = require("got");')).toEqual(["got"]);
		expect(disallowedImports('await import("undici");')).toEqual(["undici"]);
	});

	it("resolves package roots for scoped and subpath specifiers", () => {
		expect(packageRoot("react/jsx-runtime")).toBe("react");
		expect(packageRoot("@scope/pkg/deep/path")).toBe("@scope/pkg");
		expect(packageRoot("zod")).toBe("zod");
	});
});

describe("repairLoop rejects patches that import undeclared packages", () => {
	it("does not write a patch whose imports cannot resolve", async () => {
		const dir = await mkdtemp(join(tmpdir(), "repair-"));
		try {
			await writeFile(
				join(dir, "package.json"),
				JSON.stringify({ name: "t", dependencies: { zod: "^4" } }),
			);
			await writeFile(join(dir, "broken.ts"), "export const a: number = 1;\n");

			// A provider that offers exactly the dodge the real model made.
			let called = 0;
			const provider = {
				async *stream() {
					called++;
					yield {
						type: "text" as const,
						content: JSON.stringify({
							analysis: "add http client",
							patches: [
								{
									path: "broken.ts",
									newContent: 'import axios from "axios";\nexport const a = 1;\n',
								},
							],
						}),
					};
				},
			} as unknown as Parameters<typeof repairLoop>[0];

			const plan = { name: "t", tools: [] } as unknown as HarnessPlan;
			await repairLoop(
				provider,
				plan,
				{ success: false, outputDir: dir, errors: ["broken.ts(1,1): error"] },
				dir,
				undefined,
				1,
			);

			// Guard against a trivially-passing test: the repair loop must really
			// have reached the model and really have refused its patch.
			expect(called).toBeGreaterThan(0);
			const after = await readFile(join(dir, "broken.ts"), "utf-8");
			expect(after).not.toContain("axios");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── Defect 2: tools.ts imported a module that was never generated ────────────
describe("TOOLS_REGISTRY only references modules that exist", () => {
	const plan = (tools: string[]) => ({ tools }) as unknown as HarnessPlan;

	it("skips a tool whose module file was never written", () => {
		const out = TOOLS_REGISTRY(
			plan(["bash", "file_read", "n8n_import"]),
			new Set(["Bash", "FileRead"]),
		);
		expect(out).toContain('Bash: () => import("./tools/BashTool/BashTool.ts")');
		expect(out).toContain("FileRead:");
		expect(out).not.toContain("N8nImport");
	});

	it("skips ids that cannot be a valid object key", () => {
		// A leading digit would emit `8nImport: () => …` — a syntax error, so the
		// generated file would not even parse.
		const out = TOOLS_REGISTRY(plan(["8n_import", "", "grep"]));
		expect(out).not.toContain("8nImport");
		expect(out).toContain("Grep:");
		// Exactly one entry survived.
		expect(out.match(/=> import\(/g)?.length).toBe(1);
	});

	it("emits every tool when no presence set is supplied", () => {
		const out = TOOLS_REGISTRY(plan(["bash", "glob"]));
		expect(out.match(/=> import\(/g)?.length).toBe(2);
	});
});

// ── Defects 3 + 4: malformed tool-call names ─────────────────────────────────
describe("tool-call name normalization", () => {
	const tools = [
		{ name: "grep" },
		{ name: "file_read" },
		{ name: "bash" },
	] as Tool[];

	it("splits args that the model glued onto the name", () => {
		// Verbatim malformation observed on qwen2.5:3b.
		const raw = 'GrepTool{"pattern":"harness","path":"./project"}';
		const split = splitToolCallName(raw, {});
		expect(split.name).toBe("GrepTool");
		expect(split.input).toEqual({ pattern: "harness", path: "./project" });
		expect(resolveToolByName(tools, split.name)?.name).toBe("grep");
	});

	it("keeps real args when both are present", () => {
		const split = splitToolCallName('grep{"pattern":"x"}', { pattern: "y" });
		expect(split).toEqual({ name: "grep", input: { pattern: "y" } });
	});

	it("resolves the casing and suffix variants small models emit", () => {
		expect(resolveToolByName(tools, "grep")?.name).toBe("grep");
		expect(resolveToolByName(tools, "GrepTool")?.name).toBe("grep");
		expect(resolveToolByName(tools, "Grep")?.name).toBe("grep");
		expect(resolveToolByName(tools, "FileReadTool")?.name).toBe("file_read");
		expect(resolveToolByName(tools, "FileRead")?.name).toBe("file_read");
		expect(resolveToolByName(tools, "BASH")?.name).toBe("bash");
	});

	it("still returns undefined for a name that matches nothing", () => {
		// Critical: an unresolvable name must NOT be echoed back to the provider,
		// so it has to stay distinguishable from a resolved one.
		expect(resolveToolByName(tools, "n8n_publish")).toBeUndefined();
		expect(resolveToolByName(tools, "")).toBeUndefined();
	});

	it("leaves a plain name with no args untouched", () => {
		expect(splitToolCallName("bash", { command: "ls" })).toEqual({
			name: "bash",
			input: { command: "ls" },
		});
	});
});
