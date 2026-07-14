import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/services/api/client";
import {
	createProvider,
	type ProviderConfig,
} from "../src/services/api/client";
import { OllamaProvider } from "../src/services/api/providers/OllamaProvider";
import type { StreamEvent } from "../src/services/api/types";

// ---- Shared test helpers ----

function sseBody(chunks: string[]) {
	const encoder = new TextEncoder();
	const encoded = chunks.map((c) => encoder.encode(c));
	let i = 0;
	return {
		getReader: () => ({
			read: async () => {
				if (i < encoded.length) return { done: false, value: encoded[i++]! };
				return { done: true, value: undefined as unknown as Uint8Array };
			},
		}),
	};
}

function mockFetchResponse(chunks: string[], ok = true, statusText = "OK") {
	return {
		ok,
		statusText,
		status: ok ? 200 : 401,
		body: sseBody(chunks),
		headers: new Map<string, string>(),
		text: vi.fn().mockResolvedValue(chunks.join("")),
	} as unknown as Response;
}

async function collectEvents(
	provider: {
		stream(
			messages: Array<{ role: string; content: string }>,
			tools?: ToolDefinition[],
		): AsyncGenerator<StreamEvent>;
	},
	messages: Array<{ role: string; content: string }> = [
		{ role: "user", content: "hi" },
	],
) {
	const events: StreamEvent[] = [];
	for await (const e of provider.stream(messages)) events.push(e);
	return events;
}

const ollamaConfig = {
	type: "ollama" as const,
	model: "llama3",
	maxTokens: 4096,
};

// ---- Tests ----

describe("createProvider routing", () => {
	it("returns OllamaProvider for type 'ollama'", () => {
		const p = createProvider({ type: "ollama", model: "m", maxTokens: 100 });
		expect(p.constructor.name).toBe("OllamaProvider");
	});

	it("returns OpenAIProvider for type 'openai'", () => {
		const p = createProvider({
			type: "openai",
			model: "gpt-4",
			maxTokens: 100,
			apiKey: "sk-test",
		});
		expect(p.constructor.name).toBe("OpenAIProvider");
	});

	it("returns OpenAIProvider for type 'openrouter'", () => {
		const p = createProvider({
			type: "openrouter",
			model: "mistral",
			maxTokens: 100,
			apiKey: "sk-test",
		});
		expect(p.constructor.name).toBe("OpenAIProvider");
	});

	it("returns AnthropicProvider for type 'anthropic'", () => {
		const p = createProvider({
			type: "anthropic",
			model: "claude-3",
			maxTokens: 100,
			apiKey: "sk-test",
		});
		expect(p.constructor.name).toBe("AnthropicProvider");
	});
});

describe("OllamaProvider streaming", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("yields text and done events from NDJSON stream", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					mockFetchResponse([
						'{"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}\n',
						'{"model":"llama3","message":{"role":"assistant","content":" world"},"done":false}\n',
						'{"model":"llama3","done":true,"prompt_eval_count":5,"eval_count":15}\n',
					]),
				),
		);
		const provider = new OllamaProvider(ollamaConfig);
		const events = await collectEvents(provider);
		expect(events[0]!.type).toBe("text");
		expect(events[0]!.content).toBe("Hello");
		expect(events[1]!.type).toBe("text");
		expect(events[1]!.content).toBe(" world");
		expect(events[2]!.type).toBe("done");
		expect(events[2]!.usage).toEqual({ promptTokens: 5, completionTokens: 15 });
	});
});

describe("OpenAIProvider streaming", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	async function* mockStream(
		chunks: Array<{
			content?: string;
			toolCall?: { name: string; args: string; id: string };
		}>,
	) {
		for (const c of chunks) {
			yield {
				choices: c.content ? [{ delta: { content: c.content }, index: 0 }] : [],
				usage: undefined,
			} as any;
		}
		// final chunk with usage
		yield {
			choices: [{ delta: {}, index: 0 }],
			usage: { prompt_tokens: 10, completion_tokens: 20 },
		} as any;
	}

	it("yields text and done events", async () => {
		const { OpenAIProvider } = await import(
			"../src/services/api/providers/OpenAIProvider"
		);
		// mock the underlying OpenAI SDK create
		vi.spyOn(OpenAIProvider.prototype as any, "stream").mockRestore();

		const provider = new OpenAIProvider({
			type: "openai",
			model: "gpt-4",
			maxTokens: 4096,
			apiKey: "sk-test",
		});
		(provider as any).client.chat.completions.create = vi
			.fn()
			.mockResolvedValue(
				mockStream([{ content: "Hello" }, { content: " world" }]),
			);

		const events = await collectEvents(provider);
		expect(events[0]!.type).toBe("text");
		expect(events[0]!.content).toBe("Hello");
		expect(events[1]!.type).toBe("text");
		expect(events[1]!.content).toBe(" world");
		expect(events[events.length - 1]!.type).toBe("done");
	});

	it("yields tool_use events", async () => {
		const { OpenAIProvider } = await import(
			"../src/services/api/providers/OpenAIProvider"
		);
		const provider = new OpenAIProvider({
			type: "openai",
			model: "gpt-4",
			maxTokens: 4096,
			apiKey: "sk-test",
		});

		async function* toolStream() {
			yield {
				choices: [
					{
						delta: {
							tool_calls: [
								{
									id: "call_1",
									function: {
										name: "read_file",
										arguments: '{"path":"/tmp/test"}',
									},
								},
							],
						},
						index: 0,
					},
				],
				usage: undefined,
			} as any;
			yield {
				choices: [{ delta: {}, index: 0 }],
				usage: { prompt_tokens: 5, completion_tokens: 10 },
			} as any;
		}
		(provider as any).client.chat.completions.create = vi
			.fn()
			.mockResolvedValue(toolStream());

		const events = await collectEvents(provider);
		expect(events[0]!.type).toBe("tool_use");
		expect(events[0]!.name).toBe("read_file");
		expect(events[0]!.input).toEqual({ path: "/tmp/test" });
	});
});

