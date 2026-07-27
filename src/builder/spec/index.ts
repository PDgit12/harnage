import { BASELINE_TOOLS } from "../models/catalog";
import type { ProjectContext } from "./context";

export interface StructuredSpec {
	name: string;
	purpose: string;
	language: string[];
	tools: string[];
	commands: string[];
	models: Array<"ollama" | "anthropic" | "openai">;
}

// Baseline toolset is shared with the LLM path (models/catalog.ts) so both
// produce the same capability set; TOOL_TRIGGERS below only ADD to it.

const LANGUAGE_MAP: [string[], string][] = [
	[["python", "flask", "django", "pip", "pytest"], "python"],
	[
		["react", "next", "typescript", "node", "javascript", "npm", "yarn", "tsx"],
		"typescript",
	],
	[["rust", "cargo", "clippy"], "rust"],
	[["go", "golang", "mod"], "go"],
	[["java", "spring", "maven", "gradle"], "java"],
	[["ruby", "rails", "gem"], "ruby"],
];

const COMMAND_TRIGGERS: [string[], string[]][] = [
	[["help", "docs", "usage"], ["/help"]],
	[["clear", "clean"], ["/clear"]],
	[["exit", "quit"], ["/exit"]],
	[["model", "provider"], ["/model"]],
];

// The offline keyword path has no LLM to infer tool needs from prose, so a
// prompt like "research assistant that can search the web" was silently
// generating a harness with only the baseline tools — no web capability at all.
// Mirrors LANGUAGE_MAP/COMMAND_TRIGGERS: match() does whole-word matching, so
// these are additive (a prompt can trigger both).
const TOOL_TRIGGERS: [string[], string[]][] = [
	[
		[
			"search",
			"google",
			"browse the web",
			"internet search",
			"search engine",
			"research",
			"news",
			"lookup",
		],
		["web_search"],
	],
	[
		[
			"fetch",
			"scrape",
			"crawl",
			"webpage",
			"web page",
			"download a page",
			"monitor",
		],
		["web_fetch"],
	],
];

function match(prompt: string, keywords: string[]): boolean {
	const lower = prompt.toLowerCase();
	return keywords.some((k) => {
		const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`\\b${escaped}\\b`).test(lower);
	});
}

const NON_AGENT_PATTERNS = [
	/\btodo\b/i,
	/\bcrud\b/i,
	/\becommerce?\b/i,
	/\bshopping?\b/i,
	/\bstore\b/i,
	/\bblog\b/i,
	/\blanding page\b/i,
	/\bportfolio\b/i,
	/\bsocial media\b/i,
	/\bchat app\b/i,
	/\bmessaging\b/i,
	/\bcalculator\b/i,
	/\bweather\b/i,
];

const AGENT_KEYWORDS = [
	"agent",
	"assistant",
	"bot",
	"harness",
	"tool",
	"automate",
	"workflow",
	"pipeline",
	"review",
	"monitor",
	"watch",
	"notify",
	"search",
	"fetch",
	"analyze",
	"summarize",
	"extract",
	"convert",
	"translate",
	"generate",
	"scrape",
	"crawl",
	"test",
	"debug",
	"format",
	"lint",
	"deploy",
	"backup",
	"sync",
	"organize",
	"classify",
	"audit",
	"track",
	"manage",
	"process",
	"parse",
	"validate",
];

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

export function validateAgentPrompt(prompt: string): void {
	const lower = prompt.trim().toLowerCase();

	// Reject only genuinely empty input — a task description IS a valid agent
	// request. The old keyword-whitelist ("must contain agent/bot/analyze/…")
	// rejected perfectly valid harnesses whose verb wasn't on the list
	// (triage, rank, categorize, draft, schedule, …) — a whack-a-mole
	// gatekeeper that blocked real builds. Be permissive; the interview/spec
	// stage shapes vague input, it doesn't need a magic word.
	if (lower.split(/\s+/).filter(Boolean).length < 2) {
		throw new ValidationError(
			`"${prompt}" is too short to build from. Describe what the agent should do, e.g. "triage customer support tickets by urgency" or "review pull requests for bugs".`,
		);
	}

	// The one real guard: a bare app/product request with NO agent framing
	// ("a todo app", "an ecommerce store") isn't an agent. But an agent-framed
	// version of the same domain ("an agent that drafts blog posts") is fine,
	// so only reject when there's no agent keyword anywhere.
	const hasAgentKeyword = AGENT_KEYWORDS.some((k) => lower.includes(k));
	if (!hasAgentKeyword) {
		for (const pattern of NON_AGENT_PATTERNS) {
			if (pattern.test(lower)) {
				throw new ValidationError(
					`"${prompt}" reads like a general app, not an AI agent. ` +
						"harnage builds autonomous agents that use tools, follow goals, and run in a loop.\n\n" +
						"Try describing what the agent should DO, e.g.:\n" +
						'- "An agent that manages TODO tasks through file operations"\n' +
						'- "An agent that monitors my store\'s reviews and flags issues"',
				);
			}
		}
	}
}

export function parseIntent(
	prompt: string,
	projectContext?: ProjectContext,
): StructuredSpec {
	const lower = prompt.toLowerCase();
	const tools = new Set(BASELINE_TOOLS);
	const commands = new Set<string>(["/help", "/clear", "/exit", "/model"]);

	for (const [triggers, extras] of COMMAND_TRIGGERS) {
		if (match(lower, triggers)) for (const c of extras) commands.add(c);
	}

	for (const [triggers, extras] of TOOL_TRIGGERS) {
		if (match(lower, triggers)) for (const t of extras) tools.add(t);
	}

	let language: string[] = [...new Set(projectContext?.languages ?? [])];
	if (language.length === 0) {
		for (const [keywords, lang] of LANGUAGE_MAP) {
			if (match(lower, keywords)) {
				language = [lang];
				break;
			}
		}
	}

	const model: "ollama" | "anthropic" | "openai" = "ollama";

	const shortName = prompt.replace(/[.,!?;:].*$/, "").trim();
	const name =
		shortName
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.slice(0, 40) || "agent-harness";

	return {
		name,
		purpose: prompt.split(/\.|\n/)[0]?.trim() ?? prompt,
		language: language.length > 0 ? language : ["typescript"],
		tools: [...tools],
		commands: [...commands],
		models: [model],
	};
}
