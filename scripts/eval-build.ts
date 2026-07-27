#!/usr/bin/env bun
/**
 * harnage BUILD-EVAL — does the builder actually produce a harness that compiles?
 *
 *   bun scripts/eval-build.ts --dry-run              # validate the prompt set, no model
 *   bun scripts/eval-build.ts                        # offline chassis (no build brain)
 *   EVAL_BUILD_MODEL=llama-3.3-70b bun scripts/eval-build.ts
 *   bun scripts/eval-build.ts --only n8n             # one prompt
 *
 * WHY THIS EXISTS: scripts/eval.ts measures the RUNTIME loop using the BAKED
 * tools. It builds one harness from one fixed prompt and never inspects the
 * generated source. Every defect in the v0.5.0 n8n report lived in the part
 * that eval did not cover — LLM-generated custom commands importing a package
 * that doesn't exist, and a tool registry importing a module that was never
 * written. Both compile-fail instantly and both were invisible to a green eval.
 *
 * Each prompt is scored on four assertions, in order of how loudly they fail:
 *   1. build.success           — the builder didn't give up
 *   2. tsc --noEmit is clean   — the deliverable actually compiles
 *   3. no undeclared imports   — nothing imports a package the fixed
 *                                package.json doesn't ship (the node:fetch bug)
 *   4. registry resolves       — every toolModules entry in src/tools.ts points
 *                                at a file on disk (the tools.ts bug)
 *
 * Assertions 3 and 4 are checked directly against the generated source rather
 * than inferred from tsc, so they still report precisely when tsc fails for an
 * unrelated reason.
 */
import { execSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";
import { disallowedImports } from "../src/builder/llm/generate";

interface BuildPrompt {
	id: string;
	prompt: string;
}

/** Domain-varied on purpose: a builder that only works for "code agent" prompts
 *  is not a builder. The n8n entry is the verbatim reproducer for the v0.5.0
 *  report — it must stay first-class, not a footnote. */
const PROMPTS: BuildPrompt[] = [
	{
		id: "n8n",
		prompt:
			"an n8n automation builder that takes a description of a workflow, generates the workflow JSON, connects to my n8n instance and imports it",
	},
	{
		id: "pr-review",
		prompt:
			"a CLI agent that reviews pull requests, summarizes the diff and flags risky changes",
	},
	{
		id: "changelog",
		prompt:
			"a changelog drafter that reads git history and writes release notes grouped by type",
	},
	{
		id: "gtm-research",
		prompt:
			"a GTM research agent that looks up companies, enriches them and writes an outreach brief",
	},
	{
		id: "data-analysis",
		prompt:
			"a data analysis agent that reads CSV files, computes summary statistics and answers questions about them",
	},
	{
		id: "docs-qa",
		prompt:
			"a documentation question-answering agent that searches markdown docs and cites the file it answered from",
	},
	{
		id: "incident",
		prompt:
			"an incident response assistant that reads log files, finds the first error and drafts a postmortem",
	},
	{
		id: "notes",
		prompt:
			"a personal note-taking agent that stores notes, tags them and retrieves them later",
	},
	{
		id: "repo-explorer",
		prompt:
			"a codebase explorer that maps a repository's structure and explains how a feature works",
	},
	{
		id: "invoice",
		prompt:
			"an invoice processing agent that reads invoice files, extracts totals and flags mismatches",
	},
];

interface Assertion {
	name: string;
	pass: boolean;
	detail?: string;
}

/** Every .ts/.tsx file under a directory, relative to it. */
async function walkSource(root: string, rel = ""): Promise<string[]> {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(join(root, rel), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name === "node_modules" || e.name.startsWith(".")) continue;
		const next = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...(await walkSource(root, next)));
		else if (/\.tsx?$/.test(e.name)) out.push(next);
	}
	return out;
}

