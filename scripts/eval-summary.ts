#!/usr/bin/env bun
/**
 * harnage EVAL SUMMARY — closes the flywheel.
 *
 *   bun scripts/eval-summary.ts
 *
 * eval.ts accumulates raw per-task results in ~/.harnage/eval-results.jsonl
 * (the moat dataset). This turns that raw record into actionable per-model
 * insight: overall pass rate, per-category and per-task pass rates, the tasks
 * a model CONSISTENTLY fails (where per-model config tuning would pay off), and
 * median latency — grouped by model and by the config (tier/loop) it ran under.
 *
 * The loop it closes: eval measures → this surfaces which model+config wins and
 * where each model is weak → you bake those wins into catalogOverrides
 * (src/builder/models/catalog.ts) so every future harness on that model is
 * tuned by measured fact. Tuning stays HUMAN-gated on purpose — a 3B model's
 * run-to-run noise should never silently auto-mutate the shipped catalog.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Row {
	ts: string;
	model: string;
	buildModel: string;
	tier: string;
	loop: string;
	task: string;
	category: string;
	pass: boolean;
	ms: number;
}

const PATH = join(homedir(), ".harnage", "eval-results.jsonl");
if (!existsSync(PATH)) {
	console.error(
		`No eval data at ${PATH}. Run \`bun scripts/eval.ts <model>\` first.`,
	);
	process.exit(1);
}

const rows: Row[] = readFileSync(PATH, "utf-8")
	.split("\n")
	.filter(Boolean)
	.map((l) => {
		try {
			return JSON.parse(l) as Row;
		} catch {
			return null;
		}
	})
	.filter((r): r is Row => r !== null);

if (rows.length === 0) {
	console.error("eval-results.jsonl has no valid rows.");
	process.exit(1);
}

const pct = (n: number, d: number) => (d === 0 ? "  -" : `${Math.round((100 * n) / d)}%`.padStart(4));
const median = (xs: number[]) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

// group by model
const byModel = new Map<string, Row[]>();
for (const r of rows) {
	if (!byModel.has(r.model)) byModel.set(r.model, []);
	byModel.get(r.model)?.push(r);
}

console.log(`harnage eval summary — ${rows.length} task-runs across ${byModel.size} model(s)\n`);

for (const [model, mrows] of [...byModel.entries()].sort()) {
	const sessions = new Set(mrows.map((r) => r.ts)).size;
	const passed = mrows.filter((r) => r.pass).length;
	const config = `${mrows[0].tier} tier · ${mrows[0].loop} loop`;
	console.log(`\x1b[1m${model}\x1b[0m  (${config})`);
	console.log(
		`  overall: ${pct(passed, mrows.length)} (${passed}/${mrows.length} task-runs · ${sessions} session${sessions === 1 ? "" : "s"})`,
	);

	// per-category
	const cats = [...new Set(mrows.map((r) => r.category))].sort();
	const catLine = cats
		.map((c) => {
			const cr = mrows.filter((r) => r.category === c);
			return `${c} ${pct(cr.filter((r) => r.pass).length, cr.length).trim()}`;
		})
		.join(" · ");
	console.log(`  by category: ${catLine}`);

	// per-task — surface the ones a model consistently fails (tuning targets)
	const tasks = [...new Set(mrows.map((r) => r.task))].sort();
	const weak: string[] = [];
	for (const t of tasks) {
		const tr = mrows.filter((r) => r.task === t);
		const p = tr.filter((r) => r.pass).length;
		if (p / tr.length < 0.5) weak.push(`${t} (${p}/${tr.length})`);
	}
	if (weak.length) {
		console.log(`  \x1b[33mweak tasks (tune here):\x1b[0m ${weak.join(", ")}`);
	} else {
		console.log("  \x1b[32mno consistently-failing task\x1b[0m");
	}
	console.log(`  median latency: ${(median(mrows.map((r) => r.ms)) / 1000).toFixed(1)}s\n`);
}

console.log(
	"To close the loop: bake a weak model's winning config into its catalog\n" +
		"entry's profileOverrides (src/builder/models/catalog.ts), then re-run\n" +
		"eval to confirm the pass rate moved. Tuning is human-gated by design.",
);
