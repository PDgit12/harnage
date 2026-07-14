import { z } from "zod";
import type { Tool, ToolContext } from "../../Tool";

const WebSearchInput = z.object({
	query: z.string().describe("Search query"),
	numResults: z.number().optional().describe("Number of results (default 5)"),
});

type Input = z.infer<typeof WebSearchInput>;

const WebSearchTool: Tool<Input, string> = {
	name: "WebSearchTool",
	description: "Search the web",
	inputSchema: WebSearchInput,
	validateInput(input: Input) {
		const result = WebSearchInput.safeParse(input);
		return result.success
			? { valid: true }
			: { valid: false, error: result.error.message };
	},
	async call(input: Input, _context: ToolContext) {
		const apiKey = process.env.SEARCH_API_KEY;
		if (!apiKey) {
			return {
				content:
					"Web search requires configuration. Set the SEARCH_API_KEY environment variable to enable web search.",
				isError: true,
			};
		}

		const count = input.numResults ?? 5;
		try {
			const res = await fetch(
				`https://serpapi.com/search?q=${encodeURIComponent(input.query)}&api_key=${apiKey}&num=${count}`,
			);
			if (!res.ok) {
				return {
					content: `Search API error: HTTP ${res.status}`,
					isError: true,
				};
			}
			const data = (await res.json()) as Record<string, unknown>;
			return { content: JSON.stringify(data) };
		} catch (e) {
			return {
				content: `Search failed: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	},
};

export default WebSearchTool;
