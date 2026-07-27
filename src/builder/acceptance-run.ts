/**
 * Run the acceptance battery against the FINISHED harness, on the model it was
 * built for, and write the result into the harness itself.
 *
 * This is the step that turns "it compiled" into "it works". A harness can pass
 * `tsc --noEmit` and still be unusable — this session shipped one that compiled
 * cleanly and could not reach any remote provider, and a local 3B that narrates
 * ("you need to create a file…") instead of calling file_write. Neither is
 * visible without executing the thing.
 *
 * It never fails the build. The user gets their harness plus an honest score,
 * and — when the score is poor — the next model up from the catalog, because a
 * low score is usually the model, not the harness.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AcceptanceTask } from "./llm/acceptance";
import { grade } from "./llm/acceptance";

export interface AcceptanceTaskResult {
	id: string;
	pass: boolean;
	ms: number;
	detail: string;
	/** The run never reached a verdict — rate limit, auth, network. NOT evidence
	 *  about the harness or the model's ability, so it is excluded from scoring. */
	errored?: boolean;
}

/** Provider/transport failures, as opposed to the model answering badly. A 429
 *  scored as a task failure would blame the harness for an exhausted quota and
 *  send the user chasing a bigger model for no reason. */
function isInfraError(message: string): boolean {
	return /\b(429|401|403|5\d\d)\b|rate limit|quota|unauthorized|invalid api key|timed? ?out|econnrefused|fetch failed|network/i.test(
		message,
	);
}

export interface AcceptanceReport {
	model: string;
	tier: string;
	loop: string;
	passed: number;
	total: number;
	bar: number;
	met: boolean;
	/** Tasks excluded from scoring because the provider errored. */
	errored?: number;
	/** Scaffold overrides this run used, when the optimize loop supplied any. */
	profile?: Record<string, unknown>;
	tasks: AcceptanceTaskResult[];
	/** Set when the run could not happen at all (provider down, no tasks). */
	skipped?: string;
}

/** Pass bar as a fraction of the battery, by model tier. A 3B is not held to a
 *  frontier bar — the claim is "a good harness lifts a small model", not "a 3B
 *  matches a 70B". Mirrors TIER_BAR in scripts/eval-tasks.ts. */
const TIER_BAR: Record<string, number> = {
	frontier: 0.9,
	strong: 0.9,
	mid: 0.75,
	small: 0.6,
};

interface ProviderConfig {
	type: string;
	model: string;
	baseUrl?: string;
	apiKey?: string;
	maxTokens?: number;
	contextTokens?: number;
}

/**
 * Execute the battery. Everything is dynamically imported FROM THE GENERATED
 * HARNESS, so this exercises the code the user actually received rather than
 * harnage's own engine.
 */
