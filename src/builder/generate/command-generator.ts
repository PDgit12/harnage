import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPlan } from "../index";

export const COMMAND_TEMPLATES: Record<string, string> = {
	help: `export async function call(_args: string[], context: unknown): Promise<{ value: string }> {
  const { COMMANDS } = await import("../commands");
  const lines = [
    "\\x1b[1mAvailable Commands:\\x1b[0m\\n",
  ];
  for (const cmd of COMMANDS) {
    lines.push(\`  \\x1b[36m\${cmd.name}\\x1b[0m  \\x1b[2m\${cmd.description}\\x1b[0m\`);
  }
  lines.push("\\n\\x1b[2mType /<command> to run it.\\x1b[0m");
  return { value: lines.join("\\n") };
}
`,
	clear: `export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  console.clear();
  return { value: "\\x1b[2J\\x1b[H" };
}
`,
	exit: `export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  process.exit(0);
  return { value: "" };
}
`,
	model: `export async function call(args: string[], context: unknown): Promise<{ value: string }> {
  const services = await import("../services/provider");
  const [newModel] = args;

  if (newModel) {
    services.setActiveModel(newModel);
    return { value: \`Switched to model: \${newModel}\` };
  }

  const current = services.getActiveModel();
  const available = services.getAvailableModels();
  return {
    value: [
      "\\x1b[1mCurrent model:\\x1b[0m " + current,
      "\\n\\x1b[1mAvailable models:\\x1b[0m",
      ...available.map((m: string) => \`  - \${m}\`),
    ].join("\\n"),
  };
}
`,
	config: `import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  const rl = createInterface({ input: stdin, output: stdout });
  const lines: string[] = [];

  lines.push("\\x1b[1mConfiguration\\x1b[0m\\n");

  const provider = await rl.question("  Provider (anthropic/openai/ollama) [ollama]: ");
  lines.push(\`  Provider: \${provider || "ollama"}\`);

  const model = await rl.question("  Model [auto]: ");
  lines.push(\`  Model: \${model || "auto"}\`);

  if (provider !== "ollama") {
    const key = await rl.question("  API Key: ");
    lines.push(\`  API Key: \${key ? "***" : "(none)"}\`);
  }

  rl.close();
  lines.push("\\n\\x1b[32mConfig saved.\\x1b[0m");
  return { value: lines.join("\\n") };
}
`,
	cost: `export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  const { getCostTracker } = await import("../services/provider");
  const tracker = getCostTracker();
  return {
    value: [
      "\\x1b[1mCost & Usage\\x1b[0m\\n",
      \`  Tokens in:  \\x1b[36m\${tracker.tokensIn?.toLocaleString() ?? 0}\\x1b[0m\`,
      \`  Tokens out: \\x1b[36m\${tracker.tokensOut?.toLocaleString() ?? 0}\\x1b[0m\`,
      \`  Cost:       \\x1b[33m$\${(tracker.costUsd ?? 0).toFixed(4)}\\x1b[0m\`,
      \`  Requests:   \\x1b[35m\${tracker.requestCount ?? 0}\\x1b[0m\`,
    ].join("\\n"),
  };
}
`,
	doctor: `import { execSync } from "node:child_process";

export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  const checks: Array<{ label: string; status: string; detail: string }> = [];

  checks.push({ label: "Node.js", status: "\\x1b[32mOK\\x1b[0m", detail: process.version });

  try {
    const bunV = execSync("bun --version", { encoding: "utf-8" }).trim();
    checks.push({ label: "Bun", status: "\\x1b[32mOK\\x1b[0m", detail: bunV });
  } catch {
    checks.push({ label: "Bun", status: "\\x1b[31mMISSING\\x1b[0m", detail: "not found" });
  }

  try {
    const gitV = execSync("git --version", { encoding: "utf-8" }).trim();
    checks.push({ label: "Git", status: "\\x1b[32mOK\\x1b[0m", detail: gitV });
  } catch {
    checks.push({ label: "Git", status: "\\x1b[31mMISSING\\x1b[0m", detail: "not found" });
  }

  const hasOllama = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);
  checks.push({
    label: "Ollama",
    status: hasOllama ? "\\x1b[32mOK\\x1b[0m" : "\\x1b[33mNOT RUNNING\\x1b[0m",
    detail: hasOllama ? "connected" : "start with: ollama serve",
  });

  const lines = [
    "\\x1b[1mSystem Diagnostics\\x1b[0m\\n",
    ...checks.map(
      (c) => \`  \${c.status} \\x1b[1m\${c.label}\\x1b[0m  \\x1b[2m\${c.detail}\\x1b[0m\`,
    ),
  ];

  return { value: lines.join("\\n") };
}
`,
};

export async function generateCommandFiles(
	plan: HarnessPlan,
	outputDir: string,
): Promise<void> {
	const cmdsDir = join(outputDir, "commands");
	await mkdir(cmdsDir, { recursive: true });

	const writtenCommands = new Set<string>();

	for (const cmd of plan.commands) {
		const cleanName = cmd
			.replace(/^command_/, "")
			.replace(/^_/, "")
			.replace(/^-/, "");
		const template = COMMAND_TEMPLATES[cleanName];
		if (template) {
			await writeFile(join(cmdsDir, `${cleanName}.ts`), `${template}\n`);
			writtenCommands.add(cleanName);
		}
	}

	if (!writtenCommands.has("help")) {
		await writeFile(join(cmdsDir, "help.ts"), `${COMMAND_TEMPLATES.help}\n`);
		writtenCommands.add("help");
	}
	if (!writtenCommands.has("exit")) {
		await writeFile(join(cmdsDir, "exit.ts"), `${COMMAND_TEMPLATES.exit}\n`);
		writtenCommands.add("exit");
	}
	if (!writtenCommands.has("clear")) {
		await writeFile(join(cmdsDir, "clear.ts"), `${COMMAND_TEMPLATES.clear}\n`);
		writtenCommands.add("clear");
	}
	if (!writtenCommands.has("model")) {
		await writeFile(join(cmdsDir, "model.ts"), `${COMMAND_TEMPLATES.model}\n`);
		writtenCommands.add("model");
	}
	if (!writtenCommands.has("config")) {
		await writeFile(
			join(cmdsDir, "config.ts"),
			`${COMMAND_TEMPLATES.config}\n`,
		);
		writtenCommands.add("config");
	}
	if (!writtenCommands.has("cost")) {
		await writeFile(join(cmdsDir, "cost.ts"), `${COMMAND_TEMPLATES.cost}\n`);
		writtenCommands.add("cost");
	}
	if (!writtenCommands.has("doctor")) {
		await writeFile(
			join(cmdsDir, "doctor.ts"),
			`${COMMAND_TEMPLATES.doctor}\n`,
		);
		writtenCommands.add("doctor");
	}
}
