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
	calibrate: `// Measures the plugged-in model against the T1-T5 acceptance battery across
// loop-mode x edit-format combinations, then writes the winner to
// ~/.<name>/profile.json. resolveProfile() merges it on top of any baked
// per-model curation (measured > baked > base) so the harness reconfigures
// itself around the model that is ACTUALLY installed, not just its inferred
// family. Fail-safe: a missing/corrupt profile.json leaves resolveProfile's
// current behavior unchanged (see profiles.ts readCalibration()).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopMode, ModelProfile } from "../profiles";

interface CalibrationTask {
  id: string;
  goal: string;
  check: (out: string, fixtureDir: string) => boolean;
}

const TASKS: CalibrationTask[] = [
  {
    id: "T1 file census",
    goal: "Count the files in the current directory grouped by extension and report the totals.",
    check: (o) => /\\b(ts|js|md)\\b/.test(o) && /\\d/.test(o),
  },
  {
    id: "T2 targeted read",
    goal: "What does the file a.ts export? Read it and answer.",
    check: (o) => /greet/i.test(o),
  },
  {
    id: "T3 multi-step",
    goal: "Find the largest .ts file in the current directory and show its first few lines.",
    check: (o) => /LARGEST/.test(o) || /big\\.ts/.test(o),
  },
  {
    id: "T4 write path",
    goal: "Create a file named hello.txt containing exactly the text HELLO in the current directory.",
    check: (_o, fx) =>
      existsSync(join(fx, "hello.txt")) && /HELLO/.test(readFileSync(join(fx, "hello.txt"), "utf-8")),
  },
  {
    id: "T5 recovery",
    goal: "Read the file does-not-exist-42.ts and summarize it.",
    check: (o) =>
      /no (such )?file|not (be )?(found|exist)|does ?n'?t exist|could ?n'?t|couldn't|unable|cannot|can't find|isn'?t (there|present)/i.test(o),
  },
];

function writeFixture(dir: string): void {
  writeFileSync(join(dir, "a.ts"), "export function greet(): string {\\n  return 'hi';\\n}\\n");
  writeFileSync(join(dir, "b.js"), "module.exports = { ok: true };\\n");
  writeFileSync(join(dir, "readme.md"), "# Fixture\\nSample project.\\n");
  const big = "// LARGEST\\n" + Array.from({ length: 80 }, (_, i) => \`export const v\${i} = \${i};\`).join("\\n") + "\\n";
  writeFileSync(join(dir, "big.ts"), big);
}

const CANDIDATE_LOOPS: LoopMode[] = ["plan-act", "pipeline"];
const CANDIDATE_EDIT_FORMATS: Array<ModelProfile["editFormat"]> = ["search-replace", "whole-file"];

interface CandidateResult {
  loop: LoopMode;
  editFormat: ModelProfile["editFormat"];
  passCount: number;
  medianMs: number;
}

export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  const [{ resolveProfile }, { getAllTools }, { LoopEngine }, pkgMod] = await Promise.all([
    import("../profiles"),
    import("../tools"),
    import("../engine"),
    import("../../package.json"),
  ]);
  const pkgName = (pkgMod as { name?: string }).name ?? (pkgMod as { default?: { name?: string } }).default?.name ?? "harness";

  const configDir = join(homedir(), \`.\${pkgName}\`);
  const configPath = join(configDir, "config.json");
  let model = "llama3";
  let providerType: "ollama" | "openrouter" = "ollama";
  let baseUrl = "http://localhost:11434";
  let maxTokens = 4096;
  let contextTokens = 8192;
  if (existsSync(configPath)) {
    try {
      const saved = JSON.parse(readFileSync(configPath, "utf-8")) as {
        type?: "ollama" | "openrouter";
        model?: string;
        baseUrl?: string;
        maxTokens?: number;
        contextTokens?: number;
      };
      model = saved.model ?? model;
      providerType = saved.type ?? providerType;
      baseUrl = saved.baseUrl ?? baseUrl;
      maxTokens = saved.maxTokens ?? maxTokens;
      contextTokens = saved.contextTokens ?? contextTokens;
    } catch { /* fall back to defaults */ }
  }

  const before = resolveProfile(model, contextTokens);
  const lines: string[] = [
    "\\x1b[1mCalibrating " + model + "\\x1b[0m",
    \`Before: \${before.tier} tier · \${before.loop} loop · \${before.editFormat} edit-format\\n\`,
  ];

  const fixture = await mkdtemp(join(tmpdir(), "calibrate-"));
  writeFixture(fixture);
  const policy = {
    mode: "default" as const,
    rules: [
      { pattern: "bash(*)", allow: true },
      { pattern: "file_write(*)", allow: true },
      { pattern: "file_edit(*)", allow: true },
    ],
  };
  const providerConfig = { type: providerType, model, baseUrl, maxTokens, contextTokens };
  const tools = await getAllTools();

  const originalCwd = process.cwd();
  const results: CandidateResult[] = [];
  try {
    process.chdir(fixture);
    for (const loop of CANDIDATE_LOOPS) {
      for (const editFormat of CANDIDATE_EDIT_FORMATS) {
        const profile: ModelProfile = { ...before, loop, editFormat };
        let passCount = 0;
        const latencies: number[] = [];
        for (const task of TASKS) {
          const started = performance.now();
          let out = "";
          let err: string | undefined;
          try {
            const engine = new LoopEngine({ tools, providerConfig, profile, policy, persistSession: false });
            out = await engine.run(task.goal);
          } catch (e) {
            err = e instanceof Error ? e.message : String(e);
          }
          latencies.push(performance.now() - started);
          if (!err && task.check(out, fixture)) passCount++;
        }
        latencies.sort((a, b) => a - b);
        const medianMs = latencies[Math.floor(latencies.length / 2)] ?? 0;
        results.push({ loop, editFormat, passCount, medianMs });
        lines.push(\`  \${loop.padEnd(10)} \${editFormat.padEnd(14)} \${passCount}/\${TASKS.length} passed · median \${Math.round(medianMs)}ms\`);
      }
    }
  } finally {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  }

  results.sort((a, b) => b.passCount - a.passCount || a.medianMs - b.medianMs);
  const winner = results[0];
  if (!winner) {
    lines.push("\\n\\x1b[31mNo candidates ran — is the provider reachable?\\x1b[0m");
    return { value: lines.join("\\n") };
  }

  await mkdir(configDir, { recursive: true });
  const profilePath = join(configDir, "profile.json");
  writeFileSync(
    profilePath,
    JSON.stringify(
      {
        model,
        profile: { loop: winner.loop, editFormat: winner.editFormat },
        passCount: winner.passCount,
        totalTasks: TASKS.length,
        calibratedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const after = resolveProfile(model, contextTokens);
  lines.push(
    "",
    \`\\x1b[1mWinner:\\x1b[0m \${winner.loop} loop · \${winner.editFormat} edit-format · \${winner.passCount}/\${TASKS.length} passed\`,
    \`After:  \${after.tier} tier · \${after.loop} loop · \${after.editFormat} edit-format\`,
    \`\\x1b[2mSaved to \${profilePath}\\x1b[0m\`,
  );
  return { value: lines.join("\\n") };
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
	if (!writtenCommands.has("calibrate")) {
		await writeFile(
			join(cmdsDir, "calibrate.ts"),
			`${COMMAND_TEMPLATES.calibrate}\n`,
		);
		writtenCommands.add("calibrate");
	}
}
