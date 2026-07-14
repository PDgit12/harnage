import { z } from "zod";
import type { Tool } from "../../Tool";

const GrepInput = z.object({
	pattern: z.string().describe("Regex pattern to search for"),
	path: z.string().optional().describe("Directory to search in"),
	include: z.string().optional().describe("File pattern filter (e.g. *.ts)"),
});

type GrepInput = z.infer<typeof GrepInput>;

const _tool: Tool<GrepInput, string[]> = {
	name: "GrepTool",
	description: "Search file contents with regex",
	inputSchema: GrepInput,
	validateInput(input) {
		if (!input.pattern.trim())
			return { valid: false, error: "Pattern cannot be empty" };
		try {
			new RegExp(input.pattern);
		} catch {
			return { valid: false, error: "Invalid regex pattern" };
		}
		return { valid: true };
	},
	async call(input) {
		try {
			const cwd = input.path || process.cwd();
			const rgArgs = [
				"--json",
				input.pattern,
				cwd,
				...(input.include ? ["--glob", input.include] : []),
			];
			const rgProc = Bun.spawn(["rg", ...rgArgs]);
			const rgOut = (await new Response(rgProc.stdout).text()) || null;
			if (rgOut !== null) {
				const lines: string[] = [];
				for (const line of rgOut.split("\n")) {
					if (!line) continue;
					try {
						const p = JSON.parse(line) as Record<string, unknown>;
						if (p.type === "match") {
							const pathText = (p.path as Record<string, string>).text ?? "";
							const data = p.data as Record<string, unknown>;
							const lineNum = data.line_number ?? "";
							const lineText =
								(data.lines as Record<string, string>).text?.trim() ?? "";
							lines.push(`${pathText}:${lineNum}:${lineText}`);
						}
					} catch (e) {
						console.warn("[harnage]", (e as Error).message);
					}
					if (lines.length >= 100) break;
				}
				return { data: lines };
			}
			const grArgs = [
				"-rn",
				...(input.include ? ["--include", input.include] : []),
				input.pattern,
				cwd,
			];
			const grProc = Bun.spawn(["grep", ...grArgs]);
			const grOut = (await new Response(grProc.stdout).text()) || null;
			return {
				data: grOut ? grOut.split("\n").filter(Boolean).slice(0, 100) : [],
			};
		} catch (e) {
			return {
				content: `Grep failed: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	},
};

export default _tool;