export async function runAcceptance(
	outputDir: string,
	tasks: AcceptanceTask[],
	providerConfig: ProviderConfig,
	onProgress?: (line: string) => void,
	/** Scaffold overrides merged over the model's resolved profile. This is what
	 *  lets the optimize loop re-run the SAME battery under a different scaffold
	 *  without rebuilding the harness. */
	profileOverride?: Record<string, unknown>,
): Promise<AcceptanceReport> {
	const empty: AcceptanceReport = {
		model: providerConfig.model,
		tier: "unknown",
		loop: "unknown",
		passed: 0,
		total: 0,
		bar: 0,
		met: false,
		tasks: [],
	};
	if (!tasks.length)
		return { ...empty, skipped: "no acceptance tasks planned" };

	let getAllTools: () => Promise<unknown[]>;
	let LoopEngine: new (
		cfg: Record<string, unknown>,
	) => {
		run(goal: string): Promise<string>;
	};
	let resolveProfile: (m: string, ctx?: number) => Record<string, unknown>;
	try {
		({ getAllTools } = await import(join(outputDir, "src/tools.ts")));
		({ LoopEngine } = await import(join(outputDir, "src/engine.ts")));
		({ resolveProfile } = await import(join(outputDir, "src/profiles.ts")));
	} catch (err) {
		return {
			...empty,
			skipped: `could not load the generated harness: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const profile = {
		...resolveProfile(providerConfig.model, 8192),
		...(profileOverride ?? {}),
	};
	const tools = await getAllTools();
	const policy = {
		mode: "default" as const,
		rules: [
			{ pattern: "bash(*)", allow: true },
			{ pattern: "file_write(*)", allow: true },
			{ pattern: "file_edit(*)", allow: true },
		],
	};

	const results: AcceptanceTaskResult[] = [];
	const originalCwd = process.cwd();

	for (const task of tasks) {
		// A fresh dir per task: one task's file writes must never satisfy the
		// next task's file_exists check.
		const fixture = await mkdtemp(join(tmpdir(), "harnage-accept-"));
		for (const f of task.fixture ?? []) {
			const abs = join(fixture, f.path);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, f.content);
		}

		const started = performance.now();
		let answer = "";
		let error: string | undefined;
		try {
			process.chdir(fixture);
			const engine = new LoopEngine({
				tools,
				providerConfig,
				profile,
				policy,
				persistSession: false,
			});
			answer = await engine.run(task.goal);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			process.chdir(originalCwd);
		}

		const ms = Math.round(performance.now() - started);
		const readFixtureFile = (rel: string): string | null => {
			const abs = join(fixture, rel);
			return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
		};
		// The engine RETURNS provider failures as a string ("Error: openai 429: …")
		// instead of throwing, so checking only the thrown error missed every one
		// of them: a rate-limited run reported 0/4 BELOW BAR and advised the user
		// to buy a bigger model. Inspect the answer too.
		const returnedError = /^\s*(Error|Stopped):/i.test(answer) ? answer : "";
		const failureText = error ?? returnedError;
		const errored = Boolean(failureText) && isInfraError(failureText);
		const pass =
			!error && !returnedError && grade(task, answer, readFixtureFile);
		results.push({
			id: task.id,
			pass,
			ms,
			errored,
			detail: (failureText || answer).replace(/\s+/g, " ").slice(0, 160),
		});
		const mark = errored ? "SKIP" : pass ? "PASS" : "FAIL";
		onProgress?.(
			`  ${mark} ${task.id}${pass ? "" : ` — ${(error ?? answer).replace(/\s+/g, " ").slice(0, 90)}`}`,
		);

		await rm(fixture, { recursive: true, force: true });
	}

	// Scored tasks only: an infra error is not a verdict about the harness.
	const scored = results.filter((r) => !r.errored);
	const passed = scored.filter((r) => r.pass).length;
	const tier = String(profile.tier ?? "unknown");
	const bar = Math.ceil((TIER_BAR[tier] ?? 1) * scored.length);
	const errored = results.length - scored.length;
	return {
		model: providerConfig.model,
		tier,
		loop: String(profile.loop ?? "unknown"),
		profile: profileOverride,
		passed,
		total: scored.length,
		errored,
		bar,
		// Every task erroring is not a pass — it means nothing was measured.
		met: scored.length > 0 && passed >= bar,
		tasks: results,
		skipped:
			scored.length === 0
				? "every task hit a provider error (rate limit or connectivity) — nothing was measured"
				: undefined,
	};
}

/** Human-readable proof that ships inside the harness. */
export function renderAcceptanceMd(
	name: string,
	report: AcceptanceReport,
): string {
	if (report.skipped) {
		return `# Acceptance\n\nNot run — ${report.skipped}.\n\nRun it yourself once the harness is configured: \`bun start\` and try the tasks your agent is for.\n`;
	}
	const rows = report.tasks
		.map(
			(t) =>
				`| ${t.errored ? "SKIP" : t.pass ? "PASS" : "FAIL"} | \`${t.id}\` | ${(t.ms / 1000).toFixed(1)}s | ${t.pass ? "" : t.detail.replace(/\|/g, "\\|").slice(0, 100)} |`,
		)
		.join("\n");
	const erroredNote = report.errored
		? `\n> ${report.errored} task(s) hit a provider error (rate limit or connectivity) and are excluded from the score — they say nothing about this harness.\n`
		: "";
	return `# Acceptance

\`${name}\` was tested against its own domain on the model it was built for.

- **Model:** ${report.model} (${report.tier} tier, ${report.loop} loop)
- **Result:** ${report.passed}/${report.total} — bar for this tier is ${report.bar}/${report.total} → **${report.met ? "MET" : "BELOW BAR"}**
- **Run at:** ${new Date().toISOString()}
${erroredNote}
| Result | Task | Time | Detail |
|---|---|---|---|
${rows}

${
	report.met
		? "This harness met its bar on this model. Re-run after changing the model or the system prompt."
		: "Below bar. That is usually the MODEL, not the harness — a stronger model on the same harness typically clears it. See the suggestion printed at build time, or edit `~/." +
			name +
			"/config.json` and re-run."
}
`;
}

/**
 * Scaffold variants worth trying when a harness comes in below its bar.
 *
 * Derived from HOW it failed, not swept blindly: a full loop x edit-format
 * sweep is four rebuilds of a battery that already costs minutes, and most of
 * those combinations have nothing to do with the observed failure. Ordered by
 * how often the change has actually helped.
 */
export function optimizationCandidates(
	report: AcceptanceReport,
): Array<{ label: string; override: Record<string, unknown> }> {
	const failed = report.tasks.filter((t) => !t.pass && !t.errored);
	const detail = failed
		.map((t) => t.detail)
		.join(" ")
		.toLowerCase();
	const out: Array<{ label: string; override: Record<string, unknown> }> = [];

	// Describes the work instead of doing it — the single most common small-model
	// failure, and the one the narration backstop exists for.
	if (
		/you (can|should|need to)|in your terminal|command like|echo /.test(detail)
	) {
		out.push({
			label: "force action (nudge + fixed pipeline)",
			override: { nudge: true, loop: "pipeline", temperature: 0 },
		});
	}

	// Reaching for things it never observed, or picking the wrong tool: shrink
	// what it can see and stop it improvising.
	if (
		/not (found|exist)|no such|cannot find|does not exist|unknown tool/.test(
			detail,
		)
	) {
		out.push({
			label: "tighten grounding (fewer tools, temperature 0)",
			override: { maxTools: 3, temperature: 0 },
		});
	}

	// Nothing diagnostic in the failures — fall back to the tightest scaffold,
	// which is the one that wins most often when the cause is unclear.
	if (!out.length) {
		out.push({
			label: "tightest scaffold (pipeline, 3 tools, temperature 0)",
			override: { loop: "pipeline", maxTools: 3, temperature: 0, nudge: true },
		});
	}
	return out.slice(0, 2);
}

/**
 * Re-run the battery under alternative scaffolds and keep the best.
 *
 * This is the step that makes a generated harness TUNED rather than merely
 * tested: the user gets the scaffold that actually scored highest on their own
 * domain tasks, on their own model, instead of the one a size tier guessed.
 * Bounded to two extra attempts — the battery costs real minutes, and past two
 * the returns stop justifying the wait.
 */
export async function optimizeAcceptance(
	outputDir: string,
	tasks: AcceptanceTask[],
	providerConfig: ProviderConfig,
	baseline: AcceptanceReport,
	onProgress?: (line: string) => void,
): Promise<{ best: AcceptanceReport; tried: number }> {
	if (baseline.met || baseline.skipped || !tasks.length) {
		return { best: baseline, tried: 0 };
	}
	let best = baseline;
	let tried = 0;
	for (const candidate of optimizationCandidates(baseline)) {
		tried++;
		onProgress?.(`  retry ${tried}: ${candidate.label}`);
		const attempt = await runAcceptance(
			outputDir,
			tasks,
			providerConfig,
			onProgress,
			candidate.override,
		);
		if (attempt.skipped) continue;
		if (attempt.passed > best.passed) {
			best = attempt;
			onProgress?.(`  improved to ${attempt.passed}/${attempt.total}`);
		}
		if (best.met) break;
	}
	return { best, tried };
}
