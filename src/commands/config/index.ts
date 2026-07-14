import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { LocalCommandHandler } from "../../commands";

interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	maxTokens: number;
}

const CONFIG_DIR = join(homedir(), ".agentforge");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-4o",
	ollama: "llama3",
	openrouter: "gpt-4o",
};

const handler: LocalCommandHandler = {
	async call(): Promise<{ value: string }> {
		const lines: string[] = [];

		let config: ProviderConfig | null = null;
		if (existsSync(CONFIG_PATH)) {
			try {
				config = JSON.parse(
					readFileSync(CONFIG_PATH, "utf-8"),
				) as ProviderConfig;
			} catch {
				/* ignore */
			}
		}
		if (!config) {
			config = {
				type: "ollama",
				model: "llama3",
				baseUrl: "http://localhost:11434",
				maxTokens: 4096,
			};
		}

		lines.push(chalk.bold("AgentForge Configuration"));
		lines.push(chalk.dim(`  Provider: ${chalk.bold(config.type)}`));
		lines.push(chalk.dim(`  Model: ${chalk.bold(config.model)}`));
		if (config.apiKey)
			lines.push(chalk.dim(`  API Key: ${chalk.dim(maskKey(config.apiKey))}`));
		if (config.baseUrl)
			lines.push(chalk.dim(`  Base URL: ${chalk.bold(config.baseUrl)}`));
		lines.push(chalk.dim(`  Max Tokens: ${chalk.bold(config.maxTokens)}`));
		lines.push("");

		const rl = createInterface({ input, output });

		const providerChoice = await rl.question(
			chalk.dim(
				"Select provider (1=Anthropic, 2=OpenAI, 3=Ollama, 4=OpenRouter, Enter=keep): ",
			),
		);
		if (providerChoice.trim()) {
			type ProviderType = ProviderConfig["type"];
			const providerMap: Record<string, ProviderType> = {
				"1": "anthropic",
				"2": "openai",
				"3": "ollama",
				"4": "openrouter",
			};
			const type = providerMap[providerChoice.trim()] ?? config.type;
			config.type = type;
			config.model = DEFAULT_MODELS[type] ?? config.model;
			config.maxTokens = type === "ollama" ? 4096 : 8192;
			if (type === "ollama") config.baseUrl = "http://localhost:11434";
			else if (type === "openrouter")
				config.baseUrl = "https://openrouter.ai/api/v1";
			else {
				delete config.baseUrl;
			}

			if (type === "ollama" || type === "openrouter") {
				const url = await rl.question(
					chalk.dim(`Base URL [${config.baseUrl}]: `),
				);
				if (url.trim()) config.baseUrl = url.trim();
			} else {
				const key = await rl.question(chalk.dim(`API key for ${type}: `));
				if (key.trim()) config.apiKey = key.trim();
			}
		}

		const model = await rl.question(chalk.dim(`Model [${config.model}]: `));
		if (model.trim()) config.model = model.trim();

		rl.close();

		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
		lines.push(chalk.green("✓ Configuration saved."));

		return { value: lines.join("\n") };
	},
};

function maskKey(key?: string): string {
	if (!key) return "";
	if (key.length <= 8) return "*".repeat(key.length);
	return key.slice(0, 4) + "*".repeat(key.length - 8) + key.slice(-4);
}

export default handler;
