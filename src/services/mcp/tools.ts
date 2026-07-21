import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../Tool";
import { McpClientManager } from "./client";
import { resolveMcpConfig } from "./config";

const mcpManager = new McpClientManager();

/** The one real, connected manager instance — callers that need to disconnect
 * on shutdown must use this, not construct a fresh McpClientManager (a new
 * instance has an empty client map, so disconnecting it is a silent no-op
 * and orphans the real stdio subprocess). */
export function getMcpManager(): McpClientManager {
	return mcpManager;
}

export async function loadMcpTools(): Promise<Tool[]> {
	const config = await resolveMcpConfig();
	if (!config.servers || Object.keys(config.servers).length === 0) return [];

	const names = Object.keys(config.servers);
	for (const name of names) {
		await mcpManager.connectServer(name, config.servers[name]);
	}

	const available = mcpManager.getAvailableTools();
	return available.map(
		({ server, tool }): Tool => ({
			name: `mcp__${server}__${tool}`,
			description: `MCP tool '${tool}' from server '${server}'`,
			inputSchema: z.object({
				arguments: z
					.record(z.string(), z.unknown())
					.describe("Arguments for the MCP tool"),
			}),
			isReadOnly: () => false,
			async call(
				input: Record<string, unknown>,
				_context: ToolContext,
			): Promise<ToolResult> {
				const args =
					"arguments" in input
						? (input.arguments as Record<string, unknown>)
						: input;
				const res = await mcpManager.callTool(server, tool, args ?? {});
				return { content: typeof res === "string" ? res : JSON.stringify(res) };
			},
		}),
	);
}
