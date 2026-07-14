#!/usr/bin/env bun
/**
 * Per-model edit-format benchmark (Engine v3, L4).
 *
 *   bun scripts/bench-editformat.ts <model> [ollamaBaseUrl]
 *   bun scripts/bench-editformat.ts qwen3:8b
 *
 * Aider's finding: the best edit format differs per model. This drives the same
 * edit through a generated harness two ways — search/replace (file_edit with
 * exact old/new strings) vs whole-file (file_write) — grades each by reading the
 * file back, and prints the editFormat to set in the profile table for this
 * model. It does NOT auto-edit profiles.ts (human stays in the loop).
 *
 * This EXECUTES the local model — run it yourself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";

const model = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:11434";
if (!model) {
	console.error(
		"usage: bun scripts/bench-editformat.ts <model> [ollamaBaseUrl]",
	);
	process.exit(1);
}

const FILE = "config.ts";
const START = 'export const MODE = "FOO";\n';
const graded = (fixture: string) => {
	const t = readFileSync(join(fixture, FILE), "utf-8");
	return /BAR/.test(t) && !/FOO/.test(t);
};

interface Format {
	id: "search-replace" | "whole-file";
	tools: string[];
	goal: string;
}
const FORMATS: Format[] = [
	{
		id: "search-replace",
		tools: ["file_read", "file_edit"],
		goal: `In ${FILE}, change the value FOO to BAR. Use the file_edit tool with the exact old string and new string — do not rewrite the whole file.`,
	},
	{
		id: "whole-file",
		tools: ["file_read", "file_write"],
		goal: `In ${FILE}, change the value FOO to BAR by rewriting the entire file with the file_write tool.`,
	},
];

const policy = {
	mode: "default" as const,
	rules: [
		{ pattern: "file_edit(*)", allow: true },
		{ pattern: "file_write(*)", allow: true },
	],
};

const buildRoot = await mkdtemp(join(tmpdir(), "editfmt-build-"));
console.log("\nBuilding a generated harness (offline chassis)…");
const build = await buildHarness("a file editing agent", buildRoot);
if (!build.success) {
	console.error("build failed:", build.errors);
	process.exit(1);
}
const gen = build.outputDir;

const { getAllTools } = (await import(join(gen, "src/tools.ts"))) as {
	getAllTools: () => Promise<Array<{ name: string }>>;
};
const { LoopEngine } = (await import(join(gen, "src/engine.ts"))) as {
	LoopEngine: new (
		cfg: Record<string, unknown>,
	) => { run(goal: string): Promise<string> };
};
const { resolveProfile } = (await import(join(gen, "src/profiles.ts"))) as {
	resolveProfile: (m: string, ctx?: number) => Record<string, unknown>;
};

const allTools = await getAllTools();
const profile = resolveProfile(model, 8192);
const providerConfig = {
	type: "ollama",
	model,
	baseUrl,
	maxTokens: 4096,
	contextTokens: 8192,
};

console.log(`\nModel:    ${model}`);
console.log(`Profile editFormat (current): ${profile.editFormat}\n`);

const results: Record<string, { ok: boolean; secs: number }> = {};
for (const fmt of FORMATS) {
	const fixture = await mkdtemp(join(tmpdir(), "editfmt-fx-"));
	writeFileSync(join(fixture, FILE), START);
	process.chdir(fixture);
	const tools = allTools.filter((t) => fmt.tools.includes(t.name));
	const started = performance.now();
	let err: string | undefined;
	try {
		const engine = new LoopEngine({
			tools,
			providerConfig,
			profile,
			policy,
			persistSession: false,
		});
		await engine.run(fmt.goal);
	} catch (e) {
		err = e instanceof Error ? e.message : String(e);
	}
	const secs = Math.round((performance.now() - started) / 100) / 10;
	const ok = !err && graded(fixture);
	results[fmt.id] = { ok, secs };
	console.log(
		`${ok ? "✓" : "✗"} ${fmt.id.padEnd(15)} ${String(secs).padStart(6)}s${err ? "  " + err.slice(0, 100) : ""}`,
	);
	await rm(fixture, { recursive: true, force: true });
}

// Recommend: prefer search-replace when it works (cheaper tokens); else whole-file.
const sr = results["search-replace"];
const wf = results["whole-file"];
const recommend = sr?.ok
	? "search-replace"
	: wf?.ok
		? "whole-file"
		: "none (model failed both — try a larger model)";
console.log(`\nRecommended editFormat for ${model}:  ${recommend}`);
console.log(
	"(set this in src/profiles.ts PROFILE table for this model's tier)\n",
);

await rm(buildRoot, { recursive: true, force: true });
process.exit(sr?.ok || wf?.ok ? 0 : 1);
