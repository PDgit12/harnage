import { join } from "node:path";
import type { Provider } from "../services/api/client";
import { buildSystemPrompt, DEFAULT_BLOCKS } from "../services/system-prompt";
import type { BuildResult } from "./assemble";
import { assembleAndVerify } from "./assemble";
import type { AskFn } from "./llm/interview";
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
	/** Baked domain pipeline stages for the small-model tier (Engine v3). */
	pipeline?: Array<{ name: string; instruction: string; tool?: string }>;
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
		description: spec.purpose.slice(0, 80),
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
				if (candidates.length) {
					// Speed-first caps, not fits-in-RAM: 16GB→8B, 32GB→14B, 64GB→33B, 96GB+→70B.
					const { totalmem } = await import("node:os");
					const ramGb = totalmem() / 1024 ** 3;
					const maxParams =
						ramGb >= 96
							? 70
							: ramGb >= 64
								? 33
								: ramGb >= 32
									? 14
									: ramGb >= 16
										? 8
										: 4;
					const fitting = candidates.filter((m) => size(m) <= maxParams);
					const pool = fitting.length ? fitting : candidates;
					const bySize = [...pool].sort((a, b) => size(b) - size(a));
					const names = candidates.map((m) => m.name);
					if (options?.ask) {
						const answer = await options.ask(
							`Which local model should this harness default to? (usable on ${Math.round(ramGb)}GB RAM: ${pool.map((m) => m.name).join(", ")})`,
							bySize[0].name,
						);
						plan.defaultLocalModel = names.includes(answer)
							? answer
							: bySize[0].name;
					} else {
						plan.defaultLocalModel = bySize[0].name;
					}
				}
			}
		} catch {
			/* offline or no ollama — generated harness keeps its generic default */
		}
	}

	onProgress?.({ stage: "building", message: "Building harness..." });
	const outputDir = join(projectCwd, `.agentforge-build-${plan.name}`);

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
