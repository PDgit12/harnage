import { beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../src/services/api/providers/OllamaProvider";

function createMockBody(chunks: string[]) {
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

function mockFetchResponse(chunks: string[], ok = true) {
	const body = createMockBody(chunks);
	return {
		ok,
		statusText: ok ? "OK" : "Internal Server Error",
		body,
		text: vi.fn().mockResolvedValue(chunks.join("")),
	} as unknown as Response;
}

async function collectEvents(
	provider: OllamaProvider,
	messages: Array<{ role: string; content: string }>,
) {
	const events: Array<{
		type: string;
		content?: string;
		usage?: { promptTokens: number; completionTokens: number };
	}> = [];
	for await (const e of provider.stream(messages)) events.push(e);
	return events;
}

const defaultConfig = {
	type: "ollama" as const,
	model: "llama3",
	maxTokens: 4096,
};

function mockFetch() {
	return vi.fn() as any;
}

describe("OllamaProvider", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("sends POST to /api/chat with correct body", async () => {
		globalThis.fetch = mockFetch().mockResolvedValue(mockFetchResponse([]));
		const provider = new OllamaProvider(defaultConfig);
		await collectEvents(provider, [{ role: "user", content: "hi" }]);

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const [url, opts] = (globalThis.fetch as any).mock.calls[0];
		expect(url).toBe("http://localhost:11434/api/chat");
		const body = JSON.parse(opts.body);
		expect(body.model).toBe("llama3");
		expect(body.stream).toBe(true);
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("yields text events from NDJSON stream", async () => {
		globalThis.fetch = mockFetch().mockResolvedValue(
			mockFetchResponse([
				'{"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}\n',
				'{"model":"llama3","message":{"role":"assistant","content":" world"},"done":false}\n',
			]),
		);
		const provider = new OllamaProvider(defaultConfig);
		const events = await collectEvents(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("text");
		expect(events[0]!.content).toBe("Hello");
		expect(events[1]!.type).toBe("text");
		expect(events[1]!.content).toBe(" world");
	});

	it("yields done event with usage stats", async () => {
		globalThis.fetch = mockFetch().mockResolvedValue(
			mockFetchResponse([
				'{"model":"llama3","done":true,"prompt_eval_count":10,"eval_count":20}\n',
			]),
		);
		const provider = new OllamaProvider(defaultConfig);
		const events = await collectEvents(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("done");
		expect(events[0]!.usage).toEqual({
			promptTokens: 10,
			completionTokens: 20,
		});
	});

	it("yields error event for non-ok response", async () => {
		globalThis.fetch = mockFetch().mockResolvedValue(
			mockFetchResponse([], false),
		);
		const provider = new OllamaProvider(defaultConfig);
		const events = await collectEvents(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("error");
		expect(events[0]!.content).toContain("Ollama");
	});

	it("yields error event for network failures", async () => {
		globalThis.fetch = mockFetch().mockRejectedValue(
			new Error("network failure"),
		);
		const provider = new OllamaProvider(defaultConfig);
		const events = await collectEvents(provider, [
			{ role: "user", content: "hi" },
		]);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("error");
		expect(events[0]!.content).toContain("network failure");
	});

	it("handles custom baseUrl", async () => {
		globalThis.fetch = mockFetch().mockResolvedValue(mockFetchResponse([]));
		const provider = new OllamaProvider({
			...defaultConfig,
			baseUrl: "http://custom:8080",
		});
		await collectEvents(provider, [{ role: "user", content: "hi" }]);
		const callUrl = (globalThis.fetch as any).mock.calls[0][0];
		expect(callUrl).toBe("http://custom:8080/api/chat");
	});
});
