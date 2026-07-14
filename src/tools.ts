import type { Tool } from "./Tool";

const toolModules = {
	BashTool: () => import("./tools/BashTool/BashTool"),
	FileReadTool: () => import("./tools/FileReadTool/FileReadTool"),
	FileEditTool: () => import("./tools/FileEditTool/FileEditTool"),
	FileWriteTool: () => import("./tools/FileWriteTool/FileWriteTool"),
	GlobTool: () => import("./tools/GlobTool/GlobTool"),
	GrepTool: () => import("./tools/GrepTool/GrepTool"),
	WebFetchTool: () => import("./tools/WebFetchTool/WebFetchTool"),
	WebSearchTool: () => import("./tools/WebSearchTool/WebSearchTool"),
	AgentTool: () => import("./tools/AgentTool/AgentTool"),
} as const;

export type ToolName = keyof typeof toolModules;

const toolNames: ToolName[] = Object.keys(toolModules) as ToolName[];

export function getTool(name: string): Promise<Tool> {
	const mod = toolModules[name as ToolName];
	if (!mod) {
		throw new Error(
			`Unknown tool: ${name}. Available: ${toolNames.join(", ")}`,
		);
	}
	return mod().then((m) => (m.default ?? m) as Tool);
}

export function getAllTools(): Promise<Tool[]> {
	return Promise.all(toolNames.map((name) => getTool(name)));
}

export function getToolNames(): string[] {
	return toolNames;
}
