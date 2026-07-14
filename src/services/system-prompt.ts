import type { StructuredSpec } from "../builder/spec";
import type { ProjectContext } from "../builder/spec/context";

export interface PromptBlock {
	title: string;
	body: string;
}

export const TOOL_CALLING_FORMAT: PromptBlock = {
	title: "Tool Calling",
	body: `You have tools available. Call them when the task requires file operations, code changes, web searches, or running commands.

- The system handles tool calls — you do not need to format them manually
- Wait for the result before continuing
- If a tool call fails, report it clearly and try a different approach
- For simple answers (greetings, questions, information), text alone is fine`,
};

export const TOOL_CATALOG: PromptBlock = {
	title: "Tool Reference",
	body: `Each tool has a name and input schema. Use the correct parameter names as shown.

| Tool | Parameters |
|------|-----------|
| bash | command (string), timeout (number, optional), workdir (string, optional) |
| read | path (string), offset (number, optional), limit (number, optional) |
| write | path (string), content (string) |
| FileEditTool | path (string), oldString (string), newString (string), replaceAll (boolean, optional) |
| GlobTool | pattern (string) |
| GrepTool | pattern (string), include (string, optional), path (string, optional) |
| WebFetch | url (string) |
| WebSearch | query (string) |
| AgentTool | task (string), prompt (string) |
| TaskTool | description (string) |
`,
};

export const CODE_STYLE: PromptBlock = {
	title: "Code Style",
	body: `- Do not add comments unless the code is non-obvious
- Read existing files before editing to understand conventions
- Prefer standard library over new dependencies
- Make minimal focused changes — one change per file
- Follow the project's existing patterns (naming, imports, structure)`,
};

export const VERIFICATION_GATES: PromptBlock = {
	title: "Verification",
	body: `Before declaring a task done:
1. Run \`bun run typecheck\` (or \`cargo check\`, etc.)
2. Run \`bun run test\` (or \`cargo test\`, etc.)
3. If lint is configured, run \`bun run lint\`
4. If any check fails, fix the issue`,
};

export const SAFETY_RULES: PromptBlock = {
	title: "Safety Rules",
	body: `- Read a file before editing it
- Do not delete files unless explicitly asked
- Do not run destructive commands (rm -rf, dd, mkfs)
- Keep file writes inside the project directory
- Validate inputs before passing to tools
- If a tool returns an error, report it clearly`,
};

export const GOAL_LOOP: PromptBlock = {
	title: "Goal Loop",
	body: `Work in this cycle:
1. Plan — understand the goal and break it into steps
2. Execute — use tools to make progress
3. Verify — check that the result is correct
4. Check Goal — determine if the goal is met
5. Adapt — if stuck, try a different approach

If you have failed 3 times in a row (same error, same approach), do NOT keep retrying. Instead, report the failure to the user and ask for clarification or a different approach.`,
};

export const HARNESS_BUILDER: PromptBlock = {
	title: "Harness Builder",
	body: `To generate a new harness project, tell the user to type "/init" and describe what they want. The /init command opens a guided wizard. Do NOT try to build harness files manually with bash/write tools — use /init.`,
};

export const DEFAULT_BLOCKS: PromptBlock[] = [
	TOOL_CALLING_FORMAT,
	TOOL_CATALOG,
	CODE_STYLE,
	VERIFICATION_GATES,
	SAFETY_RULES,
	GOAL_LOOP,
	HARNESS_BUILDER,
];

function buildVerificationBlock(context: ProjectContext): string {
	const commands: string[] = [];
	if (context.scripts?.typecheck)
		commands.push(`1. Run \`${context.scripts.typecheck}\``);
	if (context.scripts?.test)
		commands.push(`2. Run \`${context.scripts.test}\``);
	if (context.scripts?.lint)
		commands.push(`3. Run \`${context.scripts.lint}\``);
	if (commands.length === 0) return VERIFICATION_GATES.body;

	return `Before declaring a task done:\n${commands.join("\n")}\n${commands.length < 3 ? "4. " : ""}If any check fails, fix the issue`;
}

function buildLanguageStyleBlock(context: ProjectContext): string {
	const lang = context.languages[0];
	if (!lang) return CODE_STYLE.body;

	const rules: Record<string, string> = {
		typescript: `- Use TypeScript with strict types
- No \`any\` unless absolutely necessary
- Use \`const\` over \`let\`
- Use \`async/await\` over raw promises
- Prefer \`z\` for runtime validation`,
		python: `- Follow PEP 8
- Use type hints
- Use \`async/await\` for I/O
- Prefer \`pathlib\` over \`os.path\`
- Format with \`ruff\` or \`black\``,
		rust: `- Follow rustfmt conventions
- Use \`Result\` and proper error handling
- Prefer 'iter()' over indexing
- Use \`clippy\` as linter`,
		go: `- Follow \`gofmt\` conventions
- Use \`error\` returns over exceptions
- Prefer composition over inheritance
- Use \`go vet\` for static analysis`,
	};

	const langRules = rules[lang];
	if (!langRules) return CODE_STYLE.body;

	return `${CODE_STYLE.body}\n${langRules}`;
}

export function buildSystemPrompt(
	blocks: PromptBlock[],
	spec?: {
		name?: string;
		description?: string;
		tools?: string[];
		commands?: string[];
	},
	context?: ProjectContext,
): string {
	const lines: string[] = [];
	const name = spec?.name ? spec.name.replace(/-/g, " ") : "AgentForge Harness";
	const description = spec?.description ?? "Autonomous AI agent";

	lines.push(`# ${name}`);
	lines.push(``);
	lines.push(`${description}`);
	lines.push(``);

	if (context?.files?.length) {
		lines.push(`## Project Structure`);
		lines.push(``);
		const dirs = new Set(
			context.files
				.map((f) => f.split("/").slice(0, -1).join("/"))
				.filter(Boolean),
		);
		for (const d of [...dirs].sort()) {
			const count = context.files.filter(
				(f) => f.startsWith(d) && !f.slice(d.length + 1).includes("/"),
			).length;
			lines.push(`- ${d}/ (${count} files)`);
		}
		lines.push(``);
	}

	if (spec?.tools?.length) {
		lines.push(`## Available Tools`);
		lines.push(``);
		for (const t of spec.tools) {
			lines.push(`- \`${t}\``);
		}
		lines.push(``);
	}

	if (spec?.commands?.length) {
		lines.push(`## Slash Commands`);
		lines.push(``);
		for (const c of spec.commands) {
			lines.push(`- \`${c}\``);
		}
		lines.push(``);
	}

	for (const block of blocks) {
		lines.push(`## ${block.title}`);
		lines.push(``);
		if (block.title === "Verification" && context) {
			lines.push(buildVerificationBlock(context));
		} else if (block.title === "Code Style" && context) {
			lines.push(buildLanguageStyleBlock(context));
		} else {
			lines.push(block.body.trim());
		}
		lines.push(``);
	}

	return lines.join("\n");
}

export async function generateSystemMd(
	outputDir: string,
	blocks: PromptBlock[],
	spec: StructuredSpec,
	context: ProjectContext,
): Promise<void> {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const dir = join(outputDir, ".agentforge");
	await mkdir(dir, { recursive: true });
	const content = buildSystemPrompt(
		blocks,
		{
			name: spec.name?.replace(/-/g, " ") ?? "AgentForge Harness",
			description: spec.purpose,
			tools: spec.tools,
			commands: spec.commands,
		},
		context,
	);
	await writeFile(join(dir, "system.md"), content, "utf-8");
}
