import { join } from "node:path";
import type { Provider } from "../services/api/client";
import { buildSystemPrompt, DEFAULT_BLOCKS } from "../services/system-prompt";
import type { BuildResult } from "./assemble";
import { assembleAndVerify } from "./assemble";
import type { AskFn } from "./llm/interview";
import {
	catalogOverrides,
	classifyDomain,
	maxParamsForRam,
	recommendModels,
} from "./models/catalog";
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
	/** Per-model scaffold overrides baked into profiles.ts (keyed by model id). */
	modelProfileOverrides?: Record<string, unknown>;
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
		systemPrompt: buildSystemPrompt(DEFAULT_BLOCKS, {
			name,
			description: spec.purpose,
			tools: spec.tools,
			commands: spec.commands,
		}),
		hasMcp,
	};
}

async function llmPlan(
	provider: Provider,
	prompt: string,
	context: Awaited<ReturnType<typeof analyzeProject>>,
	ask: AskFn | undefined,
	onProgress?: (progress: BuildProgress) => void,
): Promise<{
	plan: HarnessPlan;
	spec: import("./llm/schemas").LLMSpec;
} | null> {
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
		onProgress?.({
			stage: "analyzing",
			message: "LLM unavailable, using offline analysis",
			detail: err instanceof Error ? err.message : String(err),
		});
		return null;
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
	if (options?.provider) {
		const llm = await llmPlan(
			options.provider,
			prompt,
			context,
			options.ask,
			onProgress,
		);
		if (llm) {
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
						const answer = await options.ask(
							`Recommended models for a ${domain} agent on ${Math.round(ramGb)}GB RAM:\n${menu}\n  Pick a number or model name`,
							def,
						);
						const num = Number.parseInt(answer.trim(), 10);
						plan.defaultLocalModel =
							Number.isFinite(num) && num >= 1 && num <= recs.length
								? recs[num - 1].id
								: answer.trim() || def;
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

	// Bake the chosen model's curated scaffold overrides (catalog models only)
	// into profiles.ts — per-model tuning, not just size-tier.
	if (plan.defaultLocalModel) {
		const ov = catalogOverrides(plan.defaultLocalModel);
		if (ov)
			plan.modelProfileOverrides = {
				[plan.defaultLocalModel.toLowerCase()]: ov,
			};
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

	onProgress?.({
		stage: result.success ? "done" : "error",
		message: result.success ? "Build complete!" : "Build encountered errors",
	});

	return result;
}
