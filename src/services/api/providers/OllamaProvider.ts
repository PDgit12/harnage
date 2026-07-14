import { toErrorMessage } from "../../../utils/displayError";
import type { Provider, ProviderConfig, ToolDefinition } from "../client";
import type { StreamEvent } from "../types";

export class OllamaProvider implements Provider {
	private baseUrl: string;
	private model: string;
	private maxTokens: number;
	private contextTokens: number;
	private timeoutMs: number;

	constructor(config: ProviderConfig) {
		this.baseUrl = config.baseUrl || "http://localhost:11434";
		this.model = config.model;
		this.maxTokens = config.maxTokens;
		this.contextTokens = config.contextTokens ?? 8192;
		this.timeoutMs = 300_000;
	}

	async *stream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamEvent> {
		let body: ReadableStream<Uint8Array> | null = null;

		try {
			const response = await fetch(`${this.baseUrl}/api/chat`, {
				method: "POST",
				signal: AbortSignal.timeout(this.timeoutMs),
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					messages,
					stream: true,
					tools: tools?.map((t) => ({
						type: "function",
						function: {
							name: t.name,
							description: t.description,
							parameters: t.inputSchema,
						},
					})),
					options: {
						// context window and output budget are different knobs:
						// num_ctx too small silently truncates the prompt's head
						num_ctx: this.contextTokens,
						num_predict: this.maxTokens,
					},
				}),
			});

			if (!response.ok) {
				const errorBody = await response.text().catch((e) => {
					console.warn("[harnage]", (e as Error).message);
					return "";
				});
				const error = new Error(
					`Ollama ${response.status}: ${response.statusText} - ${errorBody}`,
				);
				yield { type: "error", content: toErrorMessage(error) };
				return;
			}

			body = response.body;
			if (!body) {
				yield {
					type: "error",
					content: toErrorMessage(
						new Error("Ollama returned empty response body"),
					),
				};
				return;
			}

			const reader = body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const parsed = JSON.parse(line);
						if (parsed.message?.content) {
							yield { type: "text", content: parsed.message.content };
						}
						if (parsed.message?.tool_calls) {
							for (const tc of parsed.message.tool_calls) {
								if (tc.function) {
									let input: Record<string, unknown> = {};
									try {
										input = JSON.parse(tc.function.arguments ?? "{}");
									} catch (e) {
										console.warn("[harnage]", (e as Error).message);
									}
									yield {
										type: "tool_use",
										name: tc.function.name,
										input,
										id: tc.function.name,
									};
								}
							}
						}
						if (parsed.done) {
							yield {
								type: "done",
								usage: {
									promptTokens: parsed.prompt_eval_count || 0,
									completionTokens: parsed.eval_count || 0,
								},
							};
						}
					} catch {
						yield {
							type: "error",
							content: toErrorMessage(
								new Error(
									`Failed to parse Ollama response: ${line.slice(0, 200)}`,
								),
							),
						};
					}
				}
			}
		} catch (e) {
			yield { type: "error", content: toErrorMessage(e) };
		}
	}
}
