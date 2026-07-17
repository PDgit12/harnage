import type { ProjectContext } from "./context";

export interface StructuredSpec {
	name: string;
	purpose: string;
	language: string[];
	tools: string[];
	commands: string[];
	models: Array<"ollama" | "anthropic" | "openai">;
}

const ALWAYS_TOOLS = [
	"bash",
	"file_read",
	"glob",
	"grep",
	"file_edit",
	"file_write",
];

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
	const lower = prompt.toLowerCase();

	for (const pattern of NON_AGENT_PATTERNS) {
		if (pattern.test(lower)) {
			throw new ValidationError(
				`"${prompt}" describes a general application, not an AI agent. ` +
					"harnage builds autonomous AI agents — bots that use tools, " +
					"follow goals, and run in a loop.\n\n" +
					"Examples of what you CAN build:\n" +
					"- A code review agent that checks pull requests\n" +
					"- A documentation generator bot\n" +
					"- A file system monitoring agent\n" +
					"- A project management assistant\n" +
					"- A system diagnostics agent",
			);
		}
	}

	const hasAgentKeyword = AGENT_KEYWORDS.some((k) => lower.includes(k));
	if (!hasAgentKeyword && lower.split(/\s+/).length > 3) {
		throw new ValidationError(
			`"${prompt}" doesn't describe an AI agent. ` +
				"Describe what the agent should DO, not what app to build.\n\n" +
				"Instead of:\n" +
				'- "A TODO app with a file-based backend"\n\n' +
				"Try:\n" +
				'- "An agent that manages TODO tasks through file operations"\n' +
				'- "A code review agent"\n' +
				'- "A file organizer bot"',
		);
	}
}

export function parseIntent(
	prompt: string,
	projectContext?: ProjectContext,
): StructuredSpec {
	const lower = prompt.toLowerCase();
	const tools = new Set(ALWAYS_TOOLS);
	const commands = new Set<string>(["/help", "/clear", "/exit", "/model"]);

	for (const [triggers, extras] of COMMAND_TRIGGERS) {
		if (match(lower, triggers)) for (const c of extras) commands.add(c);
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
