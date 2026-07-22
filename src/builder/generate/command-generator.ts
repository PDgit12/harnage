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
	exit: `import { disconnectMcp } from "../mcp-client.ts";

export async function call(_args: string[], _context: unknown): Promise<{ value: string }> {
  await disconnectMcp();
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
	loop: `import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Explicit, discoverable entry point for an autonomous multi-step run: same
// engine and safety rails (max iterations, cost ceiling) a plain goal already
// uses, but with live step-by-step progress streamed to the console instead
// of a silent wait for the final answer. Respects the SAME persisted
// permission policy as everything else — set mode:"auto" in
// ~/.<name>/permissions.json for a fully unattended run, or leave it at
// "default" to have risky calls denied outright (no UI to escalate a
// permission prompt to from inside a command).
//
// KNOWN LIMITATION: this starts a fresh transcript, separate from whatever
// you've already discussed in this session — it does not share or extend the
// REPL's ongoing conversation (same trade-off /calibrate already makes for
// its own throwaway runs). Run it as your first action if you want it to have
// full context, or just accept a clean-slate autonomous task.
export async function call(args: string[], _context: unknown): Promise<{ value: string }> {
  const goal = args.join(" ").trim();
  const usage =
    "Usage: /loop <goal>\\n\\n" +
    "Runs an autonomous multi-step task under the harness's normal safety rails\\n" +
    "(max iterations, cost ceiling). Progress streams live as it works.\\n" +
    "Ctrl+C exits once the current step finishes — same as any other in-flight\\n" +
    "goal, it does NOT cancel mid-step. Tool calls are gated by the same\\n" +
    "permission policy as everything else — set mode to \\"auto\\" in\\n" +
    "permissions.json for a fully unattended run.\\n\\n" +
    "This starts a fresh transcript, separate from your current conversation.";
  if (!goal) return { value: usage };
  // "/loop --resume" is not a thing — --resume is a process-level CLI flag
  // read once at startup, not something this command can act on. A model
  // never sees this string; catch it before it's handed over as a fake goal.
  if (goal.startsWith("-")) {
    return {
      value:
        \`"\${goal}" looks like a CLI flag, not a goal — /loop doesn't take flags.\\n\` +
        "To resume an interrupted run: exit this session and relaunch with\\n" +
        "  bun start --resume",
    };
  }

  const [{ getAllTools }, { LoopEngine }, pkgMod] = await Promise.all([
    import("../tools"),
    import("../engine"),
    import("../../package.json"),
  ]);
  const pkgName = (pkgMod as { name?: string }).name ?? (pkgMod as { default?: { name?: string } }).default?.name ?? "harness";

  // Mirrors resolveProviderConfig() in main.tsx: config.json never stores
  // apiKey (deliberately, per ensureConfig's own "never persist apiKey to
  // disk" comment) — it only ever lives in the env var. Re-deriving type/
  // model/baseUrl from config.json but forgetting the env-var key would
  // silently hand the engine a config with no credentials at all.
  //
  // Default to ollama, not openrouter: a harness running purely on local
  // auto-detected models never writes config.json at all (this is the
  // COMMON case, not the edge case) — defaulting to a remote provider here
  // would wrongly demand an API key for a session that's working fine
  // without one.
  const configPath = join(homedir(), \`.\${pkgName}\`, "config.json");
  let providerConfig: Record<string, unknown> = { type: "ollama", model: "llama3", baseUrl: "http://localhost:11434", maxTokens: 4096 };
  if (existsSync(configPath)) {
    try {
      providerConfig = { ...providerConfig, ...JSON.parse(readFileSync(configPath, "utf-8")) };
    } catch { /* fall back to defaults */ }
  }
  const envKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  if (envKey) providerConfig.apiKey = envKey;
  else if (providerConfig.type !== "ollama") {
    // No key anywhere for a non-local provider — fail loud now instead of
    // letting every provider call inside the loop fail with a confusing auth
    // error, one iteration at a time, until the safety rails give up.
    return {
      value:
        \`No API key found for provider "\${providerConfig.type}". Set OPENROUTER_API_KEY \` +
        "or OPENAI_API_KEY, or switch to a local model with /model.",
    };
  }

  const tools = await getAllTools();
  console.log("\\x1b[2mStarting autonomous loop — live progress below.\\x1b[0m\\n");

  const engine = new LoopEngine({
    tools,
    providerConfig: providerConfig as never,
    onEvent: (ev: { type: string; content?: string; toolName?: string; toolInput?: unknown }) => {
      if (ev.type === "status") console.log(\`\\x1b[2m… \${ev.content}\\x1b[0m\`);
      else if (ev.type === "text" && ev.content) process.stdout.write(ev.content);
      else if (ev.type === "tool_use") console.log(\`\\n\\x1b[36m→ \${ev.toolName}\\x1b[0m \${JSON.stringify(ev.toolInput ?? {}).slice(0, 200)}\`);
      else if (ev.type === "tool_done") console.log(\`\\x1b[32m✓ \${ev.toolName}\\x1b[0m\`);
    },
  });

  const result = await engine.run(goal);
  return { value: "\\n" + result };
}
`,
};

function normalizeCommandId(name: string): string {
	return name
		.toLowerCase()
		.replace(/^\//, "")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 30);
}

export async function generateCommandFiles(
	plan: HarnessPlan,
	outputDir: string,
): Promise<void> {
	const cmdsDir = join(outputDir, "commands");
	await mkdir(cmdsDir, { recursive: true });

	const writtenCommands = new Set<string>();
	// A build-brain-authored custom command (e.g. a domain "loop" step) takes
	// priority over the generic reserved-name template of the same id — it's
	// written separately, later, via extraFiles in assemble/index.ts, and
	// would otherwise silently overwrite (or be silently overwritten by,
	// depending on write order) whichever version force-writes here. Skip the
	// generic one outright and say so, rather than let either clobber the
	// other with no signal.
	const customIds = new Set(
		(plan.customCommands ?? []).map((c) => normalizeCommandId(c.name)),
	);
	if (customIds.has("loop")) {
		console.warn(
			"A custom command named 'loop' collides with the built-in autonomous-loop command — skipping the generic /loop, keeping the custom one.",
		);
	}

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
	if (!writtenCommands.has("loop") && !customIds.has("loop")) {
		await writeFile(join(cmdsDir, "loop.ts"), `${COMMAND_TEMPLATES.loop}\n`);
		writtenCommands.add("loop");
	}
}
