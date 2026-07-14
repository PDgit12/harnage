import { z } from "zod";
import type { Tool } from "../../Tool";
import { withRetry } from "../../utils/retry";

const WebFetchInput = z.object({
	url: z.string().describe("URL to fetch content from"),
	format: z
		.enum(["markdown", "text", "html"])
		.optional()
		.describe("Return format"),
	timeout: z.number().optional().describe("Timeout in seconds"),
});

type Input = z.infer<typeof WebFetchInput>;

const MAX_LENGTH = 50000;
const DEFAULT_TIMEOUT_S = 30;

const _tool: Tool<Input, string> = {
	name: "WebFetchTool",
	description: "Fetch content from a URL",
	inputSchema: WebFetchInput,
	validateInput(input) {
		const result = WebFetchInput.safeParse(input);
		return result.success
			? { valid: true }
			: { valid: false, error: result.error.message };
	},
	async call(input, _context) {
		const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_S) * 1000;

		try {
			const res = await withRetry(() =>
				fetch(input.url, { signal: AbortSignal.timeout(timeoutMs) }),
			);
			if (!res.ok) {
				return {
					content: `HTTP ${res.status}: ${res.statusText}`,
					isError: true,
				};
			}
			const text = await res.text();
			return { content: text.slice(0, MAX_LENGTH) };
		} catch (e) {
			const msg =
				(e as Error).name === "AbortError"
					? `Request timed out after ${timeoutMs}ms`
					: `Network error: ${e instanceof Error ? e.message : String(e)}`;
			return { content: msg, isError: true };
		}
	},
};

export default _tool;
