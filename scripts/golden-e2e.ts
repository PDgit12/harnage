#!/usr/bin/env bun
/**
 * Golden E2E: prove the CLI generates a REAL, standalone-compiling harness for
 * every archetype prompt — not just the file-agent demo.
 *
 *   bun scripts/golden-e2e.ts
 *
 * For each prompt it builds the harness (offline deterministic chassis), then
 * ACTUALLY compiles the generated output with its own tsc — no mocks, no
 * trusting the builder's internal verify. Also asserts the full subsystem set
 * is present. Model-free, so this gates in CI. Exits nonzero on any failure.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";

// One representative prompt per beachhead-relevant archetype.
const ARCHETYPES: Array<{ id: string; prompt: string }> = [
	{
		id: "code-agent",
		prompt:
			"a codebase analysis agent that inspects and edits a TypeScript project",
	},
	{
		id: "data-agent",
		prompt:
			"a data cleaning agent that reads CSV files, dedupes rows, and writes a summary report",
	},
	{
		id: "docs-agent",
		prompt:
			"a documentation agent that reads markdown files and answers questions about a project",
	},
	{
		id: "review-agent",
		prompt:
			"a code review agent that reads a git diff, runs the tests, and reports findings",
	},
];

// Every generated harness must ship these — a missing one is a broken deliverable.
const REQUIRED_FILES = [
	"package.json",
	"tsconfig.json",
	"src/main.tsx",
	"src/engine.ts",
	"src/profiles.ts",
	"src/tools.ts",
	"src/permissions.ts",
];

interface Row {
	id: string;
	built: boolean;
	files: boolean;
	compiles: boolean;
	detail: string;
}

const rows: Row[] = [];

for (const { id, prompt } of ARCHETYPES) {
	const root = await mkdtemp(join(tmpdir(), `golden-${id}-`));
	const row: Row = { id, built: false, files: false, compiles: false, detail: "" };
	try {
		const build = await buildHarness(prompt, root, undefined, undefined);
		row.built = build.success;
		if (!build.success) {
			row.detail = build.errors.join("; ").slice(0, 120);
			rows.push(row);
			continue;
		}
		const out = build.outputDir;
		const missing = REQUIRED_FILES.filter((f) => !existsSync(join(out, f)));
		row.files = missing.length === 0;
		if (missing.length) row.detail = `missing: ${missing.join(", ")}`;

		// Real compile: install deps, then the generated harness's OWN tsc.
		const install = Bun.spawnSync(["bun", "install"], { cwd: out, stdout: "pipe", stderr: "pipe" });
		if (install.exitCode !== 0) {
			row.detail = `bun install failed: ${install.stderr.toString().slice(0, 120)}`;
			rows.push(row);
			continue;
		}
		const tsc = Bun.spawnSync(["bunx", "tsc", "--noEmit"], { cwd: out, stdout: "pipe", stderr: "pipe" });
		row.compiles = tsc.exitCode === 0;
		if (!row.compiles) {
			const err = (tsc.stdout.toString() + tsc.stderr.toString()).trim();
			row.detail = err.split("\n").slice(0, 2).join(" ").slice(0, 160);
		}
	} catch (e) {
		row.detail = e instanceof Error ? e.message.slice(0, 120) : String(e);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	rows.push(row);
}

console.log("\nGolden E2E — every archetype must build, ship all files, and compile:\n");
console.log("  archetype        build  files  compile  detail");
console.log("  " + "-".repeat(70));
let allPass = true;
for (const r of rows) {
	const ok = r.built && r.files && r.compiles;
	allPass &&= ok;
	const m = (b: boolean) => (b ? "  ✓  " : "  ✗  ");
	console.log(
		`  ${r.id.padEnd(15)}${m(r.built)}${m(r.files)}${m(r.compiles).padEnd(8)} ${ok ? "" : r.detail}`,
	);
}
console.log(`\n${allPass ? "PASS" : "FAIL"} — ${rows.filter((r) => r.built && r.files && r.compiles).length}/${rows.length} archetypes production-ready\n`);
process.exit(allPass ? 0 : 1);
