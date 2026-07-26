import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateCommandFiles } from "../generate/command-generator";
import { generateToolFiles } from "../generate/tool-generator";
import type { HarnessPlan } from "../index";
import type { ProjectContext } from "../spec/context";
import {
	ENGINE_TEMPLATE,
	EXAMPLE_SKILL,
	GENERATED_TUI,
	HARNESS_COMPACTION,
	HARNESS_EVAL,
	HARNESS_MCP_CLIENT,
	HARNESS_MEMORY,
	HARNESS_PERMISSIONS,
	HARNESS_PROFILES,
	HARNESS_SESSION,
	HARNESS_SKILLS,
	HARNESS_SUBAGENT,
	HARNESS_TRACE,
	PIPELINE_TEMPLATE,
} from "./harness-templates";
import {
	COMMANDS_REGISTRY,
	DEPLOY_MD_TEMPLATE,
	MAIN_ENTRY_TEMPLATE,
	MCP_JSON_EXAMPLE,
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
	/** True when the bespoke LLM pipeline produced the plan; false when the
	 *  build fell back to the offline keyword chassis (generic, no bespoke
	 *  tools/commands/skills). Lets the caller tell the user plainly. */
	usedLLM?: boolean;
	/** When usedLLM is false because the build brain errored, the reason
	 *  (e.g. a 429 rate limit) — so the fallback isn't silent. */
	fallbackReason?: string;
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
	_context?: ProjectContext,
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
	await writeFile(join(srcDir, "commands.ts"), COMMANDS_REGISTRY(plan));
	await writeFile(join(srcDir, "services/provider.ts"), PROVIDER_SERVICE);
	await writeFile(
		join(outputDir, "tsconfig.json"),
		JSON.stringify(TSCONFIG_TEMPLATE, null, 2),
	);
	await writeFile(join(outputDir, "vitest.config.ts"), VITEST_CONFIG);

	// Deliverable docs the customer's security team reads before a deployment.
	await writeFile(join(outputDir, "DEPLOY.md"), DEPLOY_MD_TEMPLATE(plan));
	await writeFile(join(outputDir, "SECURITY.md"), SECURITY_MD_TEMPLATE(plan));
	// Copy-template for MCP consumption — opt-in, see DEPLOY.md.
	await writeFile(join(outputDir, "mcp.json.example"), MCP_JSON_EXAMPLE);

	// MCP server recommendation: if the user accepted the interactive prompt,
	// write a real mcp.json; otherwise leave a discoverable note for later.
	if (plan.mcpServersToWrite && Object.keys(plan.mcpServersToWrite).length) {
		await writeFile(
			join(outputDir, "mcp.json"),
			JSON.stringify({ servers: plan.mcpServersToWrite }, null, 2),
		);
	} else if (plan.mcpRecommendations?.length) {
		const note = plan.mcpRecommendations
			.map((r) => `- **${r.name}** (\`${r.npmPackage}\`) — ${r.description}`)
			.join("\n");
		await writeFile(
			join(outputDir, "DEPLOY.md"),
			`${DEPLOY_MD_TEMPLATE(plan)}\n## Recommended MCP servers\n\nBased on this agent's description, these MCP servers might help — copy \`mcp.json.example\` to \`mcp.json\` and add the ones you want:\n\n${note}\n`,
		);
	}

	// Harness subsystems: engine + compaction, permissions, skills, session, sub-agents
	await writeFile(
		join(srcDir, "profiles.ts"),
		HARNESS_PROFILES(plan.modelProfileOverrides ?? {}, plan.name),
	);
	await writeFile(join(srcDir, "pipeline.ts"), PIPELINE_TEMPLATE(plan));
	await writeFile(join(srcDir, "engine.ts"), ENGINE_TEMPLATE(plan));
	await writeFile(join(srcDir, "compaction.ts"), HARNESS_COMPACTION);
	await writeFile(join(srcDir, "memory.ts"), HARNESS_MEMORY(plan));
	await writeFile(join(srcDir, "eval.ts"), HARNESS_EVAL);
	await writeFile(join(srcDir, "trace.ts"), HARNESS_TRACE(plan));
	await writeFile(join(srcDir, "permissions.ts"), HARNESS_PERMISSIONS(plan));
	await writeFile(join(srcDir, "skills.ts"), HARNESS_SKILLS);
	await writeFile(join(srcDir, "session.ts"), HARNESS_SESSION(plan));
	await writeFile(join(srcDir, "subagent.ts"), HARNESS_SUBAGENT);
	await writeFile(join(srcDir, "mcp-client.ts"), HARNESS_MCP_CLIENT(plan));
	await writeFile(join(srcDir, "ui.tsx"), GENERATED_TUI(plan));
	await mkdir(join(outputDir, "skills"), { recursive: true });
	await writeFile(
		join(outputDir, "skills", "verify-before-done.md"),
		EXAMPLE_SKILL(plan),
	);
	// Bespoke skills (procedural memory) the build brain planned for this domain,
	// rendered deterministically into the same frontmatter shape as the example.
	for (const skill of plan.customSkills ?? []) {
		const slug =
			skill.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40) || "skill";
		const md = `---\nname: ${slug}\ndescription: ${skill.name}\ntriggers: ${skill.trigger ?? ""}\n---\n${skill.guidance}\n`;
		await writeFile(join(outputDir, "skills", `${slug}.md`), md);
	}

	// The plan's system prompt IS the agent's identity — write it where the
	// generated engine loads it (cwd/.<name>/system.md). buildAgentSystemPrompt
	// already includes the "act, don't narrate" tool-discipline rules, so no
	// suffix is appended here (it would just waste the small-tier char budget).
	await mkdir(join(outputDir, `.${plan.name}`), { recursive: true });
	await writeFile(
		join(outputDir, `.${plan.name}`, "system.md"),
		`${plan.systemPrompt}\n`,
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

	// Note: system.md is written once above (.<plan.name>/system.md from
	// plan.systemPrompt = buildAgentSystemPrompt). The old second write here
	// (generateSystemMd → .harnage/system.md with DEFAULT_BLOCKS) produced a
	// duplicate file with WRONG tool names that the engine never loaded first
	// anyway — removed.

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
		// One retry: a transient network/registry blip during install otherwise
		// fails the whole build (observed as an empty node_modules + tsc noise).
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				execSync("bun install", {
					cwd: outputDir,
					stdio: "pipe",
					timeout: 120000,
				});
				break;
			} catch (e: unknown) {
				if (attempt === 1) continue;
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
		// bun run prints the script line ("$ tsc --noEmit") to stderr while tsc
		// emits its diagnostics on stdout — join both so the repair loop actually
		// sees the type errors it must fix.
		const detail = [err.stderr?.toString(), err.stdout?.toString()]
			.filter((s): s is string => !!s?.trim())
			.join("\n");
		errors.push(`TypeScript build failed: ${detail || err.message}`);
	}

	return {
		success: errors.length === 0,
		outputDir,
		errors,
	};
}
