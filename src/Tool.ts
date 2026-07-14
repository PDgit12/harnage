import type { z } from "zod";
import type { Provider } from "./services/api/client";

export interface ToolContext {
	cwd: string;
	env: Record<string, string | undefined>;
	permissions: PermissionContext;
	sandbox: string;
	provider?: Provider;
	tools?: Tool[];
}

export interface PermissionContext {
	mode: "default" | "plan" | "bypass" | "auto";
	rules: Array<{ pattern: string; allow: boolean }>;
}

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

export interface PermissionResult {
	allowed: boolean;
	reason?: string;
}

export interface ToolResult<T = unknown> {
	data?: T;
	error?: string;
	content?: string;
	isError?: boolean;
	newMessages?: Array<{ role: string; content: string }>;
}

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
	name: string;
	description: string;
	inputSchema: z.ZodType<TInput>;
	validateInput?(input: TInput): ValidationResult | Promise<ValidationResult>;
	checkPermissions?(
		input: TInput,
		context: ToolContext,
	): PermissionResult | Promise<PermissionResult>;
	call(
		input: TInput,
		context: ToolContext,
	): ToolResult<TOutput> | Promise<ToolResult<TOutput>>;
	isReadOnly?(input: TInput): boolean;
}
