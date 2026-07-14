import OpenAI from "openai";
import { toErrorMessage } from "../../../utils/displayError";
import type { Provider, ProviderConfig, ToolDefinition } from "../client";
import type { StreamEvent } from "../types";

export class OpenAIProvider implements Provider {
	private client: OpenAI;
	private model: string;
	private maxTokens: number;

	constructor(config: ProviderConfig) {
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
		});
		this.model = config.model;
		this.maxTokens = config.maxTokens;
	}

	async *stream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamEvent> {
		try {
			const stream = await this.client.chat.completions.create({
				model: this.model,
				max_tokens: this.maxTokens,
				messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
				tools: tools?.map((t) => ({
					type: "function",
					function: {
						name: t.name,
						description: t.description,
						parameters: t.inputSchema,
					},
				})),
				stream: true,
			});

			let usage: { promptTokens?: number; completionTokens?: number } = {};

			for await (const chunk of stream) {
				if (chunk.choices?.[0]?.delta?.content) {
					yield { type: "text", content: chunk.choices[0].delta.content };
				}
				if (chunk.choices?.[0]?.delta?.tool_calls) {
					for (const tc of chunk.choices[0].delta.tool_calls) {
						if (tc.function?.name) {
							yield {
								type: "tool_use",
								name: tc.function.name,
								input: JSON.parse(tc.function.arguments || "{}"),
								id: tc.id,
							};
						}
					}
				}
				if (chunk.usage) {
					usage = {
						promptTokens: chunk.usage.prompt_tokens,
						completionTokens: chunk.usage.completion_tokens,
					};
				}
			}
			yield {
				type: "done",
				usage: {
					promptTokens: usage.promptTokens || 0,
					completionTokens: usage.completionTokens || 0,
				},
			};
		} catch (e) {
			yield { type: "error", content: toErrorMessage(e) };
		}
	}
}
