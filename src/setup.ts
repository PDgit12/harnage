import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";

export interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	maxTokens: number;
}

const DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-4o",
	ollama: "llama3",
	openrouter: "gpt-4o",
};

export async function setupWizard(): Promise<ProviderConfig> {
	const rl = createInterface({ input, output });

	console.log(chalk.bold("harnage v0.1.0"));
	console.log(chalk.dim("AI Model = Brain. Harness = Hands."));
	console.log(chalk.dim("Welcome! Let's set up your provider."));
	console.log("");

	const providerChoice = await rl.question(
		chalk.dim(
			"Select provider (1=Anthropic, 2=OpenAI, 3=Ollama, 4=OpenRouter): ",
		),
	);
	rl.close();

	type ProviderType = ProviderConfig["type"];
	const providerMap: Record<string, ProviderType> = {
		"1": "anthropic",
		"2": "openai",
		"3": "ollama",
		"4": "openrouter",
	};
	const type = providerMap[providerChoice.trim()] ?? "ollama";

	const config: ProviderConfig = {
		type,
		model: DEFAULT_MODELS[type] ?? "llama3",
		maxTokens: type === "ollama" ? 4096 : 8192,
	};

	if (type === "ollama") {
		config.baseUrl = "http://localhost:11434";
	} else if (type === "openrouter") {
		config.baseUrl = "https://openrouter.ai/api/v1";
	}

	const rl2 = createInterface({ input, output });

	if (type !== "ollama") {
		const apiKey = await rl2.question(chalk.dim(`API key for ${type}: `));
		if (apiKey.trim()) config.apiKey = apiKey.trim();
	}

	if (type === "ollama" || type === "openrouter") {
		const baseUrl = await rl2.question(
			chalk.dim(`Base URL [${config.baseUrl}]: `),
		);
		if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
	}

	const model = await rl2.question(chalk.dim(`Model [${config.model}]: `));
	if (model.trim()) config.model = model.trim();

	rl2.close();

	const configDir = join(homedir(), ".harnage");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "config.json"),
		JSON.stringify(config, null, 2),
	);

	console.log(chalk.green("✓ Configuration saved."));

	return config;
}
