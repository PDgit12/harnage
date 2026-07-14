import { AnthropicProvider } from "./providers/AnthropicProvider";
import { OllamaProvider } from "./providers/OllamaProvider";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import type { StreamEvent } from "./types";

export interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	apiKey?: string;
	baseUrl?: string;
	model: string;
	maxTokens: number;
	/** Context window size (Ollama num_ctx). Distinct from maxTokens, which bounds output. */
	contextTokens?: number;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface Provider {
	stream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
	): AsyncGenerator<StreamEvent>;
}

export function createProvider(config: ProviderConfig): Provider {
	switch (config.type) {
		case "anthropic":
			return new AnthropicProvider(config);
		case "openai":
			return new OpenAIProvider(config);
		case "openrouter":
			return new OpenAIProvider({
				...config,
				baseUrl: config.baseUrl || "https://openrouter.ai/api/v1",
			});
		case "ollama":
			return new OllamaProvider(config);
	}
}
