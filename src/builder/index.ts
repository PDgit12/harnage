import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../services/api/client";
import { buildAgentSystemPrompt } from "../services/system-prompt";
import type { AcceptanceReport } from "./acceptance-run";
import type { BuildResult } from "./assemble";
import { assembleAndVerify } from "./assemble";
import type { AskFn } from "./llm/interview";
import {
	catalogOverrides,
	classifyDomain,
	judgementWarning,
	maxParamsForRam,
	recommendModels,
	strongerInstalledModel,
} from "./models/catalog";
import {
	type McpRecommendation,
	recommendMcpServers,
} from "./models/mcp-catalog";
import type { StructuredSpec } from "./spec";
import { parseIntent, validateAgentPrompt } from "./spec";
import { analyzeProject } from "./spec/context";

export interface HarnessPlan {
	name: string;
	description: string;
	tools: string[];
	commands: string[];
	providers: string[];
	systemPrompt: string;
	hasMcp: boolean;
	/** Local model the generated harness defaults to (detected at build time). */
	defaultLocalModel?: string;
	/** A STRONGER installed model to escalate to when the default gets stuck.
	 *  The engine has always supported this; nothing ever populated it, so the
	 *  escalation path was dead code. Measured motivation: a 3B gathers badly
	 *  and fails judgement tasks an 8B passes — escalating beats failing. */
	escalationModel?: string;
	/** Per-model scaffold overrides baked into profiles.ts (keyed by model id). */
	modelProfileOverrides?: Record<string, unknown>;
	/** Keyword-matched MCP server suggestions — always computed, shown regardless of accept/decline. */
	mcpRecommendations?: McpRecommendation[];
	/** Servers the user opted into (interactive only) — written as a real mcp.json. */
	mcpServersToWrite?: Record<
		string,
		{ command: string; args: string[]; env: Record<string, string> }
	>;
	/** Baked domain pipeline stages for the small-model tier (Engine v3). */
	pipeline?: Array<{ name: string; instruction: string; tool?: string }>;
	/** LLM-planned bespoke slash commands (code generated in the GENERATE stage). */
	customCommands?: Array<{
		name: string;
		description: string;
		behavior: string;
	}>;
	/** LLM-planned bespoke skills (procedural memory) rendered as skills/*.md. */
	customSkills?: Array<{ name: string; trigger: string; guidance: string }>;
	/** Bounded chassis knobs baked into the generated engine. */
	config?: {
		maxIterations?: number;
		memory?: boolean;
		eval?: boolean;
		judgeByDefault?: boolean;
	};
	/** Per-domain accent palette baked into the generated TUI (same chassis,
	 *  colours derived from what the harness is for). */
	theme?: { accent: string; accentDim: string };
}

export interface BuildProgress {
	stage:
		| "analyzing"
		| "planning"
		| "building"
		| "verifying"
		| "repairing"
		| "done"
		| "error";
	message: string;
	detail?: string;
}

export interface BuildOptions {
	/** LLM provider for the interview/plan/repair stages. Absent = offline keyword path. */
	provider?: Provider;
	/** Interactive clarifying-question callback (used by /init). Absent = default answers. */
	ask?: AskFn;
	/** Max verify-repair iterations after a failed build. Default 2. */
	maxRepairs?: number;
	/** Probe the chosen model before generating, and bake the MEASURED scaffold
	 *  instead of the size-tier guess. Default true. */
	characterize?: boolean;
	/** Run the domain acceptance battery on the chosen model after a successful
	 *  build. Default true — a harness nobody executed is a harness nobody knows
	 *  works. Set false for batch/CI callers that only care that it compiles. */
	acceptance?: boolean;
}

/**
 * Description flows verbatim into generated source (program.description(...),
 * the TUI banner) — strip characters that could break or inject into those
 * string/template literals. name is already sanitized to [a-z0-9-] above;
 * description just needs the same defusing, not the same charset.
 */
