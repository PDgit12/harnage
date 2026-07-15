import { z } from "zod";

/**
 * LLM-stage schemas for builder v2. Every LLM call returns JSON validated
 * against one of these; invalid output is re-prompted with the Zod error.
 */

export const SpecSchema = z.object({
	name: z.string().min(1).describe("short kebab-friendly agent name"),
	purpose: z.string().min(1).describe("one-sentence agent purpose"),
	language: z.array(z.string()).default(["typescript"]),
	tools: z
		.array(z.string())
		.describe("tool ids, e.g. bash, file_read, grep, mcp"),
	commands: z.array(z.string()).describe("slash commands like /help"),
	models: z.array(z.enum(["ollama", "anthropic", "openai"])).min(1),
	clarifications: z
		.array(z.object({ question: z.string(), answer: z.string() }))
		.optional(),
	domainKnowledge: z.string().optional(),
	customTools: z
		.array(z.object({ name: z.string(), description: z.string() }))
		.optional(),
	customSkills: z
		.array(
			z.object({
				name: z.string(),
				trigger: z.string().describe("phrase that should activate this skill"),
				guidance: z.string().describe("the procedural recipe, in prose"),
			}),
		)
		.optional()
		.describe("domain-specific procedural recipes (how the agent should act)"),
});
export type LLMSpec = z.infer<typeof SpecSchema>;

export const InterviewQuestionsSchema = z.object({
	ready: z
		.boolean()
		.describe("true if the prompt is unambiguous enough to spec"),
	questions: z
		.array(
			z.object({
				question: z.string(),
				defaultAnswer: z
					.string()
					.describe("assumed answer if the user is not available"),
			}),
		)
		.max(3),
});
export type InterviewQuestions = z.infer<typeof InterviewQuestionsSchema>;

export const PlanSchema = z.object({
	name: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.max(30),
	description: z.string().max(80),
	tools: z.array(z.string()).min(1),
	toolRationale: z.record(z.string(), z.string()).optional(),
	commands: z.array(z.string()),
	customCommands: z
		.array(
			z.object({
				name: z.string(),
				description: z.string(),
				behavior: z.string().describe("what the command should do, in prose"),
			}),
		)
		.optional(),
	customSkills: z
		.array(
			z.object({
				name: z.string(),
				trigger: z.string().describe("phrase that should activate this skill"),
				guidance: z.string().describe("the procedural recipe, in prose"),
			}),
		)
		.optional(),
	providers: z.array(z.string()).min(1),
	systemPrompt: z
		.string()
		.min(50)
		.describe("full custom system prompt for the generated agent"),
	hasMcp: z.boolean(),
	pipeline: z
		.array(
			z.object({
				name: z.string(),
				instruction: z.string(),
				tool: z.string().optional(),
			}),
		)
		.max(6)
		.optional()
		.describe(
			"ordered domain stages small local models execute, e.g. glob->count->read->report",
		),
});
export type LLMPlan = z.infer<typeof PlanSchema>;

// `analysis` first on purpose: JSON key order steers generation, and a short
// diagnosis before patching measurably improves small-model patch quality.
export const RepairPatchSchema = z.object({
	analysis: z.string().describe("one-paragraph diagnosis of the errors"),
	patches: z
		.array(
			z.object({
				path: z.string().describe("relative path within the output directory"),
				newContent: z.string().describe("FULL replacement file content"),
			}),
		)
		.min(1)
		.max(6),
});
export type RepairPatch = z.infer<typeof RepairPatchSchema>;
