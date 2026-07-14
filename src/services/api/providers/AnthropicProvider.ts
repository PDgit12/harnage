import Anthropic from "@anthropic-ai/sdk";
import { toErrorMessage } from "../../../utils/displayError";
import { withRetry } from "../../../utils/retry";
import type { Provider, ProviderConfig, ToolDefinition } from "../client";
import type { StreamEvent } from "../types";

export class AnthropicProvider implements Provider {
	private client: Anthropic;
	private model: string;
	private maxTokens: number;

	constructor(config: ProviderConfig) {
		this.client = new Anthropic({ apiKey: config.apiKey });
		this.model = config.model;
		this.maxTokens = config.maxTokens;
	}

	async *stream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamEvent> {
		try {
			const connect = () =>
				this.client.messages.stream({
					model: this.model,
					max_tokens: this.maxTokens,
					messages: messages.map((m) => ({
						role: m.role as "user" | "assistant",
						content: m.content,
					})),
					tools: tools?.map((t) => ({
						name: t.name,
						description: t.description,
						input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
					})),
				});
			const stream = await withRetry(connect);

			for await (const event of stream) {
				if (
					event.type === "content_block_delta" &&
					event.delta?.type === "text_delta"
				) {
					yield { type: "text", content: event.delta.text };
				} else if (
					event.type === "content_block_start" &&
					event.content_block?.type === "tool_use"
				) {
					yield {
						type: "tool_use",
						name: event.content_block.name,
						input: event.content_block.input as Record<string, unknown>,
						id: event.content_block.id,
					};
				} else if (event.type === "message_start") {
				} else if (event.type === "message_delta") {
					if (event.delta?.stop_reason === "end_turn") {
						const usage = (await stream.finalMessage()).usage;
						yield {
							type: "done",
							usage: {
								promptTokens: usage.input_tokens,
								completionTokens: usage.output_tokens,
							},
						};
					}
				} else if ((event as unknown as { type: string }).type === "error") {
					const error =
						(event as unknown as { error?: { message: string } }).error
							?.message || "Unknown error";
					yield { type: "error", content: toErrorMessage(new Error(error)) };
				}
			}
		} catch (e) {
			yield { type: "error", content: toErrorMessage(e) };
		}
	}
}
