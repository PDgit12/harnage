import type { Tool, ValidationResult } from "../Tool";

export interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	confidence: number;
	validationErrors?: string[];
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
		const name = String(rawName);

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

		const tool = tools.find((t) => t.name === name);
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
