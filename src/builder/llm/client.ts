import { z } from "zod";
import type { Provider } from "../../services/api/client";
import { completeText } from "../../services/api/complete";
import { withRetry } from "../../utils/retry";

export class JSONCompletionError extends Error {
	constructor(
		message: string,
		public attempts: number,
		public lastRaw: string,
	) {
		super(message);
		this.name = "JSONCompletionError";
	}
}

export interface CompleteJSONOptions {
	systemPrompt?: string;
	maxAttempts?: number;
}

/**
 * Pull a JSON payload out of raw model output. Small models wrap JSON in
 * prose ("Sure! Here is the JSON:") or markdown fences — tolerate both.
 */
export function extractJSON(raw: string): string {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced?.[1]) return fenced[1].trim();

	const trimmed = raw.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

	const firstObj = trimmed.indexOf("{");
	const firstArr = trimmed.indexOf("[");
	const start =
		firstObj === -1
			? firstArr
			: firstArr === -1
				? firstObj
				: Math.min(firstObj, firstArr);
	if (start === -1) return trimmed;
	const closer = trimmed[start] === "{" ? "}" : "]";
	const end = trimmed.lastIndexOf(closer);
	if (end > start) return trimmed.slice(start, end + 1);
	return trimmed;
}

/**
 * Complete a prompt and parse the response as schema-validated JSON.
 * Invalid output (bad JSON or failed Zod parse) is re-prompted with the
 * validation error, up to maxAttempts. Transport failures retry separately
 * via withRetry so a flaky connection doesn't consume validation attempts.
 */
export async function completeJSON<T>(
	provider: Provider,
	prompt: string,
	schema: z.ZodType<T>,
	opts?: CompleteJSONOptions,
): Promise<T> {
	const maxAttempts = opts?.maxAttempts ?? 3;
	const messages: Array<{ role: string; content: string }> = [];
	if (opts?.systemPrompt) {
		messages.push({ role: "system", content: opts.systemPrompt });
	}
	messages.push({ role: "user", content: prompt });

	let lastRaw = "";
	let lastError = "";

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let text: string;
		try {
			({ text } = await withRetry(() => completeText(provider, messages)));
		} catch (err) {
			// A transport error (413 too-large, an exhausted 429) used to escape
			// completeJSON on the FIRST iteration, consuming none of the retry
			// budget and landing straight in the caller's catch-all fallback. On
			// a 413 specifically, shrink the transcript (drop the oldest
			// reprompt round) and retry within the remaining budget instead of
			// aborting the whole build.
			const msg = err instanceof Error ? err.message : String(err);
			lastError = msg;
			const tooLarge = /413|too large|context length|maximum context/i.test(
				msg,
			);
			if (attempt < maxAttempts && tooLarge && messages.length > 2) {
				// keep the system/user prompt (first 1-2), drop the oldest Q/A pair
				const head = messages.slice(0, opts?.systemPrompt ? 2 : 1);
				messages.length = 0;
				messages.push(...head);
				continue;
			}
			throw err;
		}
		lastRaw = text;

		let parsed: unknown;
		try {
			parsed = JSON.parse(extractJSON(text));
		} catch (err) {
			lastError = `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
			messages.push({ role: "assistant", content: text });
			messages.push({ role: "user", content: reprompt(lastError) });
			continue;
		}

		const result = schema.safeParse(parsed);
		if (result.success) return result.data;

		lastError = z.prettifyError(result.error);
		messages.push({ role: "assistant", content: text });
		messages.push({ role: "user", content: reprompt(lastError) });
	}

	throw new JSONCompletionError(
		`Model failed to produce valid JSON after ${maxAttempts} attempts: ${lastError}`,
		maxAttempts,
		lastRaw,
	);
}

function reprompt(error: string): string {
	return `Your previous response was not valid. Error: ${error}. Respond with ONLY a JSON object matching the schema — no prose, no markdown fences.`;
}
