#!/usr/bin/env bun
/**
 * UX SMOKE — drive a generated harness the way a USER does.
 *
 * Every user-facing bug found so far lived in this path and none were caught:
 * slash commands crashed in the TUI, "hi" was answered with a listing of the
 * harness's own source, and "what else can u do" became a filename. The evals
 * exercise the engine loop; golden and eval-build prove harnesses compile.
 * NOTHING started a harness and behaved like a person until this.
 *
 *   bun scripts/ux-smoke.ts <harness-dir> [model]
 *   bun scripts/ux-smoke.ts --build            # build one offline, then smoke it
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
// Soak mode. A single green run on a stochastic model proves almost nothing —
// the question is whether it works RELIABLY, and an intermittent check is a
// broken check. --runs N repeats the battery and reports a pass rate per check.
const runsIdx = args.indexOf("--runs");
const RUNS = runsIdx === -1 ? 1 : Math.max(1, Number(args[runsIdx + 1] ?? 1));
const model = args.find((a) => a.includes(":")) ?? "qwen2.5:3b";
// Skip flag VALUES as well as flags: "--runs 5" was making 5 the harness dir.
let dir = args.find(
	(a, i) =>
		!a.startsWith("--") && !a.includes(":") && !args[i - 1]?.startsWith("--"),
);

if (!dir) {
	const root = await mkdtemp(join(tmpdir(), "ux-smoke-"));
	console.log("Building a harness to smoke (offline chassis)…");
	const { buildHarness } = await import("../src/builder");
	const b = await buildHarness(
		"a note taking agent that files and retrieves notes",
		root,
		undefined,
		{ characterize: false, acceptance: false },
	);
	if (!b.success) {
		console.error("build failed:", b.errors);
		process.exit(1);
	}
	dir = b.outputDir;
}
if (!existsSync(join(dir, "src/engine.ts"))) {
	console.error(`not a generated harness: ${dir}`);
	process.exit(1);
}
console.log(`Smoking ${dir}\n  model: ${model}\n`);

const { getAllTools } = await import(join(dir, "src/tools.ts"));
const { LoopEngine } = await import(join(dir, "src/engine.ts"));
const { resolveProfile } = await import(join(dir, "src/profiles.ts"));
const { COMMANDS, findCommand } = await import(join(dir, "src/commands.ts"));

const tools = await getAllTools();
const profile = resolveProfile(model, 8192);
const providerConfig = {
	type: "ollama",
	model,
	baseUrl: "http://localhost:11434",
	maxTokens: 4096,
	contextTokens: 8192,
};

// Run in a clean workspace, NOT the harness's own directory — a user runs their
// agent against their data, and grounding on its own source is a bug we shipped.
const work = await mkdtemp(join(tmpdir(), "ux-work-"));
await mkdir(join(work, "notes"), { recursive: true });
async function seedFixture(): Promise<void> {
	// Deliberately NOT scriptable: three files, only one relevant. The right answer
	// needs judgement — pick the current notes over the decoys, then rank by real
	// urgency, not list order. The urgent item is LAST, and the 2019 archive holds
	// a literal "URGENT" decoy, so keyword matching gets it wrong.
	await writeFile(
		join(work, "notes", "standup.md"),
		"# Standup - today\n- reorder the office snacks\n- update the team photo on the wiki\n- PRODUCTION IS DOWN: payment gateway returning 500s, revenue blocked\n",
	);
	await writeFile(
		join(work, "notes", "archive-2019.md"),
		"# Old notes (archived 2019)\n- migrate CI\n- URGENT: fix the login bug before launch\n",
	);
	await writeFile(
		join(work, "notes", "grocery.md"),
		"# Personal\n- milk\n- bread\n",
	);
}
await seedFixture();

interface Check {
	name: string;
	pass: boolean;
	detail: string;
}
const checks: Check[] = [];
const add = (name: string, pass: boolean, detail = "") => {
	checks.push({ name, pass, detail });
	console.log(
		`${pass ? "✓" : "✗"} ${name}${pass ? "" : `\n    ${detail.replace(/\s+/g, " ").slice(0, 160)}`}`,
	);
};

// Harness internals must never surface in a reply to the user.
const INTERNALS =
	/verify-before-done|tsconfig|vitest\.config|package\.json|src\/engine\.ts|src\/tools\.ts|DEPLOY\.md|SECURITY\.md|node_modules/i;

async function ask(goal: string): Promise<string> {
	const cwd = process.cwd();
	try {
		process.chdir(work);
		const engine = new LoopEngine({
			tools,
			providerConfig,
			profile,
			persistSession: false,
			policy: {
				mode: "default",
				rules: [
					{ pattern: "bash(*)", allow: true },
					{ pattern: "file_write(*)", allow: true },
				],
			},
		});
		return await engine.run(goal);
	} finally {
		process.chdir(cwd);
	}
}

// Soak: repeat the whole battery. A check that passes 4 times out of 5 is a
// broken check — intermittent is the failure mode users actually hit, and a
// single green run on a stochastic model cannot distinguish the two.
const tally = new Map<
	string,
	{ pass: number; total: number; lastDetail: string }
>();
for (let run = 1; run <= RUNS; run++) {
	checks.length = 0;
	// Fresh workspace every run: an artifact left by the previous run would
	// satisfy the next run's check and turn a flaky pass into a fake streak.
	await rm(work, { recursive: true, force: true });
	await mkdir(join(work, "notes"), { recursive: true });
	await seedFixture();
	if (RUNS > 1) console.log(`\n── run ${run}/${RUNS} ──`);
	// 1. Every command must dispatch — the TUI read mod.default and crashed on all of them.
	let cmdFailures = "";
	for (const c of COMMANDS as Array<{ name: string }>) {
		if (
			["exit", "clear", "calibrate", "loop", "config"].includes(
				c.name.replace("/", ""),
			)
		)
			continue;
		const found = findCommand(`/${c.name.replace("/", "")}`);
		if (!found) {
			cmdFailures += `${c.name}:not-found `;
			continue;
		}
		try {
			const mod = await found.command.load();
			const handler = (mod.default ?? mod) as { call?: unknown };
			if (typeof handler.call !== "function")
				cmdFailures += `${c.name}:no-call `;
		} catch (e) {
			cmdFailures += `${c.name}:${e instanceof Error ? e.message.slice(0, 40) : e} `;
		}
	}
	add("every slash command dispatches", !cmdFailures, cmdFailures);

	// 2. A greeting must not trigger tools or leak internals.
	const hi = await ask("hi");
	add(
		"greeting answers conversationally",
		hi.trim().length > 0 && !INTERNALS.test(hi),
		hi,
	);

	// 3. A capability question must not become a filename.
	const cap = await ask("what else can you do?");
	add(
		"capability question is not turned into a file read",
		!/\.md|\.txt|not found|does not exist|cannot proceed/i.test(cap) &&
			!INTERNALS.test(cap),
		cap,
	);

	// 4. A real task must actually act on the user's data.
	const task = await ask("Read notes/standup.md and list the action items.");
	add(
		"real task reads the user's data",
		/snack|photo|payment|production/i.test(task),
		task,
	);

	// 5. AUTONOMY: a multi-step goal — read, transform, produce an artifact — with
	// no hand-holding. This is the actual product claim. Not crashing is table
	// stakes; finishing a real job unattended is the thing being sold.
	const before = Date.now();
	const auto = await ask(
		"Look through my notes and write the single most urgent action item to urgent.txt. Only the one that matters most.",
	);
	const artifact = join(work, "urgent.txt");
	const wrote = existsSync(artifact);
	const body = wrote ? await Bun.file(artifact).text() : "";
	add(
		"autonomous JUDGEMENT: right file, right priority",
		wrote &&
			/payment|production|down|500|gateway|revenue/i.test(body) &&
			!/snack|photo|wiki|milk|bread|login bug|migrate/i.test(body),
		wrote
			? `urgent.txt = ${JSON.stringify(body.slice(0, 140))}`
			: `no urgent.txt; answer: ${auto.slice(0, 140)}`,
	);
	console.log(`    (${Math.round((Date.now() - before) / 1000)}s)`);

	// 6. No reply anywhere may mention harness internals.
	add(
		"no harness internals leaked to the user",
		![hi, cap, task].some((r) => INTERNALS.test(r)),
		[hi, cap, task].find((r) => INTERNALS.test(r)) ?? "",
	);

	for (const c of checks) {
		const t = tally.get(c.name) ?? { pass: 0, total: 0, lastDetail: "" };
		t.total++;
		if (c.pass) t.pass++;
		else t.lastDetail = c.detail;
		tally.set(c.name, t);
	}
}

if (RUNS > 1) {
	console.log("\n── reliability ──");
	for (const [name, t] of tally) {
		const rate = Math.round((t.pass / t.total) * 100);
		const mark = t.pass === t.total ? "✓" : t.pass === 0 ? "✗" : "~";
		console.log(
			`${mark} ${String(t.pass).padStart(2)}/${t.total}  ${String(rate).padStart(3)}%  ${name}`,
		);
		if (t.pass > 0 && t.pass < t.total) {
			console.log(
				`      INTERMITTENT — last failure: ${t.lastDetail.replace(/\s+/g, " ").slice(0, 120)}`,
			);
		}
	}
}
await rm(work, { recursive: true, force: true });
// Any check that is not 100% across every run fails the suite. Intermittent
// is not "mostly working"; it is the exact experience a user reports as flaky.
const failed = [...tally.entries()]
	.filter(([, t]) => t.pass < t.total)
	.map(([name, t]) => ({ name, pass: false, detail: t.lastDetail }));
console.log(
	`\n${tally.size - failed.length}/${tally.size} checks passed${RUNS > 1 ? ` across ${RUNS} runs` : ""}`,
);
if (failed.length) {
	console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
	process.exit(1);
}
console.log("UX smoke PASS — the harness behaves for a real user.");
