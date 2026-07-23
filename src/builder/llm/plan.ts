import type { Provider } from "../../services/api/client";
import { buildAgentSystemPrompt } from "../../services/system-prompt";
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
  "hasMcp": false,
  "config": { "maxIterations": 20, "memory": true, "eval": true, "judgeByDefault": false }
}`;

const COMMANDS_EXAMPLE = `{
  "commands": [
    { "name": "review", "description": "Review the current PR diff for bugs and style issues", "behavior": "Run git diff against the base branch, read each changed file, and report findings as file:line comments." },
    { "name": "severity", "description": "Re-rank open findings by severity", "behavior": "Re-read the last review output and sort findings into critical/major/minor buckets." }
  ]
}`;

const SKILLS_EXAMPLE = `{
  "skills": [
    { "name": "diff-review", "trigger": "review this PR / check this diff", "guidance": "1. Run git diff to see changed lines. 2. Read each changed file for full context. 3. Check for bugs, security issues, and style deviations. 4. Report findings as file:line with a one-line fix suggestion." }
  ]
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
	// Compose the system prompt from the REAL plan data (correct tool names,
	// domain-grounded, grounding rules) instead of trusting the build model's
	// free-written core.systemPrompt — that freeform prompt was the single
	// biggest source of generic/flaky generated agents. The harness provides
	// the structure; the model only ever contributed purpose/domainKnowledge.
	const systemPrompt = buildAgentSystemPrompt({
		name,
		purpose: spec.purpose,
		domainKnowledge: spec.domainKnowledge,
		tools,
	});
	const config = {
		maxIterations: clampInt(core.config?.maxIterations, 1, 100, 20),
		memory: core.config?.memory ?? true,
		eval: core.config?.eval ?? true,
		judgeByDefault: core.config?.judgeByDefault ?? false,
	};

	const plan: HarnessPlan = {
		name,
		description: sanitizeDescription(core.description).slice(0, 80),
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
			const commandsPrompt = `For the harness "${plan.description}", list up to 4 bespoke slash commands specific to its domain (NOT the base ones: help, clear, model, cost, config, doctor, exit). Each: name, description, behavior (prose).
Example output:
${COMMANDS_EXAMPLE}
Respond with ONLY a JSON object in that shape. The "commands" array must be non-empty — this harness's domain always supports at least one bespoke command.`;
			try {
				let { commands: raw } = await completeJSON(
					provider,
					commandsPrompt,
					CommandsPlanSchema,
				);
				if (raw.length === 0) {
					({ commands: raw } = await completeJSON(
						provider,
						`${commandsPrompt}\nYour previous answer returned an empty "commands" array — that is not acceptable. This harness is for the domain "${plan.description}". Name at least 1 concrete, domain-specific slash command it needs.`,
						CommandsPlanSchema,
					));
				}
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
			const skillsPrompt = `For the harness "${plan.description}", list up to 3 domain skills (procedural recipes teaching the agent how to do its core workflows). Each: name, trigger phrase, guidance (prose steps).
Example output:
${SKILLS_EXAMPLE}
Respond with ONLY a JSON object in that shape. The "skills" array must be non-empty — this harness's domain always has at least one core workflow worth documenting.`;
			try {
				let { skills: raw } = await completeJSON(
					provider,
					skillsPrompt,
					SkillsPlanSchema,
				);
				if (raw.length === 0) {
					({ skills: raw } = await completeJSON(
						provider,
						`${skillsPrompt}\nYour previous answer returned an empty "skills" array — that is not acceptable. This harness is for the domain "${plan.description}". Name at least 1 concrete, domain-specific skill it needs.`,
						SkillsPlanSchema,
					));
				}
				const custom = raw.filter((s) => s.name && s.guidance);
				if (custom.length) plan.customSkills = custom;
			} catch {
				/* no custom skills */
			}
		})(),
	]);

	return plan;
}

/**
 * Description flows verbatim into generated source (program.description(...),
 * the TUI banner) — strip characters that could break or inject into those
 * string/template literals. Mirrors the name sanitizer above, but doesn't
 * need to restrict to [a-z0-9-] since it's not an identifier.
 */
function sanitizeDescription(s: string): string {
	return s
		.replace(/`/g, "'")
		.replace(/"/g, "'")
		.replace(/\$\{/g, "")
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		.trim();
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
