import { z } from "zod";
import { runSandboxed } from "../../loop/sandbox";
import type { Tool, ToolContext, ToolResult } from "../../Tool";
import { withRetry } from "../../utils/retry";

export const BashInput = z.object({
	command: z.string().describe("Shell command to execute"),
	timeout: z.number().optional().describe("Timeout in ms (default 30000)"),
	workdir: z.string().optional().describe("Working directory"),
});

export type BashInput = z.infer<typeof BashInput>;

interface ValidationResult {
	valid: boolean;
	error?: string;
}

const READ_ONLY_SEGMENTS = [
	/^ls\b/,
	/^cat\b/,
	/^git diff\b/,
	/^git log\b/,
	/^git status\b/,
	/^pwd\b/,
	/^echo\b/,
	/^head\b/,
	/^tail\b/,
	/^grep\b/,
	/^find\b/,
	/^which\b/,
	/^type\b/,
	/^file\b/,
	/^du\b/,
	/^df\b/,
];

export function isReadOnlyCommand(cmd: string): boolean {
	if (!cmd) return true;
	const segments = cmd.split(/[;&|]{1,2}|\n|\$\(/);
	return segments.every((s) =>
		READ_ONLY_SEGMENTS.some((p) => p.test(s.trim())),
	);
}

const DANGEROUS_KEYWORDS =
	/\b(rm\s+-rf|dd\s+|mkfs|fdisk|format|:\(\)|>\S*sda|mkswap|chmod\s+777|cryptsetup|pvcreate|lvcreate|vgcreate)\b/;

const BYPASS_PATTERNS = [
	{
		pattern: /python[23]?\s+-c/,
		reason: "Indirect command execution via Python",
	},
	{
		pattern: /(?:perl|ruby|php|node|lua)\s+-(?:e|E)\s/,
		reason: "Indirect command execution via interpreter",
	},
	{
		pattern: /(?:sh|bash|zsh|dash|fish)\s+-c\s/,
		reason: "Indirect command execution via shell",
	},
	{
		pattern: /(?:base64|b64|base32)\s+(-[dD]|--decode)\s/,
		reason: "Base64-encoded command execution",
	},
	{
		pattern: /`[^`]*\b(rm\s+-rf|dd\s|mkfs|fdisk|format|wget|curl)\b[^`]*`/,
		reason: "Backtick-encoded dangerous command",
	},
	{
		pattern:
			/\$\([^)]*\b(?:rm\s+-rf|dd\s|mkfs|fdisk|format|wget|curl|mv|>:|>>:)\b/,
		reason: "Command substitution with dangerous command",
	},
	{
		pattern: /(?:curl|wget)\s+(?:-\s*-)?\S+\s*\|/,
		reason: "Remote script piped to shell",
	},
	{ pattern: /\beval\s/, reason: "Eval execution" },
] as const;

const DANGEROUS_PATTERNS = [
	{ pattern: /rm\s+-rf\s+\/\s*$/, reason: "Recursive root delete" },
	{ pattern: /^dd\s/, reason: "Raw disk write" },
	{ pattern: /^mkfs/, reason: "Filesystem format" },
	{ pattern: /:\(\)/, reason: "Fork bomb" },
	{ pattern: /\/dev\/sda/, reason: "Raw device access" },
] as const;

export function isDangerousCommand(cmd: string): ValidationResult {
	if (!cmd) return { valid: true };
	const trimmed = cmd.trim();
	for (const { pattern, reason } of DANGEROUS_PATTERNS) {
		if (pattern.test(trimmed)) return { valid: false, error: reason };
	}
	for (const bypass of BYPASS_PATTERNS) {
		if (bypass.pattern.test(trimmed))
			return { valid: false, error: bypass.reason };
	}
	if (DANGEROUS_KEYWORDS.test(trimmed)) {
		return { valid: false, error: "Potentially dangerous command detected" };
	}
	return { valid: true };
}

async function runBashWithSandbox(
	cmd: string,
	timeout = 30_000,
	workdir?: string,
) {
	return runSandboxed(cmd, { maxCpuTimeMs: timeout, cwd: workdir });
}

function normalizeInput(input: BashInput): BashInput {
	if (!input.command && "cmd" in input) {
		return {
			...input,
			command: (input as Record<string, unknown>).cmd as string,
		};
	}
	return input;
}

const BashTool: Tool<
	BashInput,
	{ stdout: string; stderr: string; exitCode: number }
> = {
	name: "BashTool",
	description: "Execute shell commands with sandbox",
	inputSchema: BashInput,
	validateInput(input: BashInput) {
		const cmd = normalizeInput(input).command;
		const result = isDangerousCommand(cmd);
		if (!result.valid)
			return {
				valid: false,
				error: result.error ?? "Blocked by safety policy",
			};
		return { valid: true };
	},
	checkPermissions(input: BashInput, context: ToolContext) {
		const cmd = normalizeInput(input).command;
		if (isReadOnlyCommand(cmd)) return { allowed: true };
		const danger = isDangerousCommand(cmd);
		if (!danger.valid)
			return {
				allowed: false,
				reason: danger.error ?? "Blocked by safety policy",
			};
		if (
			context.permissions.mode === "bypass" ||
			context.permissions.mode === "auto"
		)
			return { allowed: true };
		return { allowed: false, reason: "Bash execution not permitted" };
	},
	async call(
		input: BashInput,
		_context: ToolContext,
	): Promise<ToolResult<{ stdout: string; stderr: string; exitCode: number }>> {
		const cmd = normalizeInput(input).command;
		if (!cmd) return { error: "command is required", isError: true };
		const result = await withRetry(() =>
			runBashWithSandbox(cmd, input.timeout ?? 30_000, input.workdir),
		);
		return { data: result };
	},
	isReadOnly(input: BashInput) {
		const cmd = normalizeInput(input).command;
		if (!cmd) return true;
		return isReadOnlyCommand(cmd);
	},
};

export { BashTool };
export default BashTool;
