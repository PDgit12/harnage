import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { BuildOptions } from "./builder";
import { buildHarness } from "./builder";
import { createProvider } from "./services/api/client";
import { resolveProvider } from "./services/api/resolve";

/** Recursively list generated files (relative paths), skipping node_modules/.git. */
function listFiles(dir: string, root = dir, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) listFiles(p, root, out);
		else out.push(relative(root, p));
	}
	return out.sort();
}

/** Show what changed between two builds — the "live preview" of the harness evolving. */
function showChanges(before: string[], after: string[]): void {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	const added = after.filter((f) => !beforeSet.has(f));
	const removed = before.filter((f) => !afterSet.has(f));
	if (before.length === 0) {
		console.log(chalk.dim(`  ${after.length} files generated:`));
		for (const f of after.slice(0, 14)) console.log(chalk.green(`   + ${f}`));
		if (after.length > 14)
			console.log(chalk.dim(`   … +${after.length - 14} more`));
		return;
	}
	if (!added.length && !removed.length) {
		console.log(
			chalk.dim("  (harness regenerated — same file set, updated contents)"),
		);
		return;
	}
	for (const f of added) console.log(chalk.green(`   + ${f}`));
	for (const f of removed) console.log(chalk.red(`   - ${f}`));
}

/**
 * Conversational, iterative harness builder — the Lovable/Emergent-style studio.
 * Uses a build brain (any configured model API) to plan, builds, shows the
 * harness taking shape, then loops on refinements until you run it. Falls back
 * to the offline deterministic chassis when no model API is configured.
 */
export async function studio(): Promise<void> {
	// Studio is a conversation — it needs a real terminal. Non-interactive
	// (piped) callers should use `harnage init "<description>"` instead.
	if (!stdin.isTTY) {
		console.log(
			chalk.yellow(
				'harnage studio is interactive. For scripts, use: harnage init "<description>"',
			),
		);
		return;
	}
	const rl = createInterface({ input: stdin, output: stdout });
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	// Never throw on EOF/closed input — return "" so the caller exits cleanly.
	const ask = async (prompt: string): Promise<string> => {
		if (closed) return "";
		try {
			return (await rl.question(prompt)).trim();
		} catch {
			return "";
		}
	};

	// Resolve the build brain — multi-API: config / Anthropic / OpenAI /
	// OpenRouter (poolside etc.) / local Ollama, whichever is configured.
	let options: BuildOptions | undefined;
	let brain = "offline chassis (no model API configured)";
	try {
		const cfg = await resolveProvider();
		const reachable =
			cfg.type !== "ollama" ||
			(await fetch(`${cfg.baseUrl ?? "http://localhost:11434"}/api/tags`, {
				signal: AbortSignal.timeout(1500),
			})
				.then((r) => r.ok)
				.catch(() => false));
		if (reachable) {
			options = {
				provider: createProvider(cfg),
				ask: async (q, d) => {
					const a = await ask(
						`  ${chalk.cyan("?")} ${q} ${chalk.dim(`[${d}]`)} `,
					);
					return a || d;
				},
			};
			brain = `${cfg.type} · ${cfg.model}`;
		}
	} catch {
		/* offline */
	}

	console.log();
	console.log(chalk.cyan.bold("  harnage studio"));
	console.log(chalk.dim(`  Build brain: ${brain}`));
	console.log(
		chalk.dim("  Describe an agent; refine it; then 'run' to finish.\n"),
	);

	let description = await ask(chalk.bold("  What do you want to build? "));
	if (!description) {
		console.log(chalk.yellow("  Nothing to build."));
		rl.close();
		return;
	}

	let lastFiles: string[] = [];
	let outputDir: string | undefined;

	while (true) {
		const res = await buildHarness(
			description,
			process.cwd(),
			(p) =>
				stdout.write(
					`\r  ${chalk.dim(p.stage.padEnd(10))} ${chalk.dim(p.message)}\x1b[K`,
				),
			options,
		);
		stdout.write("\r\x1b[K");
		if (!res.success) {
			console.log(chalk.red("  ✗ Build failed:"));
			for (const e of res.errors) console.log(chalk.red(`    - ${e}`));
		} else {
			const files = listFiles(res.outputDir);
			console.log(chalk.green.bold("  ✓ Built"));
			showChanges(lastFiles, files);
			lastFiles = files;
			outputDir = res.outputDir;
		}

		if (closed) break;
		const next = await ask(
			chalk.bold("\n  Refine (describe a change) or 'run' to finish: "),
		);
		if (!next || /^(run|done|finish|exit|quit)$/i.test(next)) break;
		// Accumulate the refinement into the spec — the harness evolves in place.
		description = `${description}. Also: ${next}`;
	}

	rl.close();
	if (outputDir) {
		console.log();
		console.log(chalk.green.bold("  Your harness is ready."));
		console.log(`  ${chalk.bold("Output:")} ${outputDir}`);
		console.log(chalk.dim(`  cd ${outputDir} && bun install && bun start`));
	}
}
