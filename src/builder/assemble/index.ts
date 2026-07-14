import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BLOCKS, generateSystemMd } from "../../services/system-prompt";
import { generateCommandFiles } from "../generate/command-generator";
import { generateToolFiles } from "../generate/tool-generator";
import type { HarnessPlan } from "../index";
import type { StructuredSpec } from "../spec";
import type { ProjectContext } from "../spec/context";
import {
	ENGINE_TEMPLATE,
	EXAMPLE_SKILL,
	GENERATED_TUI,
	HARNESS_COMPACTION,
	HARNESS_PERMISSIONS,
	HARNESS_PROFILES,
	HARNESS_SESSION,
	HARNESS_SKILLS,
	HARNESS_SUBAGENT,
	PIPELINE_TEMPLATE,
} from "./harness-templates";
import {
	COMMANDS_REGISTRY,
	DEPLOY_MD_TEMPLATE,
	MAIN_ENTRY_TEMPLATE,
	PACKAGE_JSON_TEMPLATE,
	PROVIDER_SERVICE,
	SECURITY_MD_TEMPLATE,
	TOOL_TYPESCRIPT,
	TOOLS_REGISTRY,
	TSCONFIG_TEMPLATE,
	VITEST_CONFIG,
} from "./templates";

export interface BuildResult {
	success: boolean;
	outputDir: string;
	errors: string[];
	/** Repair iterations consumed by the verify-repair loop, if it ran. */
	repairs?: number;
}

export const BASE_FILES: Array<{
	path: string;
	purpose: string;
	deps: string[];
}> = [
	{ path: "package.json", purpose: "project manifest with deps", deps: [] },
	{ path: "tsconfig.json", purpose: "TypeScript configuration", deps: [] },
	{
		path: "src/main.tsx",
		purpose: "CLI entry point with commander",
		deps: ["commander"],
	},
	{ path: "src/Tool.ts", purpose: "Tool type definitions", deps: [] },
	{ path: "src/tools.ts", purpose: "tool registry and loader", deps: [] },
	{ path: "src/commands.ts", purpose: "command registry and parser", deps: [] },
	{
		path: "src/services/provider.ts",
		purpose: "LLM provider abstraction",
		deps: [],
	},
	{ path: "vitest.config.ts", purpose: "test configuration", deps: [] },
];

