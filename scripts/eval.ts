#!/usr/bin/env bun
/**
 * harnage EVAL — the canonical quality bar + the moat dataset.
 *
 *   bun scripts/eval.ts --dry-run                 # validate the battery offline, no model
 *   bun scripts/eval.ts qwen2.5:3b                # smoke suite (fast, every change)
 *   bun scripts/eval.ts qwen2.5:3b --suite full   # the release gate
 *   bun scripts/eval.ts qwen2.5:3b --suite data   # one category
 *   bun scripts/eval.ts qwen2.5:3b --k 3          # 3 samples/task → pass@1 and pass@k
 *   EVAL_JUDGE_MODEL=config bun scripts/eval.ts qwen2.5:3b --suite full
 *        ^ judge via the build brain in ~/.harnage/config.json (nothing extra
 *          runs locally). Or name any Ollama model, e.g. EVAL_JUDGE_MODEL=qwen2.5:3b.
 *          Unset = no judge; judged tasks fall back to their deterministic check.
 *
 * What it does: builds a generated harness, then drives a DOMAIN-VARIED task
 * battery (code · edit · data · docs · multistep · tools · refusal · safety —
 * not just code, so the number isn't anchored) through the generated engine on
 * a local Ollama model, scoring pass/fail + latency per task. Two things come
 * out:
 *   1. THE NUMBER — an honest pass-rate for "does a generated harness actually
 *      complete real tasks on this model", against a per-tier bar.
 *   2. THE MOAT DATA — every sample is appended to ~/.harnage/eval-results.jsonl.
 *      This growing record of which model+config passes which task is the
 *      compounding asset a copycat can't clone by reading the source.
 *
 * GRADING is mixed on purpose (see eval-tasks.ts): deterministic checks where
 * the answer is a fact, an LLM judge where it isn't, and both — check gating,
 * judge grading — where a regex alone would be gameable. The judge is itself
 * calibrated against hand-labelled answers before it grades anything.
 *
 * OFFLINE: local Ollama only, no API keys, no egress beyond localhost. The
 * non-dry-run form EXECUTES the model — run it yourself; --dry-run is the
 * reproducible proof the battery is sound.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";
import {
	type CalibrationReport,
	calibrateJudge,
	createJudgeProvider,
	judgeAnswer,
} from "./eval-judge";
import {
	FIXTURE_FILES,
	FIXTURE_VERSION,
	SUITES,
	selectSuite,
	TASKS,
	type Task,
	TIER_BAR,
	writeFixture,
} from "./eval-tasks";

const RESULTS_PATH = join(homedir(), ".harnage", "eval-results.jsonl");

function persist(row: Record<string, unknown>): void {
	try {
		mkdirSync(join(homedir(), ".harnage"), { recursive: true });
		appendFileSync(RESULTS_PATH, `${JSON.stringify(row)}\n`);
	} catch {
		/* best-effort — never fail the eval on a persistence hiccup */
	}
}

