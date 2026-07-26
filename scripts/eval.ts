#!/usr/bin/env bun
/**
 * harnage EVAL — the canonical quality bar + the moat dataset.
 *
 *   bun scripts/eval.ts --dry-run          # validate the battery offline, no model
 *   bun scripts/eval.ts <model> [ollamaURL]  # run the real battery on a local model
 *   bun scripts/eval.ts qwen2.5:3b
 *
 * What it does: builds a generated harness, then drives a DOMAIN-VARIED task
 * battery (coding + data + docs — not just code, so the number isn't anchored)
 * through the generated engine on a local Ollama model, scoring pass/fail +
 * latency per task. Two things come out:
 *   1. THE NUMBER — an honest pass-rate for "does a generated harness actually
 *      complete real tasks on this model", per tier bar.
 *   2. THE MOAT DATA — every run is appended to ~/.harnage/eval-results.jsonl
 *      ({ts, model, buildModel, tier, loop, task, category, pass, ms}). This
 *      growing record of which model+config passes which task is the
 *      compounding asset a copycat can't clone by reading the source.
 *
 * OFFLINE: local Ollama only, no API keys, no egress beyond localhost. The
 * non-dry-run form EXECUTES the model — run it yourself; --dry-run is the
 * reproducible proof the battery is sound.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";

type Category = "code" | "data" | "docs";
interface Task {
	id: string;
	category: Category;
	goal: string;
	check: (out: string, fixture: string) => boolean;
}

const TASKS: Task[] = [
	// ── code ──
	{
		id: "code:census",
		category: "code",
		goal: "Count the files in the current directory grouped by extension and report the totals.",
		check: (o) => /\b(ts|js|md|csv)\b/.test(o) && /\d/.test(o),
	},
	{
		id: "code:targeted-read",
		category: "code",
		goal: "What does the file a.ts export? Read it and answer.",
		check: (o) => /greet/i.test(o),
	},
	{
		id: "code:largest",
		category: "code",
		goal: "Find the largest .ts file in the current directory and show its first few lines.",
		check: (o) => /LARGEST/.test(o) || /big\.ts/.test(o),
	},
	{
		id: "code:write",
		category: "code",
		goal: "Create a file named hello.txt containing exactly the text HELLO in the current directory.",
		check: (_o, fx) =>
			existsSync(join(fx, "hello.txt")) &&
			/HELLO/.test(readFileSync(join(fx, "hello.txt"), "utf-8")),
	},
	{
		id: "code:recovery",
		category: "code",
		goal: "Read the file does-not-exist-42.ts and summarize it.",
		check: (o) =>
			/no (such )?file|not (be )?(found|exist)|does ?n'?t exist|couldn'?t|unable|cannot|can'?t find|isn'?t (there|present)/i.test(
				o,
			),
	},
	// ── data ── (non-coding: exercises the de-anchored path)
	{
		id: "data:filter-count",
		category: "data",
		goal: 'Read data.csv and tell me how many rows have status "active".',
		// fixture has exactly 3 active rows
		check: (o) => /\b3\b/.test(o) && /active/i.test(o),
	},
	// ── docs ──
	{
		id: "docs:qa",
		category: "docs",
		goal: "Read notes.md and tell me which port the server runs on.",
		// notes.md says port 8137
		check: (o) => /8137/.test(o),
	},
];

function writeFixture(dir: string): void {
	writeFileSync(
		join(dir, "a.ts"),
		"export function greet(): string {\n  return 'hi';\n}\n",
	);
	writeFileSync(join(dir, "b.js"), "module.exports = { ok: true };\n");
	writeFileSync(join(dir, "readme.md"), "# Fixture\nSample project.\n");
	writeFileSync(
		join(dir, "big.ts"),
		`// LARGEST\n${Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`,
	);
	writeFileSync(
		join(dir, "data.csv"),
		"id,name,status\n1,alpha,active\n2,beta,inactive\n3,gamma,active\n4,delta,inactive\n5,epsilon,active\n",
	);
	writeFileSync(
		join(dir, "notes.md"),
		"# Ops notes\nThe API server runs on port 8137 in production.\nRestart with `bun run start`.\n",
	);
}

const RESULTS_PATH = join(homedir(), ".harnage", "eval-results.jsonl");

function persist(row: Record<string, unknown>): void {
	try {
		mkdirSync(join(homedir(), ".harnage"), { recursive: true });
		appendFileSync(RESULTS_PATH, `${JSON.stringify(row)}\n`);
	} catch {
		/* best-effort — never fail the eval on a persistence hiccup */
	}
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const model = positional[0];
const baseUrl = positional[1] ?? "http://localhost:11434";

