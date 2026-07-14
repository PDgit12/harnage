#!/usr/bin/env bun
/**
 * Engine v3 profile acceptance battery.
 *
 *   bun scripts/bench-profile.ts <model> [ollamaBaseUrl]
 *   bun scripts/bench-profile.ts qwen3:8b
 *   bun scripts/bench-profile.ts qwen2.5:3b
 *
 * Builds a real generated harness (offline, deterministic chassis) and drives
 * the T1–T5 tasks through its Engine v3 on a LOCAL Ollama model, recording
 * pass/latency. This EXECUTES the local model — run it yourself.
 *
 * Bar: qwen3-8b 5/5 · qwen2.5:3b >=4/5 (pipeline mode).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";

const model = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:11434";
if (!model) {
	console.error("usage: bun scripts/bench-profile.ts <model> [ollamaBaseUrl]");
	process.exit(1);
}

interface Task {
	id: string;
	goal: string;
	check: (out: string, fixture: string) => boolean;
}

const TASKS: Task[] = [
	{
		id: "T1 file census",
		goal: "Count the files in the current directory grouped by extension and report the totals.",
		check: (o) => /\.(ts|js|md)\b/.test(o) && /\d/.test(o),
	},
	{
		id: "T2 targeted read",
		goal: "What does the file a.ts export? Read it and answer.",
		check: (o) => /greet/i.test(o),
	},
	{
		id: "T3 multi-step",
		goal: "Find the largest .ts file in the current directory and show its first few lines.",
		check: (o) => /LARGEST/.test(o),
	},
	{
		id: "T4 write path",
		goal: "Create a file named hello.txt containing exactly the text HELLO in the current directory.",
		check: (_o, fx) =>
			existsSync(join(fx, "hello.txt")) &&
			/HELLO/.test(readFileSync(join(fx, "hello.txt"), "utf-8")),
	},
	{
		id: "T5 recovery",
		goal: "Read the file does-not-exist-42.ts and summarize it.",
		check: (o) =>
			/not (found|exist)|no such|does ?n'?t exist|unable|cannot/i.test(o),
	},
];

function writeFixture(dir: string): void {
	writeFileSync(
		join(dir, "a.ts"),
		"export function greet(): string {\n  return 'hi';\n}\n",
	);
	writeFileSync(join(dir, "b.js"), "module.exports = { ok: true };\n");
	writeFileSync(join(dir, "readme.md"), "# Fixture\nSample project.\n");
	// Deliberately the largest .ts file, tagged so T3 can be graded.
	const big =
		"// LARGEST\n" +
		Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join(
			"\n",
		) +
		"\n";
	writeFileSync(join(dir, "big.ts"), big);
}

const policy = {
	mode: "default" as const,
	rules: [
		{ pattern: "bash(*)", allow: true },
		{ pattern: "file_write(*)", allow: true },
		{ pattern: "file_edit(*)", allow: true },
	],
};

const buildRoot = await mkdtemp(join(tmpdir(), "bench-build-"));
const fixture = await mkdtemp(join(tmpdir(), "bench-fixture-"));
writeFixture(fixture);

console.log(`\nBuilding a generated harness (offline chassis)…`);
const build = await buildHarness(
	"a codebase analysis and file agent that inspects and edits a project",
	buildRoot,
);
if (!build.success) {
	console.error("build failed:", build.errors);
	process.exit(1);
}
const gen = build.outputDir;

// Import the GENERATED Engine v3 straight from the build output.
const { getAllTools } = (await import(join(gen, "src/tools.ts"))) as {
	getAllTools: () => Promise<unknown[]>;
};
const { LoopEngine } = (await import(join(gen, "src/engine.ts"))) as {
	LoopEngine: new (
		cfg: Record<string, unknown>,
	) => { run(goal: string): Promise<string> };
};
const { resolveProfile } = (await import(join(gen, "src/profiles.ts"))) as {
	resolveProfile: (m: string, ctx?: number) => Record<string, unknown>;
};

const profile = resolveProfile(model, 8192);
const tools = await getAllTools();
const providerConfig = {
	type: "ollama",
	model,
	baseUrl,
	maxTokens: 4096,
	contextTokens: 8192,
};

console.log(`\nModel:   ${model}`);
console.log(
	`Scaffold: ${profile.tier} tier · ${profile.loop} loop · ${profile.toolCalling} dispatch · ${profile.maxTools} tools`,
);
console.log(`Fixture:  ${fixture}\n`);

process.chdir(fixture);

let passed = 0;
for (const task of TASKS) {
	const started = performance.now();
	let out = "";
	let err: string | undefined;
	try {
		const engine = new LoopEngine({
			tools,
			providerConfig,
			profile,
			policy,
			persistSession: false,
		});
		out = await engine.run(task.goal);
	} catch (e) {
		err = e instanceof Error ? e.message : String(e);
	}
	const secs = Math.round((performance.now() - started) / 100) / 10;
	const ok = !err && task.check(out, fixture);
	if (ok) passed++;
	console.log(
		`${ok ? "✓" : "✗"} ${task.id.padEnd(18)} ${String(secs).padStart(6)}s`,
	);
	if (!ok)
		console.log(`    ${(err ?? out).replace(/\s+/g, " ").slice(0, 160)}`);
}

console.log(
	`\n${passed}/${TASKS.length} passed  (${model}, ${profile.tier} tier / ${profile.loop} loop)\n`,
);

await rm(buildRoot, { recursive: true, force: true });
await rm(fixture, { recursive: true, force: true });
process.exit(passed === TASKS.length ? 0 : 1);
