import { describe, expect, it } from "vitest";
import { disallowedImports } from "../src/builder/llm/generate";

// Regression: a generated harness ships a fixed package.json, so LLM-generated
// tool/command code that imports an undeclared package (observed: llama-3.3-70b
// emitting `import fetch from "node-fetch"`) fails `tsc --noEmit` with "Cannot
// find module" — unfixable by the repair loop. The generate-stage schema now
// rejects disallowed imports so the model self-corrects on retry.
describe("disallowedImports — only zod + node: builtins + relative allowed", () => {
	it("flags external packages the fixed package.json doesn't ship", () => {
		expect(disallowedImports('import fetch from "node-fetch";')).toEqual([
			"node-fetch",
		]);
		// The model dodges a node-fetch ban by inventing node:fetch — but that's
		// not a real builtin (fetch is a global), so validating against the
		// actual builtin list catches it too.
		expect(disallowedImports('import fetch from "node:fetch";')).toEqual([
			"node:fetch",
		]);
		expect(
			disallowedImports(
				'import { Octokit } from "@octokit/rest";\nimport axios from "axios";',
			).sort(),
		).toEqual(["@octokit/rest", "axios"]);
		expect(disallowedImports('import dotenv from "dotenv";')).toEqual([
			"dotenv",
		]);
	});

	it("allows zod, node: builtins, relative imports, and the global fetch", () => {
		expect(disallowedImports('import { z } from "zod";')).toEqual([]);
		expect(
			disallowedImports('import { readFile } from "node:fs/promises";'),
		).toEqual([]);
		expect(disallowedImports('import type { Tool } from "../../Tool";')).toEqual(
			[],
		);
		expect(
			disallowedImports('const r = await fetch("https://api.example.com");'),
		).toEqual([]);
	});
});
