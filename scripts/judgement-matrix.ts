#!/usr/bin/env bun
/**
 * JUDGEMENT MATRIX — where does ranking ability actually start?
 *
 *   bun scripts/judgement-matrix.ts <harness-dir> [model ...]
 *
 * qwen2.5:3b fails the ux-smoke judgement check 0/3 even with the procedure in
 * its prompt; llama3:8b passes the same fixture unaided. That is a capability
 * boundary, and "small models can't rank" is a guess until it is a measured
 * threshold. This finds the threshold so the model catalog can warn honestly
 * when someone picks a model below it for a judgement-heavy domain.
 *
 * The fixture is deliberately adversarial: three files, only one relevant, the
 * urgent item LAST so list order is wrong, and an "URGENT:" decoy in a 2019
 * archive so keyword matching is wrong.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
const models = process.argv.slice(3);
if (!dir || !models.length) {
	console.error(
		"usage: bun scripts/judgement-matrix.ts <harness-dir> <model> [model ...]",
	);
	process.exit(1);
}

const { getAllTools } = await import(join(dir, "src/tools.ts"));
const { LoopEngine } = await import(join(dir, "src/engine.ts"));
const { resolveProfile } = await import(join(dir, "src/profiles.ts"));
const tools = await getAllTools();

async function seed(w: string): Promise<void> {
	await mkdir(join(w, "notes"), { recursive: true });
	await writeFile(
		join(w, "notes", "standup.md"),
		"# Standup - today\n- reorder the office snacks\n- update the team photo on the wiki\n- PRODUCTION IS DOWN: payment gateway returning 500s, revenue blocked\n",
	);
	await writeFile(
		join(w, "notes", "archive-2019.md"),
		"# Old notes (archived 2019)\n- migrate CI\n- URGENT: fix the login bug before launch\n",
	);
	await writeFile(
		join(w, "notes", "grocery.md"),
		"# Personal\n- milk\n- bread\n",
	);
}

console.log(
	`${"model".padEnd(22)}${"tier".padEnd(10)}${"verdict".padEnd(10)}wrote`,
);
console.log("─".repeat(90));

for (const model of models) {
	const w = await mkdtemp(join(tmpdir(), "jm-"));
	await seed(w);
	const cwd = process.cwd();
	let body = "";
	let err = "";
	const profile = resolveProfile(model, 8192);
	try {
		process.chdir(w);
		const engine = new LoopEngine({
			tools,
			profile,
			persistSession: false,
			providerConfig: {
				type: "ollama",
				model,
				baseUrl: "http://localhost:11434",
				maxTokens: 4096,
				contextTokens: 8192,
			},
			policy: {
				mode: "default",
				rules: [
					{ pattern: "bash(*)", allow: true },
					{ pattern: "file_write(*)", allow: true },
				],
			},
		});
		await engine.run(
			"Look through my notes and write the single most urgent action item to urgent.txt. Only the one that matters most.",
		);
		body = await Bun.file(join(w, "urgent.txt"))
			.text()
			.catch(() => "");
	} catch (e) {
		err = e instanceof Error ? e.message : String(e);
	} finally {
		process.chdir(cwd);
	}

	const right = /payment|production|down|500|gateway|revenue/i.test(body);
	const wrong = /snack|photo|wiki|milk|bread|login bug|migrate/i.test(body);
	const verdict = err ? "ERROR" : right && !wrong ? "PASS" : "FAIL";
	console.log(
		`${model.padEnd(22)}${String(profile.tier).padEnd(10)}${verdict.padEnd(10)}${JSON.stringify((err || body).slice(0, 60))}`,
	);
	await rm(w, { recursive: true, force: true });
}
console.log(
	"\nPASS = ranked the outage above the decoys. The lowest passing tier is the\nthreshold recommendModels should warn below for judgement-heavy domains.\n",
);
