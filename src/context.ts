import { execSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface SystemContext {
	cwd: string;
	gitStatus: string;
	projectFiles: string[];
	availableTools: string[];
	systemPrompt: string;
}

export async function buildContext(): Promise<SystemContext> {
	const cwd = process.cwd();

	let gitStatus = "";
	try {
		gitStatus = execSync("git status --porcelain 2>/dev/null", {
			encoding: "utf-8",
		}).trim();
	} catch (e) {
		console.warn("[agentforge]", (e as Error).message);
	}

	let projectFiles: string[] = [];
	try {
		projectFiles = (await readdir(cwd)).filter((f) => !f.startsWith("."));
	} catch (e) {
		console.warn("[agentforge]", (e as Error).message);
	}

	const toolsDir = join(import.meta.dirname, "tools");
	let availableTools: string[] = [];
	try {
		availableTools = (await readdir(toolsDir)).filter((f) =>
			f.endsWith("Tool"),
		);
	} catch (e) {
		console.warn("[agentforge]", (e as Error).message);
	}

	const systemPrompt = [
		`You are AgentForge, an AI coding agent operating in ${cwd}.`,
		gitStatus ? `Git status:\n${gitStatus}` : "",
		`Project files: ${projectFiles.join(", ")}`,
		`Available tools: ${availableTools.join(", ")}`,
	]
		.filter(Boolean)
		.join("\n\n");

	return { cwd, gitStatus, projectFiles, availableTools, systemPrompt };
}
