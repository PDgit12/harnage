import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	transport: "stdio" | "sse";
	url?: string;
}

export interface McpConfig {
	servers: Record<string, McpServerConfig>;
}

async function findInDir(dir: string): Promise<McpConfig | null> {
	const path = join(dir, ".mcp.json");
	try {
		await access(path);
		return JSON.parse(await readFile(path, "utf-8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn(
				`[harnage] Failed to read MCP config at ${path}:`,
				e instanceof Error ? e.message : e,
			);
		}
		return null;
	}
}

export async function resolveMcpConfig(): Promise<McpConfig> {
	const merged: McpConfig = { servers: {} };

	let cwd = process.cwd();
	while (cwd !== dirname(cwd)) {
		const cfg = await findInDir(cwd);
		if (cfg) Object.assign(merged.servers, cfg.servers);
		cwd = dirname(cwd);
	}

	const userCfg = await findInDir(join(homedir(), ".harnage"));
	if (userCfg) Object.assign(merged.servers, userCfg.servers);

	return merged;
}
