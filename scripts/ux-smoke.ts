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
const model = args.find((a) => a.includes(":")) ?? "qwen2.5:3b";
let dir = args.find((a) => !a.startsWith("--") && !a.includes(":"));

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
await writeFile(
	join(work, "notes", "standup.md"),
	"# Standup\n- ship the build\n- email ops\n",
);

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
		if (typeof handler.call !== "function") cmdFailures += `${c.name}:no-call `;
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
	/ship|email|build|ops/i.test(task),
	task,
);

// 5. No reply anywhere may mention harness internals.
add(
	"no harness internals leaked to the user",
	![hi, cap, task].some((r) => INTERNALS.test(r)),
	[hi, cap, task].find((r) => INTERNALS.test(r)) ?? "",
);

await rm(work, { recursive: true, force: true });
const failed = checks.filter((c) => !c.pass);
console.log(
	`\n${checks.length - failed.length}/${checks.length} checks passed`,
);
if (failed.length) {
	console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
	process.exit(1);
}
console.log("UX smoke PASS — the harness behaves for a real user.");