function flag(name: string, fallback?: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	return args[i + 1]?.startsWith("--") ? fallback : args[i + 1];
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const suite = flag("suite", "smoke") ?? "smoke";
const k = Math.max(1, Number(flag("k", "1")));
const positional = args.filter((a, i) => {
	if (a.startsWith("--")) return false;
	// drop values consumed by --suite / --k
	const prev = args[i - 1];
	return prev !== "--suite" && prev !== "--k";
});
const model = positional[0];
const baseUrl = positional[1] ?? "http://localhost:11434";

if (!SUITES.includes(suite)) {
	console.error(`unknown suite "${suite}" — pick one of: ${SUITES.join(", ")}`);
	process.exit(1);
}

const selected = selectSuite(suite);

// ─── Dry run: prove the battery is sound without touching a model ───────────
if (dryRun) {
	const fx = await mkdtemp(join(tmpdir(), "eval-dry-"));
	writeFixture(fx);
	console.log("harnage eval — dry run (battery validation)\n");

	const byCat: Record<string, number> = {};
	const byDiff: Record<string, number> = {};
	for (const t of TASKS) {
		byCat[t.category] = (byCat[t.category] ?? 0) + 1;
		byDiff[t.difficulty] = (byDiff[t.difficulty] ?? 0) + 1;
	}
	const judged = TASKS.filter((t) => t.rubric).length;
	console.log(
		`Battery: ${TASKS.length} tasks · ${Object.keys(byCat).length} categories`,
	);
	console.log(
		`  by category   ${Object.entries(byCat)
			.map(([c, n]) => `${c} ${n}`)
			.join(" · ")}`,
	);
	console.log(
		`  by difficulty ${Object.entries(byDiff)
			.map(([d, n]) => `${d} ${n}`)
			.join(" · ")}`,
	);
	console.log(
		`  grading       ${TASKS.length - judged} deterministic · ${judged} judged (${TASKS.filter((t) => t.check && t.rubric).length} of those also gated by a check)`,
	);
	console.log(
		`  suites        ${SUITES.map((s) => `${s} ${selectSuite(s).length}`).join(" · ")}`,
	);
	console.log(`\nSelected suite "${suite}": ${selected.length} tasks`);

	const problems: string[] = [];
	const ids = new Set<string>();
	for (const t of TASKS) {
		if (ids.has(t.id)) problems.push(`duplicate id: ${t.id}`);
		ids.add(t.id);
		if (!t.check && !t.rubric) problems.push(`${t.id}: no grader`);
		if (!t.goal.trim()) problems.push(`${t.id}: empty goal`);
	}
	const missing = FIXTURE_FILES.filter((f) => !existsSync(join(fx, f)));
	if (missing.length) problems.push(`fixture missing: ${missing.join(", ")}`);

	// A deterministic check that passes on an EMPTY answer grades nothing —
	// catch that here rather than discovering an always-green task later.
	for (const t of TASKS) {
		if (
			t.check &&
			!t.id.startsWith("edit:") &&
			!t.id.startsWith("multistep:")
		) {
			try {
				if (t.check("", fx))
					problems.push(`${t.id}: check passes on an empty answer`);
			} catch (e) {
				problems.push(
					`${t.id}: check threw — ${e instanceof Error ? e.message : e}`,
				);
			}
		}
	}

	await rm(fx, { recursive: true, force: true });
	if (problems.length) {
		console.error(`\nBATTERY BROKEN:\n  ${problems.join("\n  ")}`);
		process.exit(1);
	}
	console.log(
		`\nBattery sound. Run \`bun scripts/eval.ts <model> --suite ${suite}\` to score a model.`,
	);
	process.exit(0);
}

if (!model) {
	console.error(
		"usage: bun scripts/eval.ts <model> [ollamaURL] [--suite smoke|full|<category>] [--k N]\n" +
			"       bun scripts/eval.ts --dry-run",
	);
	process.exit(1);
}

// ─── Build the harness under test ──────────────────────────────────────────
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
	LoopEngine: new (
		cfg: Record<string, unknown>,
	) => {
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

// ─── Judge setup ───────────────────────────────────────────────────────────
const judgeModel = process.env.EVAL_JUDGE_MODEL;
const needsJudge = selected.some((t) => t.rubric);
let judgeProvider: Awaited<
	ReturnType<typeof import("../src/services/api/client").createProvider>
> | null = null;
let calibration: CalibrationReport | null = null;

let judgeLabel = judgeModel ?? "";

if (needsJudge && judgeModel) {
	const built = await createJudgeProvider(judgeModel, baseUrl);
	judgeProvider = built.provider;
	judgeLabel = built.label;
	console.log(`Calibrating judge ${judgeLabel} against the labelled set…`);
	calibration = await calibrateJudge(judgeProvider);
	const pct = Math.round(calibration.agreement * 100);
	console.log(
		`Judge agreement: ${calibration.agreed}/${calibration.total} (${pct}%) → ${calibration.trustworthy ? "TRUSTED" : "NOT TRUSTED"}`,
	);
	for (const d of calibration.disagreements) {
		console.log(
			`  ✗ ${d.id}: expected ${d.expected}, judge said ${d.got} — ${d.reason}`,
		);
	}
	if (!calibration.trustworthy) {
		// Do not silently grade 16 tasks with a grader that failed its own exam.
		console.log(
			"  Judge below the agreement floor — judged tasks fall back to their deterministic check.",
		);
		judgeProvider = null;
	}
} else if (needsJudge) {
	console.log(
		`No EVAL_JUDGE_MODEL set — ${selected.filter((t) => t.rubric).length} judged task(s) fall back to their deterministic check.`,
	);
}

console.log(`\nModel:    ${model}`);
console.log(
	`Scaffold: ${profile.tier} tier · ${profile.loop} loop · ${profile.toolCalling} dispatch`,
);
console.log(`Suite:    ${suite} — ${selected.length} tasks × ${k} sample(s)\n`);

// ─── Run ───────────────────────────────────────────────────────────────────
interface Sample {
	pass: boolean;
	ms: number;
	detail: string;
	judged: boolean;
}

async function runSample(task: Task, fx: string): Promise<Sample> {
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
	if (err) return { pass: false, ms, detail: err, judged: false };

	// Deterministic check GATES: a judge never overrides a factual miss.
	if (task.check && !task.check(out, fx)) {
		return { pass: false, ms, detail: out, judged: false };
	}
	if (task.rubric && judgeProvider) {
		const v = await judgeAnswer(judgeProvider, task, out);
		return {
			pass: v.pass,
			ms,
			detail: v.pass ? out : `judge: ${v.reason}`,
			judged: !v.errored,
		};
	}
	// No judge available: a judge-only task can't be scored honestly, so it is
	// counted as a miss rather than a free pass.
	if (task.rubric && !task.check) {
		return {
			pass: false,
			ms,
			detail: "skipped — no judge available",
			judged: false,
		};
	}
	return { pass: true, ms, detail: out, judged: false };
}

const originalCwd = process.cwd();
process.chdir(fixture);
const ts = new Date().toISOString();

let passAt1 = 0;
let passAtK = 0;
const byCat: Record<string, { pass: number; total: number }> = {};
const byDiff: Record<string, { pass: number; total: number }> = {};

for (const task of selected) {
	const samples: Sample[] = [];
	for (let i = 0; i < k; i++) {
		// Each sample gets a clean fixture: an earlier edit:/multistep: task must
		// not hand the next sample a file it was supposed to create itself.
		writeFixture(fixture);
		samples.push(await runSample(task, fixture));
		persist({
			ts,
			kind: "runtime",
			fixtureVersion: FIXTURE_VERSION,
			model,
			buildModel: buildModel ?? "offline",
			judgeModel: judgeProvider ? judgeLabel : null,
			tier: profile.tier,
			loop: profile.loop,
			suite,
			task: task.id,
			category: task.category,
			difficulty: task.difficulty,
			sample: i,
			pass: samples[i].pass,
			judged: samples[i].judged,
			ms: samples[i].ms,
		});
	}

	const first = samples[0];
	const any = samples.some((s) => s.pass);
	if (first.pass) passAt1++;
	if (any) passAtK++;

	byCat[task.category] ??= { pass: 0, total: 0 };
	byCat[task.category].total++;
	if (first.pass) byCat[task.category].pass++;
	byDiff[task.difficulty] ??= { pass: 0, total: 0 };
	byDiff[task.difficulty].total++;
	if (first.pass) byDiff[task.difficulty].pass++;

	const medianMs = samples.map((s) => s.ms).sort((a, b) => a - b)[
		Math.floor(samples.length / 2)
	];
	const mark = first.pass ? "✓" : any ? "~" : "✗";
	console.log(
		`${mark} ${task.id.padEnd(28)} ${task.difficulty.padEnd(6)} ${String(Math.round(medianMs / 100) / 10).padStart(6)}s`,
	);
	if (!first.pass) {
		console.log(`    ${first.detail.replace(/\s+/g, " ").slice(0, 160)}`);
	}
}

process.chdir(originalCwd);

// ─── Report ────────────────────────────────────────────────────────────────
const line = (rec: Record<string, { pass: number; total: number }>) =>
	Object.entries(rec)
		.map(([key, s]) => `${key} ${s.pass}/${s.total}`)
		.join(" · ");

const tier = String(profile.tier);
const barFraction = TIER_BAR[tier] ?? 1;
const bar = Math.ceil(barFraction * selected.length);
const gatePass = passAt1 >= bar;

console.log(`\n${passAt1}/${selected.length} passed (pass@1)`);
if (k > 1) console.log(`${passAtK}/${selected.length} passed (pass@${k})`);
console.log(`  by category   ${line(byCat)}`);
console.log(`  by difficulty ${line(byDiff)}`);
if (calibration) {
	console.log(
		`  judge         ${judgeLabel} · agreement ${Math.round(calibration.agreement * 100)}% · ${calibration.trustworthy ? "used" : "NOT used"}`,
	);
}
console.log(
	`\nbar ${bar}/${selected.length} (${Math.round(barFraction * 100)}% for ${tier} tier) → ${gatePass ? "PASS" : "FAIL"}`,
);
console.log(`results appended → ${RESULTS_PATH}\n`);

await rm(buildRoot, { recursive: true, force: true });
await rm(fixture, { recursive: true, force: true });
process.exit(gatePass ? 0 : 1);