if (dryRun) {
	// Validate the battery is well-formed without touching a model: every task
	// checks against the fixture as expected (checks that read files resolve).
	const fx = await mkdtemp(join(tmpdir(), "eval-dry-"));
	writeFixture(fx);
	console.log("harnage eval — dry run (battery validation)\n");
	console.log(`Tasks: ${TASKS.length} across ${new Set(TASKS.map((t) => t.category)).size} categories`);
	for (const t of TASKS) {
		console.log(`  ${t.category.padEnd(5)} ${t.id}`);
	}
	// sanity: fixture files the checks depend on exist
	const need = ["a.ts", "big.ts", "data.csv", "notes.md"];
	const missing = need.filter((f) => !existsSync(join(fx, f)));
	await rm(fx, { recursive: true, force: true });
	if (missing.length) {
		console.error(`\nFIXTURE BROKEN — missing: ${missing.join(", ")}`);
		process.exit(1);
	}
	console.log("\nBattery sound. Run `bun scripts/eval.ts <model>` to score a model.");
	process.exit(0);
}

if (!model) {
	console.error(
		"usage: bun scripts/eval.ts <model> [ollamaURL]  |  bun scripts/eval.ts --dry-run",
	);
	process.exit(1);
}

const buildRoot = await mkdtemp(join(tmpdir(), "eval-build-"));
const fixture = await mkdtemp(join(tmpdir(), "eval-fixture-"));
writeFixture(fixture);

const policy = {
	mode: "default" as const,
	rules: [
		{ pattern: "bash(*)", allow: true },
		{ pattern: "file_write(*)", allow: true },
		{ pattern: "file_edit(*)", allow: true },
	],
};

const buildModel = process.env.EVAL_BUILD_MODEL;
let buildProvider: Parameters<typeof buildHarness>[3] | undefined;
if (buildModel) {
	const { createProvider } = await import("../src/services/api/client");
	buildProvider = {
		provider: createProvider({
			type: "ollama",
			model: buildModel,
			baseUrl,
			maxTokens: 8192,
			contextTokens: 8192,
		}),
		maxRepairs: 1,
	};
	console.log(`Building a generated harness with build-model ${buildModel}…`);
} else {
	console.log("Building a generated harness (offline chassis)…");
}

const build = await buildHarness(
	"a codebase and data analysis agent that inspects files, reads data, and answers questions",
	buildRoot,
	undefined,
	buildProvider,
);
if (!build.success) {
	console.error("build failed:", build.errors);
	process.exit(1);
}
const gen = build.outputDir;

const { getAllTools } = (await import(join(gen, "src/tools.ts"))) as {
	getAllTools: () => Promise<unknown[]>;
};
const { LoopEngine } = (await import(join(gen, "src/engine.ts"))) as {
	LoopEngine: new (cfg: Record<string, unknown>) => {
		run(goal: string): Promise<string>;
	};
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

console.log(`\nModel:    ${model}`);
console.log(
	`Scaffold: ${profile.tier} tier · ${profile.loop} loop · ${profile.toolCalling} dispatch\n`,
);

process.chdir(fixture);
const ts = new Date().toISOString();
let passed = 0;
const byCat: Record<string, { pass: number; total: number }> = {};

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
	const ms = Math.round(performance.now() - started);
	const ok = !err && task.check(out, fixture);
	if (ok) passed++;
	byCat[task.category] ??= { pass: 0, total: 0 };
	byCat[task.category].total++;
	if (ok) byCat[task.category].pass++;
	console.log(
		`${ok ? "✓" : "✗"} ${task.id.padEnd(20)} ${String(Math.round(ms / 100) / 10).padStart(6)}s`,
	);
	if (!ok) console.log(`    ${(err ?? out).replace(/\s+/g, " ").slice(0, 160)}`);
	persist({
		ts,
		model,
		buildModel: buildModel ?? "offline",
		tier: profile.tier,
		loop: profile.loop,
		task: task.id,
		category: task.category,
		pass: ok,
		ms,
	});
}

const catLine = Object.entries(byCat)
	.map(([c, s]) => `${c} ${s.pass}/${s.total}`)
	.join(" · ");
const BAR: Record<string, number> = { frontier: 7, strong: 7, mid: 5, small: 4 };
const tier = String(profile.tier);
const bar = BAR[tier] ?? TASKS.length;
const gatePass = passed >= bar;
console.log(`\n${passed}/${TASKS.length} passed  (${catLine})`);
console.log(
	`bar ${bar}/${TASKS.length} for ${tier} tier → ${gatePass ? "PASS" : "FAIL"}`,
);
console.log(`results appended → ${RESULTS_PATH}\n`);

await rm(buildRoot, { recursive: true, force: true });
process.exit(gatePass ? 0 : 1);
