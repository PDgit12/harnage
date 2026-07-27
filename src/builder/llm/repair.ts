import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Provider } from "../../services/api/client";
import type { BuildResult } from "../assemble";
import { verifyBuild } from "../assemble";
import type { BuildProgress, HarnessPlan } from "../index";
import type { ProjectContext } from "../spec/context";
import { completeJSON } from "./client";
import {
	disallowedImports,
	importRefineMessage,
	stripFetchShimImports,
} from "./generate";
import { RepairPatchSchema } from "./schemas";

export interface RepairResult {
	result: BuildResult;
	repairsUsed: number;
}

// ~12KB of file content keeps repair prompts inside an 8k num_ctx window.
const MAX_FILE_BYTES = 12_000;

/** Paths mentioned in tsc error output, e.g. src/tools/foo.ts(3,5). */
function pathsFromErrors(errors: string[]): string[] {
	const found = new Set<string>();
	const text = errors.join("\n");
	for (const m of text.matchAll(/([\w./-]+\.tsx?)\(\d+,\d+\)/g)) {
		found.add(m[1]);
	}
	for (const m of text.matchAll(/\b(src\/[\w./-]+\.tsx?)\b/g)) {
		found.add(m[1]);
	}
	return [...found];
}

function isInsideOutputDir(outputDir: string, relPath: string): boolean {
	if (relPath.startsWith("/") || relPath.includes("..")) return false;
	const abs = resolve(outputDir, relPath);
	return abs.startsWith(resolve(outputDir) + sep);
}

async function gatherFiles(
	outputDir: string,
	errors: string[],
): Promise<Array<{ path: string; content: string }>> {
	const candidates = pathsFromErrors(errors).filter(
		(p) => isInsideOutputDir(outputDir, p) && existsSync(join(outputDir, p)),
	);

	const files: Array<{ path: string; content: string }> = [];
	let budget = MAX_FILE_BYTES;
	for (const p of candidates) {
		if (budget <= 0) break;
		const content = await readFile(join(outputDir, p), "utf-8");
		const slice = content.slice(0, budget);
		files.push({ path: p, content: slice });
		budget -= slice.length;
	}
	return files;
}

/** Package names the generated harness actually declares — the yardstick for
 *  "is this import real". Read from the output dir's own package.json so a patch
 *  touching a file that legitimately imports commander/ink/react is never
 *  rejected. Unreadable manifest → empty set, i.e. only zod/node:/relative pass. */
async function declaredDependencies(outputDir: string): Promise<Set<string>> {
	try {
		const raw = await readFile(join(outputDir, "package.json"), "utf-8");
		const pkg = JSON.parse(raw) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		return new Set([
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {}),
		]);
	} catch {
		return new Set();
	}
}

/**
 * Deterministic pre-pass, run BEFORE spending a repair attempt: delete import
 * lines for fetch shims (`node:fetch`, `node-fetch`, …) in the files tsc is
 * complaining about. `fetch` is a global, so the line is pure noise — but it is
 * an error no LLM reliably fixes, and both attempts get burned on the dodge.
 * Returns how many files were rewritten.
 */
async function stripFetchShims(
	outputDir: string,
	errors: string[],
): Promise<number> {
	let fixed = 0;
	for (const rel of pathsFromErrors(errors)) {
		if (!isInsideOutputDir(outputDir, rel)) continue;
		const abs = join(outputDir, rel);
		if (!existsSync(abs)) continue;
		const before = await readFile(abs, "utf-8");
		const after = stripFetchShimImports(before);
		if (after === before) continue;
		await writeFile(abs, after);
		fixed++;
	}
	return fixed;
}

/**
 * VERIFY-REPAIR stage: feed build errors + relevant generated files to the
 * LLM, apply full-file patches (path-safety enforced), re-verify. Repeats up
 * to maxRepairs. Instructions/schema go LAST in the prompt — Ollama truncates
 * the head when num_ctx overflows.
 */
