import { readdir, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../../Tool.ts";

const Input = z.object({
	path: z.string().describe("Absolute path to the file or directory"),
	description: z.string().optional().describe("Optional description"),
	offset: z
		.number()
		.optional()
		.describe("Line number to start reading from (1-indexed)"),
	limit: z.number().optional().describe("Maximum number of lines to read"),
});

type Input = z.infer<typeof Input>;

const SENSITIVE = [
	"/etc/passwd",
	"/etc/shadow",
	"/etc/sudoers",
	".ssh/",
	".gitconfig",
];

const TEXT_EXTS = new Set([
	".ts",
	".js",
	".tsx",
	".jsx",
	".json",
	".md",
	".txt",
	".toml",
	".yaml",
	".yml",
	".html",
	".css",
	".scss",
	".less",
	".rs",
	".go",
	".py",
	".rb",
	".java",
	".c",
	".h",
	".cpp",
	".hpp",
	".sh",
	".bash",
	".zsh",
	".fish",
	".env",
	".gitignore",
	".gitkeep",
	".editorconfig",
	".xml",
	".svg",
	".yml",
	".sql",
	".graphql",
	".proto",
	".vue",
	".svelte",
	".astro",
]);

const _tool: Tool<Input, string[] | string> = {
	name: "FileReadTool",
	description: "Read a file or directory",
	inputSchema: Input,
	validateInput(input) {
		if (SENSITIVE.some((s) => input.path.includes(s))) {
			return {
				valid: false,
				error: `Cannot read sensitive file: ${input.path}`,
			};
		}
		return { valid: true };
	},
	call: async (input, _context) => {
		try {
			const stats = await stat(input.path);
			if (stats.isDirectory()) {
				const entries = await readdir(input.path);
				return { content: entries.join("\n") };
			}

			const ext = input.path.split(".").pop()?.toLowerCase() ?? "";
			const buffer = await readFile(input.path);
			if (!TEXT_EXTS.has(`.${ext}`) && buffer.includes(0)) {
				return { content: `Binary file: ${buffer.length} bytes` };
			}

			const fullContent = buffer.toString("utf-8");
			const lines = fullContent.split("\n");
			const start = input.offset ? Math.max(0, input.offset - 1) : 0;
			const end =
				input.limit !== undefined ? start + input.limit : lines.length;
			const selected = lines.slice(start, end);
			return { content: selected.join("\n") };
		} catch (e) {
			return {
				content: `Failed to read ${input.path}: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	},
};

export default _tool;
