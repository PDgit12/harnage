import type { Provider } from "../../services/api/client";
import type { ProjectContext } from "../spec/context";
import { completeJSON } from "./client";
import { InterviewQuestionsSchema, type LLMSpec, SpecSchema } from "./schemas";

export type AskFn = (
	question: string,
	defaultAnswer: string,
) => Promise<string>;

export interface InterviewOptions {
	ask?: AskFn;
	projectContext?: ProjectContext;
}

export const KNOWN_TOOLS = [
	"bash",
	"file_read",
	"file_write",
	"file_edit",
	"glob",
	"grep",
	"web_fetch",
	"web_search",
	"agent",
	"mcp",
];

const SPEC_EXAMPLE = `{
  "name": "code-review-agent",
  "purpose": "Reviews TypeScript pull requests for bugs and style issues",
  "language": ["typescript"],
  "tools": ["bash", "file_read", "grep", "glob"],
  "commands": ["/help", "/clear", "/exit", "/model", "/review"],
  "models": ["ollama"],
  "domainKnowledge": "Focus on type safety, async correctness, and security."
}`;

function contextSummary(ctx?: ProjectContext): string {
	if (!ctx) return "none";
	const parts = [
		ctx.languages.length ? `languages: ${ctx.languages.join(", ")}` : "",
		ctx.hasPackageJson ? "has package.json" : "",
		ctx.hasGit ? "git repo" : "",
	].filter(Boolean);
	return parts.length ? parts.join("; ") : "none";
}

/**
 * INTERVIEW stage: optionally ask the model for clarifying questions
 * (answered interactively via `ask`, or by their default answers), then
 * produce a validated LLMSpec. Spec-first: never one-shot a vague prompt.
 */
export async function runInterview(
	provider: Provider,
	prompt: string,
	opts?: InterviewOptions,
): Promise<LLMSpec> {
	const ctx = contextSummary(opts?.projectContext);

	const questionsPrompt = `You are a requirements analyst for AgentForge, which builds autonomous AI agent harnesses (agents that use tools, follow goals, run in a loop).
User request: "${prompt}"
Project context: ${ctx}
If the request is specific enough to build from, reply {"ready": true, "questions": []}.
Otherwise list at most 3 clarifying questions, each with a sensible defaultAnswer.
Respond with ONLY JSON matching: {"ready": boolean, "questions": [{"question": string, "defaultAnswer": string}]}`;

	const interview = await completeJSON(
		provider,
		questionsPrompt,
		InterviewQuestionsSchema,
	);

	const clarifications: Array<{ question: string; answer: string }> = [];
	if (!interview.ready) {
		for (const q of interview.questions) {
			const answer = opts?.ask
				? (await opts.ask(q.question, q.defaultAnswer)) || q.defaultAnswer
				: q.defaultAnswer;
			clarifications.push({ question: q.question, answer });
		}
	}

	const qaBlock = clarifications.length
		? `Clarifications:\n${clarifications.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n")}\n`
		: "";

	const specPrompt = `You are the spec writer for AgentForge. Turn this request into a structured agent spec.
User request: "${prompt}"
${qaBlock}Project context: ${ctx}
Rules:
- tools MUST come from this list: ${KNOWN_TOOLS.join(", ")}. Anything beyond it goes in customTools as {name, description}.
- commands are slash commands; always include /help, /clear, /exit, /model.
- models: which providers this agent should support, from: ollama, anthropic, openai.
Example output:
${SPEC_EXAMPLE}
Respond with ONLY a JSON object in that shape.`;

	const spec = await completeJSON(provider, specPrompt, SpecSchema);

	if (clarifications.length && !spec.clarifications) {
		spec.clarifications = clarifications;
	}
	return spec;
}
