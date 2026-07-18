import { render } from "ink";
import { initEngine } from "../repl";
import type { ProviderConfig } from "../services/api/client";
import { loadMcpTools } from "../services/mcp/tools";
import type { Tool, ToolContext } from "../Tool";
import { getAllTools } from "../tools";
import { App } from "./App";

/** Launch the Ink TUI. Falls back to the classic readline REPL upstream. */
export async function startTui(
	config: ProviderConfig,
	resume = false,
): Promise<void> {
	const allTools = await getAllTools();
	const mcpTools = await loadMcpTools().catch(() => [] as Tool[]);
	allTools.push(...mcpTools);

	const { loadPolicy } = await import("../permissions");
	const toolContext: ToolContext = {
		cwd: process.cwd(),
		env: process.env as Record<string, string | undefined>,
		permissions: loadPolicy(),
		sandbox: "none",
		tools: allTools,
	};

	const engine = await initEngine(config, allTools, toolContext);

	let branch: string | undefined;
	try {
		const { execSync } = await import("node:child_process");
		branch =
			execSync("git branch --show-current", {
				stdio: "pipe",
				timeout: 2000,
			})
				.toString()
				.trim() || undefined;
	} catch {
		branch = undefined;
	}

	const { recoverLastLoop } = await import("../loop/persistence");
	const lastState = await recoverLastLoop();
	const unfinished =
		lastState && lastState.phase !== "done" && lastState.phase !== "failed"
			? lastState
			: undefined;

	const resumeState = resume ? unfinished : undefined;
	const unfinishedHint = resume ? undefined : unfinished?.goal;
	const noResumeFound = resume && !unfinished;

	const { waitUntilExit } = render(
		<App
			config={config}
			engine={engine}
			branch={branch}
			resumeState={resumeState}
			unfinishedHint={unfinishedHint}
			noResumeFound={noResumeFound}
		/>,
	);
	await waitUntilExit();
}