export async function repairLoop(
	provider: Provider,
	_plan: HarnessPlan,
	firstResult: BuildResult,
	outputDir: string,
	_context: ProjectContext | undefined,
	maxRepairs = 2,
	onProgress?: (progress: BuildProgress) => void,
): Promise<RepairResult> {
	let result = firstResult;
	let repairsUsed = 0;
	// bun install succeeded if no install error is present in the first result
	let installOk = !result.errors.some((e) =>
		e.startsWith("bun install failed"),
	);

	const declared = await declaredDependencies(outputDir);

	// Free fix first — costs no repair attempt and no model call.
	if (!result.success && (await stripFetchShims(outputDir, result.errors))) {
		onProgress?.({
			stage: "repairing",
			message: "Removing invalid fetch imports (fetch is a global)...",
		});
		result = await verifyBuild(outputDir, { skipInstall: installOk });
	}

	// Carries the import complaint from a rejected patch into the next prompt so
	// the model corrects the actual mistake instead of repeating it verbatim.
	let importFeedback = "";

	for (let i = 1; i <= maxRepairs && !result.success; i++) {
		repairsUsed = i;
		onProgress?.({
			stage: "repairing",
			message: `Repair attempt ${i}/${maxRepairs}...`,
		});

		const files = await gatherFiles(outputDir, result.errors);
		const fileBlock = files
			.map((f) => `--- ${f.path} ---\n${f.content}`)
			.join("\n");

		const prompt = `Build errors from a freshly generated TypeScript project:
${result.errors.join("\n").slice(0, 6000)}

Relevant files (full content):
${fileBlock}

You are fixing this project so it passes typecheck.
Return ONLY JSON: {"analysis": "...", "patches": [{"path": "src/...", "newContent": "<complete corrected file>"}]}
Rules: newContent is the ENTIRE file, not a diff. Only touch files shown above or clearly implied by the errors. Do not modify package.json dependencies.
Imports: this project ships a FIXED package.json — you cannot add dependencies. Only relative imports, real node: built-ins (node:fs, node:path, node:child_process, node:os, node:crypto, …), and these installed packages are available: ${[...declared].join(", ") || "zod"}. For HTTP use the global fetch() with NO import at all — "node:fetch" is NOT a module, and node-fetch/axios/got are not installed. A "Cannot find module" error is fixed by REMOVING the import and using a built-in or a global, never by renaming the package.${importFeedback}`;

		let patch: Awaited<ReturnType<typeof parsePatch>>;
		try {
			patch = await parsePatch(provider, prompt);
		} catch {
			break; // model can't produce a valid patch — return last state
		}

		let applied = 0;
		const rejected: string[] = [];
		importFeedback = "";
		for (const p of patch.patches) {
			if (!isInsideOutputDir(outputDir, p.path)) continue;
			// Same fetch-shim cleanup the pre-pass does, applied to incoming
			// content: the model re-adds the line as often as it removes it.
			const content = stripFetchShimImports(p.newContent);
			// A patch that reaches for an undeclared package cannot compile — it
			// only trades one "Cannot find module" for another. Reject it and tell
			// the model why, instead of writing a file that guarantees a failure.
			const bad = disallowedImports(content, declared);
			if (bad.length) {
				rejected.push(`${p.path}: ${bad.join(", ")}`);
				continue;
			}
			try {
				const target = join(outputDir, p.path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, content);
				applied++;
			} catch {
				/* one unwritable patch must not kill the whole repair attempt */
			}
		}
		if (rejected.length) {
			importFeedback = `\n\nYour previous patch was REJECTED and not applied — it imported packages that do not exist (${rejected.join("; ")}). ${importRefineMessage(`import "${rejected[0].split(": ")[1].split(", ")[0]}";`)}`;
		}
		if (applied === 0) {
			// Every patch was rejected on imports — the next attempt now carries the
			// reason, so keep going instead of returning the still-broken build.
			if (rejected.length && i < maxRepairs) continue;
			break;
		}

		result = await verifyBuild(outputDir, { skipInstall: installOk });
		installOk =
			installOk ||
			!result.errors.some((e) => e.startsWith("bun install failed"));
	}

	return { result, repairsUsed };
}

function parsePatch(provider: Provider, prompt: string) {
	return completeJSON(provider, prompt, RepairPatchSchema);
}
