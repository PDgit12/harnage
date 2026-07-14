import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../../Tool.ts";

const Input = z.object({
	path: z.string(),
	content: z.string(),
});

type Input = z.infer<typeof Input>;

const _tool: Tool<Input, { path: string; size: number }> = {
	name: "FileWriteTool",
	description: "Write content to a file",
	inputSchema: Input,
	checkPermissions(_input, context: ToolContext) {
		if (
			context.permissions.mode === "bypass" ||
			context.permissions.mode === "auto"
		)
			return { allowed: true };
		return { allowed: false, reason: "File write requires permission" };
	},
	validateInput(input) {
		if (!input.path.trim()) {
			return { valid: false, error: "Path cannot be empty" };
		}
		return { valid: true };
	},
	call: async (input, _context) => {
		try {
			const cwd = process.cwd();
			const resolvedPath = resolve(cwd, input.path);
			if (!resolvedPath.startsWith(cwd)) {
				return {
					content: `Path ${input.path} is outside the project directory`,
					isError: true,
				};
			}
			await mkdir(dirname(resolvedPath), { recursive: true });
			await writeFile(resolvedPath, input.content, "utf-8");
			return {
				data: { path: resolvedPath, size: input.content.length },
				content: `Wrote ${input.content.length} characters to ${input.path}`,
			};
		} catch (e) {
			return {
				content: `Failed to write ${input.path}: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	},
	isReadOnly: () => false,
};

export default _tool;
