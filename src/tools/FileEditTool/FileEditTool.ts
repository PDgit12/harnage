import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "../../Tool";

const FileEditInput = z.object({
	path: z.string().describe("Absolute path to file to edit"),
	oldString: z.string().describe("Text to replace (must match exactly)"),
	newString: z.string().describe("Replacement text"),
	replaceAll: z.boolean().optional().describe("Replace all occurrences"),
});

type Input = z.infer<typeof FileEditInput>;

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const SYSTEM_PATH_PATTERNS = [
	/^\/etc\//,
	/^\/usr\//,
	/^\/bin\//,
	/^\/sbin\//,
	/^\/lib\//,
	/^\/boot\//,
	/^\/dev\//,
	/^\/proc\//,
	/^\/sys\//,
];

function isSystemPath(filePath: string): boolean {
	return SYSTEM_PATH_PATTERNS.some((p) => p.test(filePath));
}

const _tool: Tool<Input, { diff: string }> = {
	name: "FileEditTool",
	description: "Edit files using string replacement",
	inputSchema: FileEditInput,

	async validateInput(input) {
		if (!existsSync(input.path))
			return { valid: false, error: `File does not exist: ${input.path}` };
		const content = await readFile(input.path, "utf-8");
		const n = countOccurrences(content, input.oldString);
		if (n === 0)
			return {
				valid: false,
				error: `oldString not found in ${input.path}`,
			};
		if (!input.replaceAll && n > 1)
			return {
				valid: false,
				error: `Found ${n} occurrences. Use replaceAll or provide more context.`,
			};
		return { valid: true };
	},

	checkPermissions(input, context: ToolContext) {
		if (isSystemPath(input.path))
			return {
				allowed: false,
				reason: "Editing system files requires allow mode",
			};
		if (
			context.permissions.mode === "bypass" ||
			context.permissions.mode === "auto"
		)
			return { allowed: true };
		return { allowed: false, reason: "File edit requires permission" };
	},

	async call(input, _context: ToolContext) {
		try {
			const content = await readFile(input.path, "utf-8");
			const newContent = input.replaceAll
				? content.replaceAll(input.oldString, input.newString)
				: content.replace(input.oldString, input.newString);
			const n = countOccurrences(content, input.oldString);
			const replacements = input.replaceAll ? n : 1;
			const tmp = join(tmpdir(), `af-edit-${randomUUID()}`);
			await writeFile(tmp, newContent, "utf-8");
			await rename(tmp, input.path);
			return {
				data: {
					diff: `Edited ${input.path} (${replacements} replacement(s))`,
				},
			};
		} catch (e) {
			return {
				content: `Failed to edit ${input.path}: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	},

	// ponytail: no undo support — add backup-to-tmp + undo stack before rename in call()
	isReadOnly(_input: Input) {
		return false;
	},
};

export default _tool;
