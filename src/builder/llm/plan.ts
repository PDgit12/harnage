import type { Provider } from "../../services/api/client";
import {
	buildSystemPrompt,
	DEFAULT_BLOCKS,
} from "../../services/system-prompt";
import type { HarnessPlan } from "../index";
import type { ProjectContext } from "../spec/context";
import { completeJSON } from "./client";
import { KNOWN_TOOLS } from "./interview";
import { type LLMSpec, PlanSchema } from "./schemas";

const ALWAYS_TOOLS = [
	"bash",
	"file_read",
	"glob",
	"grep",
	"file_edit",
	"file_write",
];

const PLAN_EXAMPLE = `{
  "name": "code-review-agent",
  "description": "Reviews TypeScript pull requests",
  "tools": ["bash", "file_read", "grep", "glob"],
  "commands": ["help", "clear", "exit", "model", "review"],
  "providers": ["ollama"],
  "systemPrompt": "You are a code review agent. Your goal is to review TypeScript pull requests for bugs, style issues, and security problems. Use your tools to read files, search code, and run checks. Always verify claims by running commands. Report findings concisely with file:line references.",
  "hasMcp": false,
  "pipeline": [
    { "name": "locate", "instruction": "List the changed TypeScript files", "tool": "glob" },
    { "name": "read", "instruction": "Read each changed file", "tool": "file_read" },
    { "name": "check", "instruction": "Run the type checker and tests", "tool": "bash" },
    { "name": "report", "instruction": "Summarize findings with file:line references" }
  ]
}`;

/**
 * PLAN stage: LLM turns a validated spec into a HarnessPlan. Model output is
 * post-processed deterministically — never trust the model for invariants.
 */
export async function runLLMPlan(
	provider: Provider,
	spec: LLMSpec,
	_projectContext?: ProjectContext,
): Promise<HarnessPlan> {
	const prompt = `You are the planner for harnage. Given this validated spec, produce a harness plan.
Spec:
${JSON.stringify(spec, null, 2)}
Constraints:
- tools must be chosen from: ${KNOWN_TOOLS.join(", ")}
- name: lowercase kebab-case, max 30 chars
- systemPrompt: write the COMPLETE system prompt the generated agent will run with — identity, goal, tool usage rules, safety rules, output style. Ground it in the purpose${spec.domainKnowledge ? " and domainKnowledge" : ""}, name the agent's domain concretely, and reference its actual tools${spec.customTools?.length ? " (including the custom ones: " + spec.customTools.map((t) => t.name).join(", ") + ")" : ""} and workflows by name so the identity is specific to THIS agent, not generic.
- pipeline: 3-6 ordered stages a SMALL local model can execute to accomplish this harness's core domain task (e.g. glob files -> count by extension -> read key files -> report). Each stage: name, a one-line instruction, and optionally a single tool from the tools list. This lets a 3B model beat a naive large-model loop on this niche.
- customCommands: bespoke slash commands specific to THIS agent's domain (name, description, behavior in prose). Only real, useful ones — the base commands (/help /clear /model /cost /config /doctor) are always present, do NOT repeat them.
- customSkills: domain procedural recipes (name, trigger phrase, guidance prose) teaching the agent how to do this harness's core workflows.
Example output:
${PLAN_EXAMPLE}
Respond with ONLY a JSON object in that shape.`;

	const raw = await completeJSON(provider, prompt, PlanSchema);

	// Deterministic post-processing: enforce invariants the model can't be
	// trusted with.
	const known = new Set(KNOWN_TOOLS);
	const tools = [
		...new Set([...ALWAYS_TOOLS, ...raw.tools.filter((t) => known.has(t))]),
	];

	const name =
		raw.name
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, 30) || "agent-harness";

	const commands = [
		...new Set(
			raw.commands.map((c) => c.replace(/^\//, "").replace(/-/g, "_")),
		),
	];

	const providers = [...new Set([...raw.providers, ...spec.models])];

	const systemPrompt =
		raw.systemPrompt.trim().length >= 50
			? raw.systemPrompt
			: buildSystemPrompt(DEFAULT_BLOCKS, {
					name,
					description: spec.purpose,
					tools,
					commands,
				});

	// Pipeline stages steer the small-model tier; a stage tool must be one the
	// harness actually ships, else drop the reference (stage still runs toolless).
	const toolSet = new Set(tools);
	const pipeline = raw.pipeline?.slice(0, 6).map((s) => ({
		name: s.name,
		instruction: s.instruction,
		tool: s.tool && toolSet.has(s.tool) ? s.tool : undefined,
	}));

	// Bespoke commands + skills: carry the LLM's plan through to generation.
	// Names are sanitized to the same id shape the generators use.
	const cmdId = (n: string) =>
		n
			.toLowerCase()
			.replace(/^\//, "")
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 30);
	const baseCmds = new Set([
		"help",
		"clear",
		"model",
		"cost",
		"config",
		"doctor",
		"exit",
	]);
	const customCommands = (raw.customCommands ?? [])
		.map((c) => ({ ...c, name: cmdId(c.name) }))
		.filter((c) => c.name && !baseCmds.has(c.name));
	const customSkills = (raw.customSkills ?? spec.customSkills ?? []).filter(
		(s) => s.name && s.guidance,
	);

	return {
		name,
		description: raw.description.slice(0, 80),
		tools,
		commands,
		providers,
		systemPrompt,
		hasMcp: raw.hasMcp || tools.includes("mcp"),
		...(pipeline?.length ? { pipeline } : {}),
		...(customCommands.length ? { customCommands } : {}),
		...(customSkills.length ? { customSkills } : {}),
		config: {
			maxIterations: clampInt(raw.config?.maxIterations, 1, 100, 20),
			memory: raw.config?.memory ?? true,
			eval: raw.config?.eval ?? true,
			judgeByDefault: raw.config?.judgeByDefault ?? false,
		},
	};
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
