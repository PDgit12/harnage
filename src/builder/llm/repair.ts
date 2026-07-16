import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Provider } from "../../services/api/client";
import type { BuildResult } from "../assemble";
import { verifyBuild } from "../assemble";
import type { BuildProgress, HarnessPlan } from "../index";
import type { ProjectContext } from "../spec/context";
import { completeJSON } from "./client";
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
Rules: newContent is the ENTIRE file, not a diff. Only touch files shown above or clearly implied by the errors. Do not modify package.json dependencies.`;

		let patch: Awaited<ReturnType<typeof parsePatch>>;
		try {
			patch = await parsePatch(provider, prompt);
		} catch {
			break; // model can't produce a valid patch — return last state
		}

		let applied = 0;
		for (const p of patch.patches) {
			if (!isInsideOutputDir(outputDir, p.path)) continue;
			try {
				const target = join(outputDir, p.path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, p.newContent);
				applied++;
			} catch {
				/* one unwritable patch must not kill the whole repair attempt */
			}
		}
		if (applied === 0) break;

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
