import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHarness, generatePlan } from "../src/builder/index";
import { parseIntent } from "../src/builder/spec";

describe("builder", () => {
	describe("parseIntent", () => {
		it("detects python language", () => {
			const spec = parseIntent("build a django web app");
			expect(spec.language).toEqual(["python"]);
		});

		it("detects typescript for react prompts", () => {
			const spec = parseIntent("build a react component");
			expect(spec.language).toEqual(["typescript"]);
		});

		it("detects rust for cargo prompts", () => {
			const spec = parseIntent("create a rust crate with cargo");
			expect(spec.language).toEqual(["rust"]);
		});

		it("defaults to typescript when no language matches", () => {
			const spec = parseIntent("build something generic");
			expect(spec.language).toEqual(["typescript"]);
		});

		it("selects ollama model", () => {
			const spec = parseIntent("build a web app");
			expect(spec.models).toEqual(["ollama"]);
		});

		it("extracts purpose from first sentence", () => {
			const spec = parseIntent("Build a CLI. It should be fast.");
			expect(spec.purpose).toBe("Build a CLI");
		});

		it("includes always-tools by default", () => {
			const spec = parseIntent("simple task");
			expect(spec.tools).toContain("bash");
			expect(spec.tools).toContain("file_read");
			expect(spec.tools).toContain("glob");
			expect(spec.tools).toContain("grep");
		});
	});

	describe("generatePlan", () => {
		it("creates plan name from spec purpose", () => {
			const spec = parseIntent("deploy ml pipeline");
			const plan = generatePlan(spec);
			expect(plan.name).toBe("deploy-ml-pipeline");
			expect(plan.description).toBe("deploy ml pipeline");
		});

		it("generates chat commands for the ollama provider", () => {
			const spec = parseIntent("build a web app");
			const plan = generatePlan(spec);
			expect(plan.commands).toContain("local-chat");
		});
	});

	describe("buildHarness", () => {
		it("generates a project with key files", async () => {
			const tmpDir = await mkdtemp(join(tmpdir(), "builder-test-"));
			try {
				const result = await buildHarness(
					"a simple test agent",
					tmpDir,
					() => {},
				);
				expect(result.outputDir).toBeDefined();
				const keyFiles = [
					"package.json",
					"tsconfig.json",
					"src/main.tsx",
					"src/Tool.ts",
					"src/tools.ts",
					"src/commands.ts",
					"vitest.config.ts",
					"src/engine.ts",
					"src/compaction.ts",
					"src/permissions.ts",
					"src/skills.ts",
					"src/session.ts",
					"src/subagent.ts",
					"skills/verify-before-done.md",
				];
				for (const f of keyFiles) {
					await access(join(result.outputDir, f));
				}
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		}, 300_000);

		it("falls back to offline path when the LLM provider always errors", async () => {
			const tmpDir = await mkdtemp(join(tmpdir(), "builder-fallback-"));
			const failingProvider = {
				// biome-ignore lint/correctness/useYield: error-only stream
				async *stream(): AsyncGenerator<{ type: "error"; content: string }> {
					yield { type: "error", content: "connection refused" };
				},
			};
			try {
				const result = await buildHarness(
					"a simple test agent",
					tmpDir,
					() => {},
					{
						provider: failingProvider,
					},
				);
				expect(result.outputDir).toBeDefined();
				await access(join(result.outputDir, "package.json"));
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		}, 300_000);
	});
});