function declaredDeps(outputDir: string): string[] {
	try {
		const pkg = JSON.parse(
			readFileSync(join(outputDir, "package.json"), "utf-8"),
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		return [
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		];
	} catch {
		return [];
	}
}

async function assertNoUndeclaredImports(
	outputDir: string,
): Promise<Assertion> {
	const declared = declaredDeps(outputDir);
	const srcDir = join(outputDir, "src");
	const offenders: string[] = [];
	for (const rel of await walkSource(srcDir)) {
		const code = readFileSync(join(srcDir, rel), "utf-8");
		const bad = disallowedImports(code, declared);
		if (bad.length) offenders.push(`src/${rel}: ${bad.join(", ")}`);
	}
	return {
		name: "no undeclared imports",
		pass: offenders.length === 0,
		detail: offenders.slice(0, 5).join(" | "),
	};
}

function assertRegistryResolves(outputDir: string): Assertion {
	const registryPath = join(outputDir, "src", "tools.ts");
	if (!existsSync(registryPath)) {
		return {
			name: "tool registry resolves",
			pass: false,
			detail: "src/tools.ts missing",
		};
	}
	const src = readFileSync(registryPath, "utf-8");
	const missing: string[] = [];
	let count = 0;
	for (const m of src.matchAll(/import\("\.\/([^"]+)"\)/g)) {
		count++;
		if (!existsSync(join(outputDir, "src", m[1]))) missing.push(m[1]);
	}
	return {
		name: "tool registry resolves",
		pass: missing.length === 0 && count > 0,
		detail: missing.length
			? `missing: ${missing.join(", ")}`
			: count === 0
				? "registry has no tool entries"
				: `${count} modules`,
	};
}

function assertTypechecks(outputDir: string): Assertion {
	try {
		execSync("bunx tsc --noEmit", {
			cwd: outputDir,
			stdio: "pipe",
			timeout: 120_000,
			encoding: "utf-8",
		});
		return { name: "tsc --noEmit clean", pass: true };
	} catch (e: unknown) {
		const err = e as {
			stdout?: { toString(): string };
			stderr?: { toString(): string };
		};
		const detail = [err.stdout?.toString(), err.stderr?.toString()]
			.filter((s): s is string => Boolean(s?.trim()))
			.join("\n")
			.split("\n")
			.filter((l) => l.includes("error TS"))
			.slice(0, 5)
			.join(" | ");
		return { name: "tsc --noEmit clean", pass: false, detail };
	}
}

const RESULTS_PATH = join(homedir(), ".harnage", "eval-results.jsonl");
function persist(row: Record<string, unknown>): void {
	try {
		mkdirSync(join(homedir(), ".harnage"), { recursive: true });
		appendFileSync(RESULTS_PATH, `${JSON.stringify(row)}\n`);
	} catch {
		/* best-effort */
	}
}

// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx === -1 ? undefined : args[onlyIdx + 1];
const baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

const selected = only ? PROMPTS.filter((p) => p.id === only) : PROMPTS;

if (only && selected.length === 0) {
	console.error(
		`unknown prompt "${only}" — pick one of: ${PROMPTS.map((p) => p.id).join(", ")}`,
	);
	process.exit(1);
}

if (dryRun) {
	console.log("harnage build-eval — dry run (prompt set validation)\n");
	console.log(`Prompts: ${PROMPTS.length}`);
	for (const p of PROMPTS)
		console.log(`  ${p.id.padEnd(14)} ${p.prompt.slice(0, 70)}…`);
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const p of PROMPTS) {
		if (ids.has(p.id)) problems.push(`duplicate id: ${p.id}`);
		ids.add(p.id);
		if (p.prompt.trim().length < 30)
			problems.push(`${p.id}: prompt too thin to plan from`);
	}
	if (!PROMPTS.some((p) => p.id === "n8n")) {
		// This is the reproducer for the v0.5.0 report; losing it would quietly
		// remove the only regression coverage for that build.
		problems.push("the n8n reproducer prompt is missing");
	}
	if (problems.length) {
		console.error(`\nPROMPT SET BROKEN:\n  ${problems.join("\n  ")}`);
		process.exit(1);
	}
	console.log(
		"\nAssertions per build: build.success · tsc --noEmit clean · no undeclared imports · tool registry resolves",
	);
	console.log(
		"Prompt set sound. Run `bun scripts/eval-build.ts` to score the builder.",
	);
	process.exit(0);
}

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
		maxRepairs: 2,
		// This script asserts the build COMPILES across 10 prompts; executing an
		// acceptance battery per prompt would multiply its runtime for a signal
		// scripts/eval.ts already covers.
		acceptance: false,
	};
	console.log(`Build brain: ${buildModel}`);
} else {
	console.log("Build brain: none (offline chassis)");
}
console.log(`Prompts:     ${selected.length}\n`);

const ts = new Date().toISOString();
let fullyGreen = 0;
const failures: string[] = [];

for (const p of selected) {
	const root = await mkdtemp(join(tmpdir(), `build-eval-${p.id}-`));
	const started = performance.now();
	const assertions: Assertion[] = [];
	let outputDir = "";

	try {
		const build = await buildHarness(p.prompt, root, undefined, buildProvider);
		outputDir = build.outputDir;
		assertions.push({
			name: "build.success",
			pass: build.success,
			detail: build.errors.join(" | ").slice(0, 200),
		});
		if (existsSync(outputDir)) {
			assertions.push(assertTypechecks(outputDir));
			assertions.push(await assertNoUndeclaredImports(outputDir));
			assertions.push(assertRegistryResolves(outputDir));
		}
	} catch (e) {
		assertions.push({
			name: "build.success",
			pass: false,
			detail: e instanceof Error ? e.message : String(e),
		});
	}

	const ms = Math.round(performance.now() - started);
	const green = assertions.length > 0 && assertions.every((a) => a.pass);
	if (green) fullyGreen++;

	console.log(
		`${green ? "✓" : "✗"} ${p.id.padEnd(14)} ${String(Math.round(ms / 100) / 10).padStart(6)}s  ${assertions.filter((a) => a.pass).length}/${assertions.length} assertions`,
	);
	for (const a of assertions.filter((x) => !x.pass)) {
		console.log(
			`    ✗ ${a.name}${a.detail ? `: ${a.detail.slice(0, 200)}` : ""}`,
		);
		failures.push(`${p.id}/${a.name}`);
	}

	persist({
		ts,
		kind: "build",
		buildModel: buildModel ?? "offline",
		prompt: p.id,
		pass: green,
		ms,
		assertions: assertions.map((a) => ({ name: a.name, pass: a.pass })),
	});

	await rm(root, { recursive: true, force: true });
}

console.log(`\n${fullyGreen}/${selected.length} builds fully green`);
if (failures.length) console.log(`failed assertions: ${failures.join(", ")}`);
console.log(`results appended → ${RESULTS_PATH}\n`);
process.exit(fullyGreen === selected.length ? 0 : 1);