export async function assembleAndVerify(
	plan: HarnessPlan,
	outputDir: string,
	context?: ProjectContext,
	extraFiles?: Array<{ path: string; code: string }>,
): Promise<BuildResult> {
	const errors: string[] = [];
	const srcDir = join(outputDir, "src");

	await mkdir(join(outputDir, "src"), { recursive: true });
	await mkdir(join(srcDir, "tools"), { recursive: true });
	await mkdir(join(srcDir, "commands"), { recursive: true });
	await mkdir(join(srcDir, "services"), { recursive: true });

	await writeFile(
		join(outputDir, "package.json"),
		JSON.stringify(PACKAGE_JSON_TEMPLATE(plan), null, 2),
	);

	await writeFile(join(srcDir, "main.tsx"), MAIN_ENTRY_TEMPLATE(plan));
	await writeFile(join(srcDir, "Tool.ts"), TOOL_TYPESCRIPT);
	await writeFile(join(srcDir, "tools.ts"), TOOLS_REGISTRY(plan));
	await writeFile(join(srcDir, "commands.ts"), COMMANDS_REGISTRY);
	await writeFile(join(srcDir, "services/provider.ts"), PROVIDER_SERVICE);
	await writeFile(
		join(outputDir, "tsconfig.json"),
		JSON.stringify(TSCONFIG_TEMPLATE, null, 2),
	);
	await writeFile(join(outputDir, "vitest.config.ts"), VITEST_CONFIG);

	// Deliverable docs the customer's security team reads before a deployment.
	await writeFile(join(outputDir, "DEPLOY.md"), DEPLOY_MD_TEMPLATE(plan));
	await writeFile(join(outputDir, "SECURITY.md"), SECURITY_MD_TEMPLATE(plan));

	// Harness subsystems: engine + compaction, permissions, skills, session, sub-agents
	await writeFile(
		join(srcDir, "profiles.ts"),
		HARNESS_PROFILES(plan.modelProfileOverrides ?? {}),
	);
	await writeFile(join(srcDir, "pipeline.ts"), PIPELINE_TEMPLATE(plan));
	await writeFile(join(srcDir, "engine.ts"), ENGINE_TEMPLATE(plan));
	await writeFile(join(srcDir, "compaction.ts"), HARNESS_COMPACTION);
	await writeFile(join(srcDir, "permissions.ts"), HARNESS_PERMISSIONS(plan));
	await writeFile(join(srcDir, "skills.ts"), HARNESS_SKILLS);
	await writeFile(join(srcDir, "session.ts"), HARNESS_SESSION(plan));
	await writeFile(join(srcDir, "subagent.ts"), HARNESS_SUBAGENT);
	await writeFile(join(srcDir, "ui.tsx"), GENERATED_TUI(plan));
	await mkdir(join(outputDir, "skills"), { recursive: true });
	await writeFile(
		join(outputDir, "skills", "verify-before-done.md"),
		EXAMPLE_SKILL(plan),
	);

	// The plan's system prompt IS the agent's identity — write it where the
	// generated engine loads it (cwd/.<name>/system.md). Tool-discipline rule
	// appended: small local models narrate tool use unless told not to.
	await mkdir(join(outputDir, `.${plan.name}`), { recursive: true });
	await writeFile(
		join(outputDir, `.${plan.name}`, "system.md"),
		`${plan.systemPrompt}\n\n## Tool discipline\nYou have real tools. NEVER describe or announce what you will do — emit the function call immediately. Text responses are ONLY for final answers or questions to the user. When the user gives you a path or task, act on it with a tool call in the same turn.\n`,
	);

	await generateToolFiles(plan, srcDir);
	await generateCommandFiles(plan, srcDir);

	// LLM-generated custom files (GENERATE stage) — paths constrained to src/
	for (const f of extraFiles ?? []) {
		const abs = join(srcDir, f.path);
		if (!abs.startsWith(srcDir) || f.path.includes("..")) continue;
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, f.code);
	}

	if (context) {
		const displayName = plan.description.replace(/[.,!?;:].*$/, "").trim();
		const spec: StructuredSpec = {
			name: displayName,
			purpose: plan.description,
			tools: plan.tools,
			commands: plan.commands,
			language: [],
			models: ["ollama"],
		};
		await generateSystemMd(outputDir, DEFAULT_BLOCKS, spec, context);
	}

	const verify = await verifyBuild(outputDir);
	errors.push(...verify.errors);

	return {
		success: errors.length === 0,
		outputDir,
		errors,
	};
}

/**
 * Run install + typecheck in an already-assembled output dir. Split from
 * assembleAndVerify so the repair loop can re-verify without rewriting
 * template files (which would clobber applied patches).
 */
export async function verifyBuild(
	outputDir: string,
	opts?: { skipInstall?: boolean },
): Promise<BuildResult> {
	const errors: string[] = [];

	if (!opts?.skipInstall) {
		try {
			execSync("bun install", {
				cwd: outputDir,
				stdio: "pipe",
				timeout: 120000,
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e : new Error(String(e));
			const err = msg as {
				stderr?: { toString(): string };
				stdout?: { toString(): string };
				message?: string;
			};
			errors.push(
				`bun install failed: ${err.stderr?.toString() ?? err.message}`,
			);
		}
	}

	try {
		execSync("bun run typecheck", {
			cwd: outputDir,
			stdio: "pipe",
			timeout: 60000,
			encoding: "utf-8",
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e : new Error(String(e));
		const err = msg as {
			stderr?: { toString(): string };
			stdout?: { toString(): string };
			message?: string;
		};
		errors.push(
			`TypeScript build failed: ${err.stderr?.toString() ?? err.stdout?.toString() ?? err.message}`,
		);
	}

	return {
		success: errors.length === 0,
		outputDir,
		errors,
	};
}