function sanitizeDescription(s: string): string {
	return s
		.replace(/`/g, "'")
		.replace(/"/g, "'")
		.replace(/\$\{/g, "")
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		.trim();
}

export function generatePlan(spec: StructuredSpec): HarnessPlan {
	const commands: string[] = [];
	const providers: string[] = [];

	for (const model of spec.models) {
		providers.push(model);
		commands.push(`${model === "ollama" ? "local" : model}-chat`);
	}

	for (const cmd of spec.commands) {
		commands.push(cmd.replace("/", "").replace(/-/g, "_"));
	}

	const hasMcp = spec.tools.includes("mcp");

	const name =
		spec.purpose
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, 30) || "agent-harness";

	return {
		name,
		description: sanitizeDescription(spec.purpose).slice(0, 80),
		tools: spec.tools,
		commands: [...new Set(commands)],
		providers,
		// Even the offline keyword fallback gets the correct, domain-grounded
		// system prompt with REAL tool names — not DEFAULT_BLOCKS, whose tool
		// reference lists names (read/write/GlobTool) that don't exist in a
		// generated harness. This path runs whenever the build brain is
		// unavailable or rate-limited, so it must not produce slop either.
		systemPrompt: buildAgentSystemPrompt({
			name,
			purpose: spec.purpose,
			tools: spec.tools,
		}),
		hasMcp,
	};
}

/**
 * Probe the chosen local model and return the scaffold overrides MEASUREMENT
 * justifies. Best-effort throughout: an unreachable model, a timeout, or any
 * error yields undefined and the caller keeps its catalog/size-tier defaults —
 * characterization can never make a build worse than skipping it.
 */
/** Per-turn latency from the most recent characterization, used to predict how
 *  long the acceptance battery will take. 0 when nothing was measured. */
let lastMeasuredTurnMs = 0;

async function characterizeChosenModel(
	model: string,
	onProgress?: (p: BuildProgress) => void,
): Promise<Record<string, unknown> | undefined> {
	try {
		const { createProvider } = await import("../services/api/client");
		const { characterizeModel, describeCharacterization } = await import(
			"./models/characterize"
		);
		onProgress?.({
			stage: "planning",
			message: `Characterizing ${model} before generating for it...`,
		});
		const provider = createProvider({
			type: "ollama",
			model,
			baseUrl: "http://localhost:11434",
			maxTokens: 512,
			contextTokens: 8192,
		});
		const c = await characterizeModel(provider);
		onProgress?.({
			stage: "planning",
			message: `Model profile: ${describeCharacterization(c)}`,
		});
		lastMeasuredTurnMs = c.medianMs;
		return Object.keys(c.override).length
			? (c.override as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

async function llmPlan(
	provider: Provider,
	prompt: string,
	context: Awaited<ReturnType<typeof analyzeProject>>,
	ask: AskFn | undefined,
	onProgress?: (progress: BuildProgress) => void,
): Promise<
	| { plan: HarnessPlan; spec: import("./llm/schemas").LLMSpec }
	| { error: string }
> {
	try {
		const { runInterview } = await import("./llm/interview");
		const { runLLMPlan } = await import("./llm/plan");
		const spec = await runInterview(provider, prompt, {
			ask,
			projectContext: context,
		});
		onProgress?.({ stage: "planning", message: "Generating build plan..." });
		const plan = await runLLMPlan(provider, spec, context);
		return { plan, spec };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		onProgress?.({
			stage: "analyzing",
			message: "Build brain unavailable — using the offline generic chassis",
			detail,
		});
		return { error: detail };
	}
}

export async function buildHarness(
	prompt: string,
	cwd?: string,
	onProgress?: (progress: BuildProgress) => void,
	options?: BuildOptions,
): Promise<BuildResult> {
	onProgress?.({ stage: "analyzing", message: "Analyzing your request..." });
	validateAgentPrompt(prompt);
	const projectCwd = cwd ?? process.cwd();
	const context = await analyzeProject(projectCwd);

	let plan: HarnessPlan | null = null;
	let extraFiles: Array<{ path: string; code: string }> | undefined;
	// Tracks whether the bespoke LLM pipeline actually produced the plan, so the
	// final result can tell the user plainly (a silent keyword fallback on a
	// transient rate limit used to be indistinguishable from a real build).
	let usedLLM = false;
	let fallbackReason: string | undefined;
	if (options?.provider) {
		const llm = await llmPlan(
			options.provider,
			prompt,
			context,
			options.ask,
			onProgress,
		);
		if ("error" in llm) {
			fallbackReason = llm.error;
		}
		if ("plan" in llm) {
			usedLLM = true;
			plan = llm.plan;
			// GENERATE stage: real implementations for spec.customTools. The
			// registry derives tool modules from plan.tools by name, so adding
			// the ids here is all the wiring the generated harness needs.
			if (llm.spec.customTools?.length) {
				onProgress?.({
					stage: "building",
					message: "Generating custom tools...",
				});
				try {
					const { runGenerate } = await import("./llm/generate");
					const generated = await runGenerate(
						options.provider,
						llm.spec,
						context,
					);
					if (generated.length) {
						extraFiles = generated.map((g) => ({ path: g.path, code: g.code }));
						plan.tools = [
							...new Set([...plan.tools, ...generated.map((g) => g.toolId)]),
						];
					}
				} catch (err) {
					onProgress?.({
						stage: "building",
						message: "Custom tool generation failed — continuing without",
						detail: err instanceof Error ? err.message : String(err),
					});
				}
			}
			// GENERATE stage: bespoke slash-command code from the planned behavior.
			// Skills are rendered deterministically in assemble (no LLM call needed).
			if (plan.customCommands?.length) {
				onProgress?.({
					stage: "building",
					message: "Generating custom commands...",
				});
				try {
					const { runGenerateCommands } = await import("./llm/generate");
					const cmds = await runGenerateCommands(
						options.provider,
						plan.customCommands,
						plan.description,
					);
					if (cmds.length) {
						extraFiles = [
							...(extraFiles ?? []),
							...cmds.map((c) => ({ path: c.path, code: c.code })),
						];
						// Keep only the commands that actually generated, so the registry
						// never references a missing module.
						const built = new Set(cmds.map((c) => c.id));
						plan.customCommands = plan.customCommands.filter((c) =>
							built.has(
								c.name
									.toLowerCase()
									.replace(/^\//, "")
									.replace(/[^a-z0-9]+/g, "_")
									.replace(/^_+|_+$/g, "")
									.slice(0, 30),
							),
						);
					}
				} catch (err) {
					onProgress?.({
						stage: "building",
						message: "Custom command generation failed — continuing without",
						detail: err instanceof Error ? err.message : String(err),
					});
					plan.customCommands = undefined;
				}
			}
		}
	}
	if (!plan) {
		const spec = parseIntent(prompt);
		onProgress?.({ stage: "planning", message: "Generating build plan..." });
		plan = generatePlan(spec);
	}

	// Per-domain theme: same chassis, accent palette derived from what the
	// harness is for (finance→green, security→red, …). Set on both the LLM and
	// keyword paths.
	const { pickTheme } = await import("./theme");
	plan.theme = pickTheme(`${plan.description} ${plan.name} ${prompt}`);

	// Model-aware packing: list the user's installed local models (HTTP tag
	// listing only — never runs a model) so the harness ships preconfigured.
	if (plan.providers.includes("ollama")) {
		try {
			const res = await fetch("http://localhost:11434/api/tags", {
				signal: AbortSignal.timeout(2000),
			});
			if (res.ok) {
				const data = (await res.json()) as {
					models?: Array<{
						name: string;
						details?: { parameter_size?: string; families?: string[] };
					}>;
				};
				// Text models only: skip embedders and vision models (weak tool use).
				const named = (data.models ?? []).filter(
					(m) =>
						!m.name.includes("embed") &&
						!(m.details?.families ?? []).some(
							(f) => f === "clip" || f === "mllama",
						),
				);
				// Harness agents REQUIRE tool calling — probe /api/show capabilities
				// (llama3, for example, is completion-only and 400s on tools).
				const capable = await Promise.all(
					named.map(async (m) => {
						try {
							const show = await fetch("http://localhost:11434/api/show", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ model: m.name }),
								signal: AbortSignal.timeout(2000),
							});
							if (!show.ok) return null;
							const info = (await show.json()) as { capabilities?: string[] };
							return info.capabilities?.includes("tools") ? m : null;
						} catch {
							return null;
						}
					}),
				);
				const candidates = capable.filter((m) => m !== null);
				const size = (m: {
					name: string;
					details?: { parameter_size?: string };
				}) =>
					Number.parseFloat(
						m.details?.parameter_size?.match(/(\d+(?:\.\d+)?)/)?.[1] ??
							m.name.match(/(\d+(?:\.\d+)?)b/i)?.[1] ??
							"0",
					);
				const { totalmem } = await import("node:os");
				const ramGb = totalmem() / 1024 ** 3;
				const installedNames = candidates.map((m) => m.name);

				if (options?.ask) {
					// Curated recommendation: best models for this agent's domain at
					// this RAM — including ones not yet installed (with a pull hint),
					// not just what happens to be on the machine.
					const domain = classifyDomain(`${plan.description} ${plan.name}`);
					const recs = recommendModels(domain, ramGb, installedNames).slice(
						0,
						6,
					);
					if (recs.length) {
						const menu = recs
							.map(
								(r, i) =>
									`  ${i + 1}) ${r.id}  ~${r.ramGb}GB  ${r.installed ? "[installed]" : `[run: ollama pull ${r.id}]`}  ${r.note}`,
							)
							.join("\n");
						const def = (recs.find((r) => r.installed) ?? recs[0]).id;
						const answer = (
							await options.ask(
								`Recommended models for a ${domain} agent on ${Math.round(ramGb)}GB RAM:\n${menu}\n  Pick a number or model name`,
								def,
							)
						).trim();
						const num = Number.parseInt(answer, 10);
						// Accept a valid menu number, OR a model id that actually exists
						// (recommended or installed) if typed by name. Any other free
						// text (e.g. a stray interview-style answer like "no.4") must
						// NOT become the baked model name — fall back to the default.
						const knownModel =
							recs.some((r) => r.id === answer) ||
							installedNames.includes(answer);
						plan.defaultLocalModel =
							Number.isFinite(num) && num >= 1 && num <= recs.length
								? recs[num - 1].id
								: knownModel
									? answer
									: def;
					}
				} else if (candidates.length) {
					// Non-interactive: largest installed model that fits the RAM tier.
					const fitting = candidates.filter(
						(m) => size(m) <= maxParamsForRam(ramGb),
					);
					const pool = fitting.length ? fitting : candidates;
					plan.defaultLocalModel = [...pool].sort(
						(a, b) => size(b) - size(a),
					)[0].name;
				}
			}
		} catch {
			/* offline or no ollama — generated harness keeps its generic default */
		}
	}

	// MCP server recommendation — keyword-match the spec against the curated
	// catalog. Interactive: ask before writing a real mcp.json. Non-interactive
	// (or nothing matched/declined): never blocks — at most a DEPLOY.md note.
	const mcpRecs = recommendMcpServers(`${plan.description} ${plan.name}`);
	if (mcpRecs.length) {
		plan.mcpRecommendations = mcpRecs;
		if (options?.ask) {
			const menu = mcpRecs
				.map((r, i) => `  ${i + 1}) ${r.name}  ${r.description}`)
				.join("\n");
			const answer = await options.ask(
				`This agent might benefit from these MCP servers:\n${menu}\n  Add to mcp.json? [y/N]`,
				"n",
			);
			if (/^y(es)?$/i.test(answer.trim())) {
				plan.mcpServersToWrite = Object.fromEntries(
					mcpRecs.map((r) => [
						r.name,
						{ command: r.command, args: r.args, env: {} },
					]),
				);
			}
		}
	}

	// Bake the chosen model's scaffold into profiles.ts. Three sources, weakest
	// to strongest: the size tier (a guess from the parameter count), the
	// curated catalog entry (hand-tuned per model), and MEASUREMENT — probing
	// the real endpoint before generating anything for it. Measurement wins,
	// because the size tier has been demonstrably wrong: constrained-json beat
	// native tool-calling 14/20 to 7/20 on a model whose size would have been
	// handed the native channel.
	if (plan.defaultLocalModel) {
		const ov = catalogOverrides(plan.defaultLocalModel) ?? {};
		let measured: Record<string, unknown> = {};
		if (options?.characterize !== false) {
			const probe = await characterizeChosenModel(
				plan.defaultLocalModel,
				onProgress,
			);
			measured = probe ?? {};
		}
		const merged = { ...ov, ...measured };
		if (Object.keys(merged).length) {
			plan.modelProfileOverrides = {
				[plan.defaultLocalModel.toLowerCase()]: merged,
			};
		}
	}

	// Warn at the moment of choice, not after the harness disappoints. Measured
	// threshold (scripts/judgement-matrix.ts): under 8B a model reads, searches
	// and writes reliably but does not RANK — it picks the first item rather
	// than the most important one, and no amount of harness work closes it.
	if (plan.defaultLocalModel) {
		const warn = judgementWarning(
			plan.defaultLocalModel,
			classifyDomain(`${plan.description} ${prompt}`),
			prompt,
		);
		if (warn) {
			onProgress?.({ stage: "planning", message: `Note: ${warn}` });
		}
	}

	// Build the model CHAIN: keep the cheap default for ordinary turns, and name
	// a stronger installed model to fall back to when it gets stuck. Costs
	// nothing until it is needed, and turns a hard failure into a slower success.
	if (plan.defaultLocalModel) {
		try {
			const res = await fetch("http://localhost:11434/api/tags", {
				signal: AbortSignal.timeout(2000),
			});
			const { models } = (await res.json()) as {
				models?: Array<{ name: string }>;
			};
			const stronger = strongerInstalledModel(
				plan.defaultLocalModel,
				(models ?? []).map((m) => m.name),
			);
			if (stronger) {
				plan.escalationModel = stronger;
				onProgress?.({
					stage: "planning",
					message: `Escalation model: ${stronger} (used only when ${plan.defaultLocalModel} gets stuck)`,
				});
			}
		} catch {
			/* ollama unreachable — no chain, the harness still works */
		}
	}

	onProgress?.({ stage: "building", message: "Building harness..." });
	const outputDir = join(projectCwd, `.harnage-build-${plan.name}`);

	onProgress?.({ stage: "verifying", message: "Verifying build..." });
	let result = await assembleAndVerify(plan, outputDir, context, extraFiles);

	if (!result.success && options?.provider) {
		onProgress?.({ stage: "repairing", message: "Repairing build errors..." });
		const { repairLoop } = await import("./llm/repair");
		const repaired = await repairLoop(
			options.provider,
			plan,
			result,
			outputDir,
			context,
			options.maxRepairs ?? 2,
			onProgress,
		);
		result = { ...repaired.result, repairs: repaired.repairsUsed };
	}

	// ACCEPTANCE: execute the finished harness on the model it was built for.
	// Only meaningful on a successful LLM build — the offline chassis has no
	// build brain to author a domain battery with.
	let acceptance: AcceptanceReport | undefined;
	if (result.success && options?.acceptance !== false && options?.provider) {
		acceptance = await runBuildAcceptance(
			options.provider,
			plan,
			outputDir,
			prompt,
			onProgress,
		);
	}

	onProgress?.({
		stage: result.success ? "done" : "error",
		message: result.success ? "Build complete!" : "Build encountered errors",
	});

	return { ...result, usedLLM, fallbackReason, acceptance };
}

/**
 * Plan a domain battery, run it against the built harness, write the proof into
 * the harness, and advise a stronger model when the score is poor.
 *
 * Every failure path here is non-fatal: the user keeps their build and is told
 * plainly that it wasn't tested, rather than losing the build to a flaky model
 * or an unreachable Ollama.
 */
async function runBuildAcceptance(
	provider: Provider,
	plan: HarnessPlan,
	outputDir: string,
	prompt: string,
	onProgress?: (p: BuildProgress) => void,
): Promise<AcceptanceReport | undefined> {
	const { runGenerateAcceptance } = await import("./llm/acceptance");
	const { runAcceptance, renderAcceptanceMd } = await import(
		"./acceptance-run"
	);
	const { readFile, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");

	onProgress?.({ stage: "verifying", message: "Planning acceptance tasks..." });
	// Size the battery to the model's measured speed, so a slow model still
	// finishes the build instead of spending forty minutes proving a point.
	const { batterySizeFor } = await import("./acceptance-run");
	const want = batterySizeFor(lastMeasuredTurnMs || 3000);
	let tasks: Awaited<ReturnType<typeof runGenerateAcceptance>> = [];
	try {
		tasks = await runGenerateAcceptance(provider, plan, prompt, want);
	} catch (firstErr) {
		// Battery EXECUTION is budgeted by model speed; generation was not, so a
		// slow build brain simply failed. Observed: a local 14B exceeded the
		// 5-minute provider timeout authoring 16 tasks and the build shipped with
		// no acceptance at all. Retry small — a 6-task battery is far better than
		// none, and a fast API brain never reaches this path.
		const { shouldRetrySmaller } = await import("./acceptance-run");
		if (shouldRetrySmaller(firstErr, want)) {
			onProgress?.({
				stage: "verifying",
				message: `Build brain too slow for ${want} tasks — retrying with 6...`,
			});
			try {
				tasks = await runGenerateAcceptance(provider, plan, prompt, 6);
			} catch {
				/* fall through to the shared skip path below */
			}
		}
		if (!tasks.length) {
			onProgress?.({
				stage: "verifying",
				message: "Acceptance skipped — could not plan tasks",
				detail: firstErr instanceof Error ? firstErr.message : String(firstErr),
			});
		}
	}

	const runtime = await resolveAcceptanceProvider(plan);
	if (!runtime) {
		const report: AcceptanceReport = {
			model: plan.defaultLocalModel ?? "unknown",
			tier: "unknown",
			loop: "unknown",
			passed: 0,
			total: 0,
			bar: 0,
			met: false,
			tasks: [],
			skipped:
				"no runtime model reachable (start Ollama, or set a provider with /config)",
		};
		await writeFile(
			join(outputDir, "ACCEPTANCE.md"),
			renderAcceptanceMd(plan.name, report),
		).catch(() => {});
		onProgress?.({
			stage: "verifying",
			message: `Acceptance skipped — ${report.skipped}`,
		});
		return report;
	}

	// Say so plainly when the battery runs on a DIFFERENT model than the harness
	// was built for — it happens whenever the chosen model is not installed, and
	// a score attributed to the wrong model is worse than no score.
	const builtFor = plan.defaultLocalModel;
	const mismatch = builtFor && runtime.model !== builtFor;
	// Say how long this will take before it starts. A build about to spend
	// several minutes executing a battery should announce it rather than look
	// like it has hung — the thoroughness is the point, the silence is not.
	const { estimateBatteryMinutes, retriesFor } = await import(
		"./acceptance-run"
	);
	const mins = estimateBatteryMinutes(tasks.length, lastMeasuredTurnMs || 3000);
	onProgress?.({
		stage: "verifying",
		message: `Acceptance: ${tasks.length} tasks on ${runtime.model} — roughly ${mins} min, up to ~${estimateBatteryMinutes(tasks.length, lastMeasuredTurnMs || 3000, 1 + retriesFor(lastMeasuredTurnMs || 3000))} min if it needs retuning...`,
		detail: mismatch
			? `NOTE: this harness was built for ${builtFor}, which is not installed. Pull it (ollama pull ${builtFor}) and re-run to score the model you will actually use.`
			: undefined,
	});
	let report = await runAcceptance(outputDir, tasks, runtime, (line) =>
		onProgress?.({ stage: "verifying", message: line }),
	);

	// OPTIMIZE: below bar is not the end of the build. Re-run the same battery
	// under scaffolds chosen from HOW it failed, keep the best, and bake the
	// winner into the harness the user receives — so what ships is the scaffold
	// that actually scored highest on their domain, on their model, rather than
	// the one a size tier guessed. This is the difference between a harness that
	// was tested and one that was tuned.
	if (!report.met && !report.skipped) {
		const { optimizeAcceptance } = await import("./acceptance-run");
		onProgress?.({
			stage: "verifying",
			message: `Below bar — retuning the scaffold and re-running...`,
		});
		const { retriesFor } = await import("./acceptance-run");
		const { best, tried } = await optimizeAcceptance(
			outputDir,
			tasks,
			runtime,
			report,
			(line) => onProgress?.({ stage: "verifying", message: line }),
			retriesFor(lastMeasuredTurnMs || 3000),
		);
		if (best.passed > report.passed && best.profile) {
			// Persist the winner: rewrite profiles.ts so the delivered harness runs
			// under the scaffold that measured best, not the one it was built with.
			const merged = {
				...(plan.modelProfileOverrides ?? {}),
				[runtime.model.toLowerCase()]: {
					...((plan.modelProfileOverrides ?? {})[runtime.model.toLowerCase()] as
						| Record<string, unknown>
						| undefined),
					...best.profile,
				},
			};
			plan.modelProfileOverrides = merged;
			try {
				const { HARNESS_PROFILES } = await import(
					"./assemble/harness-templates"
				);
				const profilesPath = join(outputDir, "src", "profiles.ts");
				const previous = await readFile(profilesPath, "utf-8");
				await writeFile(profilesPath, HARNESS_PROFILES(merged, plan.name));

				// This write happens AFTER verifyBuild, so nothing else would catch a
				// malformed rewrite — the user would receive a harness that no longer
				// compiles, tuned into uselessness. Re-verify, and roll back to the
				// version that was known good rather than ship a broken one.
				const { verifyBuild } = await import("./assemble");
				const recheck = await verifyBuild(outputDir, { skipInstall: true });
				if (!recheck.success) {
					await writeFile(profilesPath, previous);
					onProgress?.({
						stage: "verifying",
						message:
							"Tuned scaffold did not compile — reverted to the verified default",
						detail: recheck.errors.join(" | ").slice(0, 200),
					});
				} else {
					onProgress?.({
						stage: "verifying",
						message: `Baked the winning scaffold into the harness (${report.passed}/${report.total} → ${best.passed}/${best.total} after ${tried} retry(s))`,
					});
				}
			} catch (err) {
				onProgress?.({
					stage: "verifying",
					message:
						"Could not persist the tuned scaffold — shipping the default",
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		}
		report = best;
	}

	await writeFile(
		join(outputDir, "ACCEPTANCE.md"),
		renderAcceptanceMd(plan.name, report),
	).catch(() => {});
	await writeFile(
		join(outputDir, "acceptance.json"),
		JSON.stringify({ ...report, ts: new Date().toISOString() }, null, 2),
	).catch(() => {});
	persistAcceptance(plan, report);

	if (!report.skipped) {
		onProgress?.({
			stage: "verifying",
			message: `Acceptance: ${report.passed}/${report.total} — bar ${report.bar}/${report.total} for ${report.tier} tier → ${report.met ? "MET" : "BELOW BAR"}${report.errored ? ` (${report.errored} skipped: provider error)` : ""}`,
			detail: report.met ? undefined : strongerModelAdvice(plan, report),
		});
	}
	return report;
}

/** The model the harness will actually run on: its baked local model if Ollama
 *  has it, else the saved build brain. Undefined when nothing is reachable. */
async function resolveAcceptanceProvider(plan: HarnessPlan): Promise<
	| {
			type: string;
			model: string;
			baseUrl?: string;
			apiKey?: string;
			maxTokens?: number;
			contextTokens?: number;
	  }
	| undefined
> {
	const baseUrl = "http://localhost:11434";
	if (plan.defaultLocalModel) {
		try {
			const res = await fetch(`${baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(2000),
			});
			const { models } = (await res.json()) as {
				models?: Array<{ name: string }>;
			};
			if (models?.some((m) => m.name === plan.defaultLocalModel)) {
				return {
					type: "ollama",
					model: plan.defaultLocalModel,
					baseUrl,
					maxTokens: 4096,
					contextTokens: 8192,
				};
			}
		} catch {
			/* ollama not running — fall through to the saved brain */
		}
	}
	try {
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		const { readFileSync } = await import("node:fs");
		const cfg = JSON.parse(
			readFileSync(join(homedir(), ".harnage", "config.json"), "utf-8"),
		) as Record<string, unknown>;
		if (typeof cfg.model === "string" && typeof cfg.type === "string") {
			return {
				...cfg,
				type: cfg.type,
				model: cfg.model,
				contextTokens: 8192,
			};
		}
	} catch {
		/* no saved config */
	}
	return undefined;
}

