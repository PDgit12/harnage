import type { Tool, ValidationResult } from "../Tool";

export interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	confidence: number;
	validationErrors?: string[];
}

/**
 * Small models emit the function NAME with its arguments glued on — observed on
 * qwen2.5:3b: `Grep{"pattern":"x","path":"./p"}`. Split the trailing JSON back
 * off so the call stays usable instead of being dropped as an unknown tool.
 */
export function splitToolCallName(
	raw: string,
	input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
	const brace = raw.indexOf("{");
	if (brace <= 0) return { name: raw.trim(), input };
	const name = raw.slice(0, brace).trim();
	if (Object.keys(input).length > 0) return { name, input };
	try {
		const parsed: unknown = JSON.parse(raw.slice(brace));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { name, input: parsed as Record<string, unknown> };
		}
	} catch {
		/* keep the original args */
	}
	return { name, input };
}

/** PascalCase (or `GrepTool`) → the snake_case id tools are actually named with. */
function toSnakeToolName(name: string): string {
	return name
		.replace(/Tool$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[-\s]+/g, "_")
		.toLowerCase();
}

/**
 * Resolve a model-emitted tool name against the real tool list: exact match
 * first, then the malformations small models actually produce — a `Tool` suffix,
 * PascalCase instead of snake_case, wrong casing. Undefined only when the name
 * genuinely matches nothing.
 */
export function resolveToolByName(
	tools: Tool[],
	rawName: string,
): Tool | undefined {
	const name = rawName.trim();
	if (!name) return undefined;
	const exact = tools.find((t) => t.name === name);
	if (exact) return exact;
	const snake = toSnakeToolName(name);
	return (
		tools.find((t) => t.name === snake) ??
		tools.find((t) => t.name.toLowerCase() === name.toLowerCase()) ??
		tools.find((t) => t.name.toLowerCase() === snake)
	);
}

function extractJsonBlocks(text: string): string[] {
	const blocks: string[] = [];

	const tagRegex = /<(?:tool|tool_call)>([\s\S]*?)<\/(?:tool|tool_call)>/g;
	for (const match of text.matchAll(tagRegex)) {
		blocks.push(match[1].trim());
	}

	return blocks;
}

export function parseToolCalls(text: string, tools: Tool[]): ParsedToolCall[] {
	const blocks = extractJsonBlocks(text);
	const results: ParsedToolCall[] = [];

	for (const block of blocks) {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(block);
		} catch {
			continue;
		}

		const rawName = (parsed.name ?? parsed.tool ?? parsed.function) as
			| string
			| undefined;
		if (!rawName) continue;

		let input: Record<string, unknown> = {};
		if (typeof parsed.input === "object" && parsed.input !== null) {
			input = parsed.input as Record<string, unknown>;
		} else if (
			typeof parsed.arguments === "object" &&
			parsed.arguments !== null
		) {
			input = parsed.arguments as Record<string, unknown>;
		} else if (typeof parsed.arguments === "string") {
			try {
				input = JSON.parse(parsed.arguments);
			} catch {
				input = {};
			}
		}

		// Normalize before matching: the name may carry its own args, or be
		// PascalCase/`XTool` instead of the snake_case id the tool registers.
		const split = splitToolCallName(String(rawName), input);
		input = split.input;
		const tool = resolveToolByName(tools, split.name);
		const name = tool?.name ?? split.name;
		const valRes: ValidationResult = tool
			? validateToolInput(tool, input)
			: { valid: true };
		const id = (parsed.id ??
			parsed.tool_use_id ??
			`tc_${results.length}`) as string;

		results.push({
			id: String(id),
			name,
			input,
			confidence: valRes.valid ? 1.0 : 0.5,
			validationErrors: valRes.error ? [valRes.error] : undefined,
		});
	}

	return results;
}

export function validateToolInput(
	tool: Tool,
	input: Record<string, unknown>,
): ValidationResult {
	const result = tool.inputSchema.safeParse(input);
	if (result.success) {
		return { valid: true };
	}
	const error = result.error.issues
		.map((e) => `${e.path.join(".")}: ${e.message}`)
		.join("; ");
	return { valid: false, error };
}

export function formatToolsForPrompt(tools: Tool[]): string {
	if (tools.length === 0) return "";
	const lines: string[] = ["<available_tools>"];
	for (const t of tools) {
		lines.push(`  <tool name="${t.name}">`);
		lines.push(`    <description>${t.description}</description>`);
		lines.push(`  </tool>`);
	}
	lines.push("</available_tools>");
	return lines.join("\n");
}
