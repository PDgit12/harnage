#!/usr/bin/env bun
/**
 * North-star #3: benchmark a generated harness against the incumbent-free
 * baseline — raw Ollama chat with no tools, no filesystem, no memory, no
 * session persistence. This is the thesis test: harnage's bet is that a
 * *harness* (tools + memory + session contract) makes even a small local
 * model do things a bare chat call structurally cannot.
 *
 *   bun scripts/bench-harness.ts --dry-run
 *   bun scripts/bench-harness.ts <model> [ollamaBaseUrl]
 *   bun scripts/bench-harness.ts qwen2.5:3b
 *
 * OFFLINE ONLY: local Ollama, no API keys, no network egress beyond
 * localhost. This EXECUTES the local model — run the non-dry-run form
 * yourself; the dry-run is the reproducible proof the battery is sound.
 *
 * See docs/benchmarks.md for methodology and how to read the report.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildHarness } from "../src/builder";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const model = positional[0];
const baseUrl = positional[1] ?? "http://localhost:11434";

if (!dryRun && !model) {
	console.error(
		"usage: bun scripts/bench-harness.ts <model> [ollamaBaseUrl]\n" +
			"       bun scripts/bench-harness.ts --dry-run",
	);
	process.exit(1);
}

type Mode = "harness" | "control";

interface TaskOutcome {
	pass: boolean;
	secs: number;
	detail: string;
}

interface Task {
	id: string;
	category: string;
	summary: string;
}

const TASKS: Task[] = [
	{ id: "T1", category: "File ops", summary: "Create hello.txt containing exactly HELLO in the fixture dir." },
	{ id: "T2", category: "Search", summary: "Read a.ts and report what it exports (greet)." },
	{ id: "T3", category: "Multi-step goal", summary: "Find the largest .ts file among 3 files and show its first lines." },
	{ id: "T4", category: "Memory recall", summary: "Seed a fact in one session, recall it correctly in a fresh session." },
	{ id: "T5", category: "Resume-after-kill", summary: "Crash mid-task; verify session state on disk is resumable." },
];

if (dryRun) {
	console.log("\nbench-harness — dry run (no model executed)\n");
	console.log("Battery: harness (generated, local Ollama) vs control (raw Ollama chat, no tools)\n");
	for (const t of TASKS) {
		console.log(`  ${t.id}  ${t.category.padEnd(18)} ${t.summary}`);
	}
	console.log("\nValidating offline build pipeline (no model needed for chassis generation)...");
	const buildRoot = await mkdtemp(join(tmpdir(), "bench-harness-dry-"));
	try {
		const build = await buildHarness("a codebase analysis and file agent that inspects and edits a project", buildRoot);
		if (!build.success) {
			console.error("build failed:", build.errors);
			process.exit(1);
		}
		const gen = build.outputDir;
		for (const f of ["src/tools.ts", "src/engine.ts", "src/profiles.ts", "src/memory.ts", "src/session.ts"]) {
			if (!existsSync(join(gen, f))) {
				console.error(`missing generated file: ${f}`);
				process.exit(1);
			}
		}
		console.log(`✓ generated harness at ${gen} has tools.ts, engine.ts, profiles.ts, memory.ts, session.ts`);
	} finally {
		await rm(buildRoot, { recursive: true, force: true });
	}
	console.log(`\n${TASKS.length} tasks × 2 modes (harness, control) = ${TASKS.length * 2} runs when executed for real.`);
	console.log("Plan OK — exit 0.\n");
	process.exit(0);
}

// ---- real run below ----

function writeFixture(dir: string): void {
	writeFileSync(join(dir, "a.ts"), "export function greet(): string {\n  return 'hi';\n}\n");
	writeFileSync(join(dir, "b.js"), "module.exports = { ok: true };\n");
	const big =
		"// LARGEST\n" +
		Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join("\n") +
		"\n";
	writeFileSync(join(dir, "big.ts"), big);
}

async function rawChat(prompt: string): Promise<string> {
	const res = await fetch(`${baseUrl}/api/chat`, {
		method: "POST",
		signal: AbortSignal.timeout(120_000),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: prompt }],
			stream: false,
		}),
	});
	if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text().catch(() => "")}`);
	const json = (await res.json()) as { message?: { content?: string } };
	return json.message?.content ?? "";
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result?: T; err?: string; secs: number }> {
	const started = performance.now();
	try {
		const result = await fn();
		return { result, secs: Math.round((performance.now() - started) / 100) / 10 };
	} catch (e) {
		return { err: e instanceof Error ? e.message : String(e), secs: Math.round((performance.now() - started) / 100) / 10 };
	}
}

console.log(`\nBuilding a generated harness (offline chassis)...`);
const buildRoot = await mkdtemp(join(tmpdir(), "bench-harness-build-"));
const build = await buildHarness("a codebase analysis and file agent that inspects and edits a project", buildRoot);
if (!build.success) {
	console.error("build failed:", build.errors);
	process.exit(1);
}
const gen = build.outputDir;
const planName = basename(gen).replace(/^\.harnage-build-/, "");
const homeDir = join(homedir(), `.${planName}`);
// Fresh state: earlier runs of this same bench under this plan name would
// otherwise leak session/memory across runs and corrupt T4/T5.
rmSync(homeDir, { recursive: true, force: true });

const { getAllTools } = (await import(join(gen, "src/tools.ts"))) as {
	getAllTools: () => Promise<Array<{ name: string }>>;
};
const { LoopEngine } = (await import(join(gen, "src/engine.ts"))) as {
	LoopEngine: new (cfg: Record<string, unknown>) => { run(goal: string): Promise<string> };
};
const { resolveProfile } = (await import(join(gen, "src/profiles.ts"))) as {
	resolveProfile: (m: string, ctx?: number) => Record<string, unknown>;
};
const { MemoryStore } = (await import(join(gen, "src/memory.ts"))) as {
	MemoryStore: new () => { saveFact(subject: string, fact: string): void };
};
const { saveSession, loadSession } = (await import(join(gen, "src/session.ts"))) as {
	saveSession: (messages: Array<Record<string, unknown>>, meta?: { goal?: string; done?: boolean }) => Promise<void>;
	loadSession: () => { messages: unknown[]; goal?: string; done?: boolean } | null;
};

const allTools = await getAllTools();
const profile = resolveProfile(model!, 8192);
const providerConfig = { type: "ollama", model, baseUrl, maxTokens: 4096, contextTokens: 8192 };
const policy = {
	mode: "default" as const,
	rules: [
		{ pattern: "bash(*)", allow: true },
		{ pattern: "file_write(*)", allow: true },
		{ pattern: "file_edit(*)", allow: true },
	],
};

function newEngine(persistSession = true) {
	return new LoopEngine({ tools: allTools, providerConfig, profile, policy, persistSession });
}

async function runT1(mode: Mode, fixture: string): Promise<TaskOutcome> {
	const goal = "Create a file named hello.txt containing exactly the text HELLO in the current directory.";
	process.chdir(fixture);
	if (mode === "harness") {
		const { secs, err } = await timed(() => newEngine(false).run(goal));
		const ok = !err && existsSync(join(fixture, "hello.txt")) && /HELLO/.test(readFileSync(join(fixture, "hello.txt"), "utf-8"));
		return { pass: ok, secs, detail: err ?? (ok ? "file written" : "file missing/wrong content") };
	}
	const { secs, err } = await timed(() => rawChat(goal));
	const ok = !err && existsSync(join(fixture, "hello.txt"));
	return { pass: ok, secs, detail: err ?? "raw chat has no filesystem tool — cannot write a real file" };
}

async function runT2(mode: Mode, fixture: string): Promise<TaskOutcome> {
	const goal = "What does the file a.ts export? Read it and answer.";
	process.chdir(fixture);
	if (mode === "harness") {
		const { result, secs, err } = await timed(() => newEngine(false).run(goal));
		const ok = !err && /greet/i.test(result ?? "");
		return { pass: ok, secs, detail: err ?? (result ?? "").slice(0, 120) };
	}
	const { result, secs, err } = await timed(() => rawChat(goal));
	const ok = !err && /greet/i.test(result ?? "");
	return { pass: ok, secs, detail: err ?? "raw chat cannot read the real a.ts — any match is a coincidence" };
}

async function runT3(mode: Mode, fixture: string): Promise<TaskOutcome> {
	const goal = "Find the largest .ts file in the current directory and show its first few lines.";
	process.chdir(fixture);
	if (mode === "harness") {
		const { result, secs, err } = await timed(() => newEngine(false).run(goal));
		const ok = !err && (/LARGEST/.test(result ?? "") || /big\.ts/.test(result ?? ""));
		return { pass: ok, secs, detail: err ?? (result ?? "").slice(0, 120) };
	}
	const { result, secs, err } = await timed(() => rawChat(goal));
	const ok = !err && (/LARGEST/.test(result ?? "") || /big\.ts/.test(result ?? ""));
	return { pass: ok, secs, detail: err ?? "raw chat cannot list the real directory" };
}

async function runT4(mode: Mode): Promise<TaskOutcome> {
	const subject = "deploy-target";
	const fact = "The user's preferred deploy target is Fly.io.";
	const question = "What is the user's preferred deploy target? Answer in one short sentence.";
	if (mode === "harness") {
		new MemoryStore().saveFact(subject, fact);
		const { result, secs, err } = await timed(() => newEngine(true).run(question));
		const ok = !err && /fly\.?io/i.test(result ?? "");
		return { pass: ok, secs, detail: err ?? (result ?? "").slice(0, 120) };
	}
	// Control: two independent stateless chat calls — nothing persists a fact
	// between them, so this can only pass by the model guessing correctly.
	const { secs: s1, err: e1 } = await timed(() => rawChat(`Remember this: ${fact}`));
	const { result, secs: s2, err: e2 } = await timed(() => rawChat(question));
	const ok = !e1 && !e2 && /fly\.?io/i.test(result ?? "");
	return { pass: ok, secs: Math.round((s1 + s2) * 10) / 10, detail: e2 ?? "raw chat is stateless — no memory tier to recall from" };
}

async function runT5(mode: Mode, fixture: string): Promise<TaskOutcome> {
	if (mode === "harness") {
		process.chdir(fixture);
		const goal = "Say hello.";
		const { secs, err } = await timed(() => newEngine(true).run(goal));
		if (err) return { pass: false, secs, detail: err };
		const completed = loadSession();
		if (!completed || completed.done !== true) {
			return { pass: false, secs, detail: "session not marked done after a clean run" };
		}
		// Simulate a crash mid-task: a real kill leaves the last mid-loop save on
		// disk with done:false. Write that state directly and confirm it's readable.
		await saveSession([{ role: "user", content: goal }, { role: "assistant", content: "(interrupted)" }], {
			goal: "an unfinished multi-step goal",
			done: false,
		});
		const crashed = loadSession();
		const ok = !!crashed && crashed.done === false && crashed.goal === "an unfinished multi-step goal" && Array.isArray(crashed.messages) && crashed.messages.length === 2;
		return { pass: ok, secs, detail: ok ? "crash state persisted and reloadable" : "crash state not recoverable from disk" };
	}
	// Control: raw chat has no session file at all — there is nothing to resume.
	const sessionPath = join(homeDir, "session.json");
	const existedBefore = existsSync(sessionPath);
	const { secs, err } = await timed(() => rawChat("Say hello."));
	const ok = !err && !existedBefore && existsSync(sessionPath);
	return { pass: ok, secs, detail: "raw chat writes no session state — a killed process loses the entire turn" };
}

console.log(`Model:    ${model}`);
console.log(`Baseline: raw Ollama chat (no tools, no memory, no session persistence)`);
console.log(`Scaffold: ${profile.tier} tier · ${profile.loop} loop\n`);

const rows: Array<{ task: Task; harness: TaskOutcome; control: TaskOutcome }> = [];

for (const task of TASKS) {
	const fixture = await mkdtemp(join(tmpdir(), `bench-harness-fx-${task.id}-`));
	writeFixture(fixture);
	let harness: TaskOutcome;
	let control: TaskOutcome;
	switch (task.id) {
		case "T1":
			harness = await runT1("harness", fixture);
			control = await runT1("control", fixture);
			break;
		case "T2":
			harness = await runT2("harness", fixture);
			control = await runT2("control", fixture);
			break;
		case "T3":
			harness = await runT3("harness", fixture);
			control = await runT3("control", fixture);
			break;
		case "T4":
			harness = await runT4("harness");
			control = await runT4("control");
			break;
		default:
			harness = await runT5("harness", fixture);
			control = await runT5("control", fixture);
	}
	rows.push({ task, harness, control });
	console.log(
		`${harness.pass ? "✓" : "✗"} ${task.id} ${task.category.padEnd(18)} harness ${String(harness.secs).padStart(5)}s   ` +
			`${control.pass ? "✓" : "✗"} control ${String(control.secs).padStart(5)}s`,
	);
	await rm(fixture, { recursive: true, force: true });
}

const harnessPassed = rows.filter((r) => r.harness.pass).length;
const controlPassed = rows.filter((r) => r.control.pass).length;

const lines: string[] = [];
lines.push(`# Harness benchmark — ${model}`);
lines.push("");
lines.push(`Run: ${new Date().toISOString()}`);
lines.push(`Ollama: ${baseUrl}`);
lines.push(`Scaffold: ${profile.tier} tier · ${profile.loop} loop · ${profile.toolCalling} dispatch`);
lines.push("");
lines.push("| Task | Category | Harness | Control | Verdict |");
lines.push("|---|---|---|---|---|");
for (const r of rows) {
	const h = `${r.harness.pass ? "✓" : "✗"} ${r.harness.secs}s`;
	const c = `${r.control.pass ? "✓" : "✗"} ${r.control.secs}s`;
	const verdict = r.harness.pass && !r.control.pass ? "harness wins" : r.harness.pass && r.control.pass ? "both pass" : !r.harness.pass && !r.control.pass ? "both fail" : "control wins (investigate)";
	lines.push(`| ${r.task.id} | ${r.task.category} | ${h} | ${c} | ${verdict} |`);
}
lines.push("");
lines.push(`**Harness: ${harnessPassed}/${TASKS.length} · Control: ${controlPassed}/${TASKS.length}**`);
lines.push("");
lines.push("Detail:");
for (const r of rows) {
	lines.push(`- ${r.task.id} harness: ${r.harness.detail}`);
	lines.push(`- ${r.task.id} control: ${r.control.detail}`);
}

const reportDir = join(process.cwd(), ".bench-reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, `bench-harness-${model!.replace(/[:/]/g, "_")}-${Date.now()}.md`);
writeFileSync(reportPath, lines.join("\n") + "\n");

console.log(`\n${harnessPassed}/${TASKS.length} harness · ${controlPassed}/${TASKS.length} control`);
console.log(`Report: ${reportPath}\n`);

rmSync(homeDir, { recursive: true, force: true });
await rm(buildRoot, { recursive: true, force: true });
process.exit(0);
