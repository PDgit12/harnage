import type { Provider } from "../../services/api/client";
import {
	buildSystemPrompt,
	DEFAULT_BLOCKS,
} from "../../services/system-prompt";
import type { HarnessPlan } from "../index";
import type { ProjectContext } from "../spec/context";
import { completeJSON } from "./client";
import { KNOWN_TOOLS } from "./interview";
import {
	CommandsPlanSchema,
	CorePlanSchema,
	type LLMSpec,
	PipelinePlanSchema,
	SkillsPlanSchema,
} from "./schemas";

const ALWAYS_TOOLS = [
	"bash",
	"file_read",
	"glob",
	"grep",
	"file_edit",
	"file_write",
];

const CORE_EXAMPLE = `{
  "name": "code-review-agent",
  "description": "Reviews TypeScript pull requests",
  "tools": ["bash", "file_read", "grep", "glob"],
  "commands": ["help", "clear", "review"],
  "systemPrompt": "You are a code review agent. Review TypeScript pull requests for bugs, style, and security. Use your tools to read files, search code, and run checks. Verify claims by running commands. Report findings concisely with file:line references.",
  "hasMcp": false,
  "config": { "maxIterations": 20, "memory": true, "eval": true, "judgeByDefault": false }
}`;

/**
 * PLAN stage. Split into a small CORE call every build brain can handle, then
 * optional best-effort enrichment calls (pipeline, custom commands, custom
 * skills). A weak local model fails at one wide JSON object but nails narrow
 * ones, and any enrichment can fail without losing the core bespoke plan.
 * Model output is post-processed deterministically — never trust it for
 * invariants.
 */
export async function runLLMPlan(
	provider: Provider,
	spec: LLMSpec,
	_projectContext?: ProjectContext,
): Promise<HarnessPlan> {
	const corePrompt = `You are the planner for harnage. Given this validated spec, produce the CORE harness plan.
Spec:
${JSON.stringify(spec, null, 2)}
Constraints:
- tools must be chosen from: ${KNOWN_TOOLS.join(", ")}
- name: lowercase kebab-case, max 30 chars
- systemPrompt: write the COMPLETE system prompt the generated agent will run with — identity, goal, tool-usage rules, safety rules, output style. Ground it in the purpose${spec.domainKnowledge ? " and domainKnowledge" : ""}, name the domain concretely, and reference the actual tools by name so the identity is specific to THIS agent.
- config: pick sane per-domain chassis knobs (maxIterations 1-100, memory/eval booleans, judgeByDefault).
Example output:
${CORE_EXAMPLE}
Respond with ONLY a JSON object in that shape.`;

	const core = await completeJSON(provider, corePrompt, CorePlanSchema);

	// Deterministic post-processing: enforce invariants the model can't be
	// trusted with.
	const known = new Set(KNOWN_TOOLS);
	const tools = [
		...new Set([...ALWAYS_TOOLS, ...core.tools.filter((t) => known.has(t))]),
	];
	const name =
		core.name
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, 30) || "agent-harness";
	const commands = [
		...new Set(
			core.commands.map((c) => c.replace(/^\//, "").replace(/-/g, "_")),
		),
	];
	const providers = [...new Set(spec.models)];
	const systemPrompt =
		core.systemPrompt.trim().length >= 50
			? core.systemPrompt
			: buildSystemPrompt(DEFAULT_BLOCKS, {
					name,
					description: spec.purpose,
					tools,
					commands,
				});
	const config = {
		maxIterations: clampInt(core.config?.maxIterations, 1, 100, 20),
		memory: core.config?.memory ?? true,
		eval: core.config?.eval ?? true,
		judgeByDefault: core.config?.judgeByDefault ?? false,
	};

	const plan: HarnessPlan = {
		name,
		description: core.description.slice(0, 80),
		tools,
		commands,
		providers,
		systemPrompt,
		hasMcp: core.hasMcp || tools.includes("mcp"),
		config,
	};

	// --- Optional enrichment calls (best-effort; a failure just skips it) ---
	// Independent and fired in PARALLEL: slow build brains (reasoning models like
	// hy3 spend ~90s/call) would otherwise serialize 3 calls into minutes. Each
	// helper swallows its own error so any one can fail without losing the others.
	const toolSet = new Set(tools);
	const baseCmds = new Set([
		"help",
		"clear",
		"model",
		"cost",
		"config",
		"doctor",
		"exit",
	]);

	await Promise.all([
		// Pipeline: ordered stages a SMALL local model can execute for the core task.
		(async () => {
			try {
				const { pipeline } = await completeJSON(
					provider,
					`For the harness "${plan.description}", output 3-6 ordered stages a small local model executes to accomplish its core task (e.g. glob files -> read -> check -> report). Each stage: name, one-line instruction, optionally one tool from: ${tools.join(", ")}. Respond ONLY as JSON {"pipeline":[{"name","instruction","tool"?}]}.`,
					PipelinePlanSchema,
				);
				const stages = pipeline.slice(0, 6).map((s) => ({
					name: s.name,
					instruction: s.instruction,
					tool: s.tool && toolSet.has(s.tool) ? s.tool : undefined,
				}));
				if (stages.length) plan.pipeline = stages;
			} catch {
				/* no pipeline — engine falls back to the constrained-json decision loop */
			}
		})(),
		// Bespoke slash commands.
		(async () => {
			try {
				const { commands: raw } = await completeJSON(
					provider,
					`For the harness "${plan.description}", list up to 4 bespoke slash commands specific to its domain (NOT the base ones: help, clear, model, cost, config, doctor, exit). Each: name, description, behavior (prose). Respond ONLY as JSON {"commands":[{"name","description","behavior"}]}.`,
					CommandsPlanSchema,
				);
				const custom = raw
					.map((c) => ({ ...c, name: cmdId(c.name) }))
					.filter((c) => c.name && !baseCmds.has(c.name));
				if (custom.length) plan.customCommands = custom;
			} catch {
				/* no custom commands */
			}
		})(),
		// Bespoke skills (procedural memory).
		(async () => {
			try {
				const { skills } = await completeJSON(
					provider,
					`For the harness "${plan.description}", list up to 3 domain skills (procedural recipes teaching the agent how to do its core workflows). Each: name, trigger phrase, guidance (prose steps). Respond ONLY as JSON {"skills":[{"name","trigger","guidance"}]}.`,
					SkillsPlanSchema,
				);
				const custom = skills.filter((s) => s.name && s.guidance);
				if (custom.length) plan.customSkills = custom;
			} catch {
				/* no custom skills */
			}
		})(),
	]);

	return plan;
}

function cmdId(n: string): string {
	return n
		.toLowerCase()
		.replace(/^\//, "")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 30);
}

/** Clamp an optional model-provided integer into a safe range with a default. */
function clampInt(
	v: number | undefined,
	min: number,
	max: number,
	fallback: number,
): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(min, Math.round(v)));
}