describe("AnthropicProvider streaming", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("yields text and done events", async () => {
		const { AnthropicProvider } = await import(
			"../src/services/api/providers/AnthropicProvider"
		);
		const provider = new AnthropicProvider({
			type: "anthropic",
			model: "claude-3",
			maxTokens: 4096,
			apiKey: "sk-test",
		});

		async function* mockEvents() {
			yield { type: "message_start", message: {} } as any;
			yield {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			} as any;
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			} as any;
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: " world" },
			} as any;
			yield { type: "content_block_stop", index: 0 } as any;
			yield {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
			} as any;
		}
		(provider as any).client.messages.stream = vi
			.fn()
			.mockReturnValue(mockEvents());
		(provider as any).client.messages.stream().finalMessage = vi
			.fn()
			.mockResolvedValue({
				usage: { input_tokens: 7, output_tokens: 14 },
			});

		const events = await collectEvents(provider);
		expect(events[0]!.type).toBe("text");
		expect(events[0]!.content).toBe("Hello");
		expect(events[1]!.type).toBe("text");
		expect(events[1]!.content).toBe(" world");
		expect(events[events.length - 1]!.type).toBe("done");
		expect(events[events.length - 1]!.usage).toEqual({
			promptTokens: 7,
			completionTokens: 14,
		});
	});
});

describe("Provider error handling", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("returns friendly error message on 401 for OllamaProvider", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: vi.fn().mockResolvedValue("invalid key"),
			}),
		);

		const provider = new OllamaProvider(ollamaConfig);
		const events = await collectEvents(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(events[0]!.type).toBe("error");
		expect(events[0]!.content).toContain("401");
	});

	it("returns friendly error message on network failure for OllamaProvider", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockRejectedValue(new Error("fetch failed: connect ECONNREFUSED")),
		);
		const provider = new OllamaProvider(ollamaConfig);
		const events = await collectEvents(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(events[0]!.type).toBe("error");
		expect(events[0]!.content).toContain("ECONNREFUSED");
	});

	it("returns friendly error on 401 for OpenAIProvider", async () => {
		const { OpenAIProvider } = await import(
			"../src/services/api/providers/OpenAIProvider"
		);
		const provider = new OpenAIProvider({
			type: "openai",
			model: "gpt-4",
			maxTokens: 4096,
			apiKey: "sk-test",
		});
		(provider as any).client.chat.completions.create = vi
			.fn()
			.mockRejectedValue(new Error("401 Unauthorized: invalid API key"));

		const events = await collectEvents(provider);
		expect(events[0]!.type).toBe("error");
		expect(events[0]!.content).toContain("API key");
	});

	it("returns friendly error on 401 for OpenAIProvider with openrouter config", async () => {
		const { OpenAIProvider } = await import(
			"../src/services/api/providers/OpenAIProvider"
		);
		const provider = new OpenAIProvider({
			type: "openrouter",
			model: "mistral",
			maxTokens: 4096,
			apiKey: "bad-key",
		});
		(provider as any).client.chat.completions.create = vi
			.fn()
			.mockRejectedValue(new Error("401 Unauthorized: invalid API key"));

		const events = await collectEvents(provider);
		expect(events[0]!.type).toBe("error");
		expect(events[0]!.content).toContain("API key");
	});
});

describe("StreamEvent type compliance", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("OllamaProvider emits valid StreamEvent types", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					mockFetchResponse([
						'{"message":{"role":"assistant","content":"hi"},"done":false}\n',
						'{"done":true,"prompt_eval_count":1,"eval_count":2}\n',
					]),
				),
		);
		const provider = new OllamaProvider(ollamaConfig);
		const events = await collectEvents(provider);
		for (const e of events) {
			expect([
				"text",
				"tool_use",
				"tool_result",
				"thinking",
				"error",
				"done",
				"permission_request",
			]).toContain(e.type);
		}
	});

	it("OpenAIProvider with openrouter config emits valid StreamEvent types", async () => {
		const { OpenAIProvider } = await import(
			"../src/services/api/providers/OpenAIProvider"
		);
		const provider = new OpenAIProvider({
			type: "openrouter",
			model: "mistral",
			maxTokens: 4096,
			apiKey: "sk-test",
		});
		(provider as any).client.chat.completions.create = vi
			.fn()
			.mockResolvedValue(
				(async function* () {
					yield {
						choices: [{ delta: { content: "a" }, index: 0 }],
						usage: undefined,
					};
					yield {
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 1, completion_tokens: 2 },
					};
				})(),
			);
		const events = await collectEvents(provider);
		for (const e of events) {
			expect([
				"text",
				"tool_use",
				"tool_result",
				"thinking",
				"error",
				"done",
				"permission_request",
			]).toContain(e.type);
		}
	});
});