/** A poor score is usually the model, not the harness — name the next one up. */
function strongerModelAdvice(
	plan: HarnessPlan,
	report: AcceptanceReport,
): string {
	const failed = report.tasks
		.filter((t) => !t.pass)
		.map((t) => t.id)
		.join(", ");
	const domain = classifyDomain(plan.description);
	const bigger = recommendModels(domain, 64)
		.filter((r) => r.id !== report.model)
		.slice(0, 2)
		.map((r) => `${r.id} (~${r.ramGb}GB)`)
		.join(" or ");
	return `failed: ${failed}. A stronger model on this same harness usually clears the bar${bigger ? ` — try ${bigger}` : ""}.`;
}

function persistAcceptance(plan: HarnessPlan, report: AcceptanceReport): void {
	if (report.skipped) return;
	try {
		const ts = new Date().toISOString();
		const rows = report.tasks
			// Infra errors are not measurements — keeping them out of the moat file
			// stops a rate-limited afternoon looking like a model regression later.
			.filter((t) => !t.errored)
			.map((t) =>
				JSON.stringify({
					ts,
					kind: "acceptance",
					harness: plan.name,
					model: report.model,
					tier: report.tier,
					loop: report.loop,
					task: t.id,
					pass: t.pass,
					ms: t.ms,
				}),
			)
			.join("\n");
		if (!rows) return;
		const dir = join(homedir(), ".harnage");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "eval-results.jsonl"), `${rows}\n`);
	} catch {
		/* best-effort — never fail a build on telemetry */
	}
}
