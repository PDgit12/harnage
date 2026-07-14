import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config";

interface ToolDefinition {
	name: string;
	server: string;
}

export class McpClientManager {
	private clients = new Map<string, Client>();
	private toolsCache = new Map<string, ToolDefinition[]>();

	async connectServer(name: string, config: McpServerConfig): Promise<void> {
		if (this.clients.has(name))
			throw new Error(`Server "${name}" already connected`);

		const transport =
			config.transport === "sse" && config.url
				? new StreamableHTTPClientTransport(new URL(config.url))
				: new StdioClientTransport({
						command: config.command,
						args: config.args,
						env: config.env,
					});

		const client = new Client({ name: "harnage", version: "0.1.0" });
		await client.connect(transport);

		const toolsResult = await client.listTools();
		const tools: ToolDefinition[] = (toolsResult.tools ?? []).map((t) => ({
			name: t.name,
			server: name,
		}));
		this.toolsCache.set(name, tools);
		this.clients.set(name, client);
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const client = this.clients.get(serverName);
		if (!client) throw new Error(`Server "${serverName}" not connected`);
		const result = await client.callTool({ name: toolName, arguments: args });
		return result.content ?? result;
	}

	async disconnectServer(name: string): Promise<void> {
		const client = this.clients.get(name);
		if (!client) return;
		try {
			await client.close();
		} catch (e) {
			console.warn(
				`[harnage] Error closing MCP server "${name}":`,
				e instanceof Error ? e.message : e,
			);
		}
		this.clients.delete(name);
		this.toolsCache.delete(name);
	}

	getAvailableTools(): Array<{ server: string; tool: string }> {
		const result: Array<{ server: string; tool: string }> = [];
		for (const [server, tools] of this.toolsCache) {
			for (const t of tools) result.push({ server, tool: t.name });
		}
		return result;
	}
}
