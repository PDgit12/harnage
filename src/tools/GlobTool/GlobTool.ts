import { z } from "zod";
import type { Tool } from "../../Tool";

const GlobInput = z.object({
	pattern: z.string().describe("Glob pattern (e.g. **/*.ts, src/**/*.tsx)"),
	path: z.string().optional().describe("Directory to search in"),
});

type GlobInput = z.infer<typeof GlobInput>;

const _tool: Tool<GlobInput, string[]> = {
	name: "GlobTool",
	description: "Find files matching a glob pattern",
	inputSchema: GlobInput,
	async call(input) {
		try {
			const cwd = input.path || process.cwd();
			const glob = new Bun.Glob(input.pattern);
			const results = await Array.fromAsync(glob.scan({ cwd }));
			return { data: results.sort() };
		} catch (e) {
			return {
				content: `Glob failed: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	},
};

export default _tool;
