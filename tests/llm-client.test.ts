import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	completeJSON,
	extractJSON,
	JSONCompletionError,
} from "../src/builder/llm/client";
import type { Provider } from "../src/services/api/client";
import { completeText } from "../src/services/api/complete";

/** Provider that replays canned responses, one per stream() call. */
function mockProvider(
	responses: string[],
	capture?: Array<Array<{ role: string; content: string }>>,
): Provider {
	let i = 0;
	return {
		async *stream(messages) {
			capture?.push(messages.map((m) => ({ ...m })));
			const text = responses[Math.min(i, responses.length - 1)];
			i++;
			yield { type: "text", content: text };
			yield {
				type: "done",
				usage: { promptTokens: 1, completionTokens: 1 },
			};
		},
	};
}

function errorProvider(message: string): Provider {
	return {
		async *stream() {
			yield { type: "error", content: message };
		},
	};
}

describe("completeText", () => {
	it("concatenates multi-chunk text", async () => {
		const provider: Provider = {
			async *stream() {
				yield { type: "text", content: "hello " };
				yield { type: "text", content: "world" };
				yield {
					type: "done",
					usage: { promptTokens: 3, completionTokens: 2 },
				};
			},
		};
		const result = await completeText(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(result.text).toBe("hello world");
		expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
	});

	it("throws on error events", async () => {
		await expect(
			completeText(errorProvider("boom 401"), [
				{ role: "user", content: "hi" },
			]),
		).rejects.toThrow("boom 401");
	});

	it("throws on empty completion", async () => {
		const provider: Provider = {
			async *stream() {
				yield { type: "text", content: "   " };
				yield { type: "done" };
			},
		};
		await expect(
			completeText(provider, [{ role: "user", content: "hi" }]),
		).rejects.toThrow("empty completion");
	});
});

describe("extractJSON", () => {
	it("returns raw JSON untouched", () => {
		expect(extractJSON('{"a":1}')).toBe('{"a":1}');
	});

	it("strips markdown fences", () => {
		expect(extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}');
		expect(extractJSON("```\n[1,2]\n```")).toBe("[1,2]");
	});

	it("extracts JSON wrapped in prose", () => {
		expect(
			extractJSON('Sure! Here is the JSON:\n{"a":1}\nHope it helps.'),
		).toBe('{"a":1}');
	});
});

describe("completeJSON", () => {
	const schema = z.object({ name: z.string(), count: z.number() });

	it("parses valid JSON on first attempt", async () => {
		const provider = mockProvider(['{"name":"x","count":2}']);
		const result = await completeJSON(provider, "go", schema);
		expect(result).toEqual({ name: "x", count: 2 });
	});

	it("parses fenced JSON", async () => {
		const provider = mockProvider(['```json\n{"name":"x","count":2}\n```']);
		const result = await completeJSON(provider, "go", schema);
		expect(result).toEqual({ name: "x", count: 2 });
	});

	it("re-prompts with validation error then succeeds", async () => {
		const captured: Array<Array<{ role: string; content: string }>> = [];
		const provider = mockProvider(
			['{"name":"x"}', '{"name":"x","count":2}'],
			captured,
		);
		const result = await completeJSON(provider, "go", schema);
		expect(result).toEqual({ name: "x", count: 2 });
		expect(captured).toHaveLength(2);
		const secondCall = captured[1];
		const lastUser = secondCall[secondCall.length - 1];
		expect(lastUser.content).toContain("not valid");
		expect(lastUser.content).toContain("count");
	});

	it("throws JSONCompletionError after exhausting attempts", async () => {
		const provider = mockProvider(["not json at all"]);
		try {
			await completeJSON(provider, "go", schema, { maxAttempts: 3 });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(JSONCompletionError);
			expect((err as JSONCompletionError).attempts).toBe(3);
		}
	});
});
