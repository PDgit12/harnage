#!/usr/bin/env bun
/**
 * Archetype performance battery: prove the generated engine does real DOMAIN
 * work — code, data, docs, and review tasks — not just the file-census demo.
 *
 *   bun scripts/bench-archetype.ts <model>
 *   bun scripts/bench-archetype.ts qwen2.5:3b
 *
 * Builds one harness (offline chassis), then drives domain-flavored tasks
 * against real fixtures on a LOCAL Ollama model, grading pass/latency. This
 * EXECUTES the local model — run it yourself. Exits nonzero if any task fails.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";

const model = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:11434";
if (!model) {
	console.error("usage: bun scripts/bench-archetype.ts <model> [ollamaBaseUrl]");
	process.exit(1);
}

interface Task {
	id: string;
	goal: string;
	check: (out: string) => boolean;
}

// One real task per beachhead archetype, graded leniently on substance.
const TASKS: Task[] = [
	{
		id: "code   · find symbol",
		goal: "Which file defines the function named parseConfig? Read the .ts files and name the file.",
		check: (o) => /config\.ts/i.test(o),
	},
	{
		id: "data   · count rows",
		goal: "How many data rows (excluding the header) are in users.csv? Read it and give the number.",
		check: (o) => /\b3\b/.test(o),
	},
	{
		id: "docs   · answer from README",
		goal: "According to README.md, what database does this project use? Read it and answer.",
		check: (o) => /postgres/i.test(o),
	},
	{
		id: "review · spot the TODO",
		goal: "Does payment.ts contain a TODO comment? Read it and answer yes or no with the TODO text.",
		check: (o) => /refund/i.test(o),
	},
];

function writeFixture(dir: string): void {
	writeFileSync(
		join(dir, "config.ts"),
		"export function parseConfig(raw: string) {\n  return JSON.parse(raw);\n}\n",
	);
	writeFileSync(join(dir, "index.ts"), "import { parseConfig } from './config';\n");
	writeFileSync(
		join(dir, "users.csv"),
		"id,name,role\n1,Ada,admin\n2,Linus,dev\n3,Grace,dev\n",
	);
	writeFileSync(
		join(dir, "README.md"),
		"# Ledger\n\nA small service. It stores records in a PostgreSQL database.\n",
	);
	writeFileSync(
		join(dir, "payment.ts"),
		"export function charge(cents: number) {\n  // TODO: handle refund path\n  return cents;\n}\n",
	);
}

const policy = {
	mode: "default" as const,
	rules: [{ pattern: "bash(*)", allow: true }],
};

const buildRoot = await mkdtemp(join(tmpdir(), "arch-build-"));
const fixture = await mkdtemp(join(tmpdir(), "arch-fixture-"));
writeFixture(fixture);

console.log("\nBuilding a generated harness (offline chassis)…");
const build = await buildHarness(
	"a codebase, data, and documentation agent that inspects a project",
	buildRoot,
	undefined,
	undefined,
);
if (!build.success) {
	console.error("build failed:", build.errors);
	process.exit(1);
}

const { getAllTools } = (await import(join(build.outputDir, "src/tools.ts"))) as {
	getAllTools: () => Promise<unknown[]>;
};
const { LoopEngine } = (await import(join(build.outputDir, "src/engine.ts"))) as {
	LoopEngine: new (cfg: Record<string, unknown>) => { run(goal: string): Promise<string> };
};
const { resolveProfile } = (await import(join(build.outputDir, "src/profiles.ts"))) as {
	resolveProfile: (m: string, ctx?: number) => Record<string, unknown>;
};

const profile = resolveProfile(model, 8192);
const tools = await getAllTools();
process.chdir(fixture);

console.log(`\nModel:   ${model}`);
console.log(`Scaffold: ${profile.tier} tier · ${profile.loop} loop · ${profile.toolCalling} dispatch\n`);

let passed = 0;
for (const task of TASKS) {
	const started = performance.now();
	let out = "";
	let err: string | undefined;
	try {
		const engine = new LoopEngine({
			tools,
			providerConfig: { type: "ollama", model, baseUrl, maxTokens: 4096, contextTokens: 8192 },
			profile,
			policy,
			persistSession: false,
		});
		out = await engine.run(task.goal);
	} catch (e) {
		err = e instanceof Error ? e.message : String(e);
	}
	const secs = Math.round((performance.now() - started) / 100) / 10;
	const ok = !err && task.check(out);
	if (ok) passed++;
	console.log(`${ok ? "✓" : "✗"} ${task.id.padEnd(24)} ${String(secs).padStart(6)}s`);
	if (!ok) console.log(`    ${(err ?? out).replace(/\s+/g, " ").slice(0, 150)}`);
}

console.log(`\n${passed}/${TASKS.length} archetype tasks passed  (${model})\n`);
await rm(buildRoot, { recursive: true, force: true });
await rm(fixture, { recursive: true, force: true });
process.exit(passed === TASKS.length ? 0 : 1);
