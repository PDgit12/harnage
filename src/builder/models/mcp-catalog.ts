/**
 * MCP server catalog — a RECOMMENDATION layer, not a whitelist.
 *
 * Mirrors models/catalog.ts: a small curated shortlist of real, npm-installable
 * MCP servers, keyword-matched against the agent's spec/description to surface
 * 2-4 relevant picks during the interview or plan stage. Nothing is required —
 * the build works with zero MCP servers; this just makes discovery easy.
 *
 * Every npmPackage below was verified installable on npm before being listed
 * (no invented server names).
 */

export interface McpCatalogEntry {
	/** Short id shown to the user and used as the mcp.json server key. */
	name: string;
	/** Real, npm-installable package name. */
	npmPackage: string;
	/** Subprocess command the harness spawns (stdio transport). */
	command: string;
	/** Args passed to command — npx -y <package> for zero-install-step use. */
	args: string[];
	/** One-line rationale shown to the user. */
	description: string;
	/** Keywords matched against the agent's spec/description text. */
	keywords: string[];
}

export const MCP_CATALOG: McpCatalogEntry[] = [
	{
		name: "github",
		npmPackage: "@modelcontextprotocol/server-github",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-github"],
		description: "Manage GitHub issues, PRs, repos, and code search",
		keywords: [
			"github",
			"git",
			"issue",
			"pull request",
			"pr ",
			"repo",
			"repository",
		],
	},
	{
		name: "filesystem",
		npmPackage: "@modelcontextprotocol/server-filesystem",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem"],
		description: "Read/write files on disk beyond the harness's own sandbox",
		keywords: ["file", "filesystem", "directory", "folder", "disk"],
	},
	{
		name: "slack",
		npmPackage: "@modelcontextprotocol/server-slack",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-slack"],
		description: "Post messages and read channels in Slack",
		keywords: ["slack", "channel", "dm", "workspace message"],
	},
	{
		name: "postgres",
		npmPackage: "@modelcontextprotocol/server-postgres",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-postgres"],
		description: "Query and inspect a Postgres database",
		keywords: ["postgres", "postgresql", "sql", "database", "db query"],
	},
	{
		name: "puppeteer",
		npmPackage: "@modelcontextprotocol/server-puppeteer",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-puppeteer"],
		description: "Drive a headless browser — navigate, click, screenshot",
		keywords: ["browser", "puppeteer", "scrape", "screenshot", "web page"],
	},
	{
		name: "playwright",
		npmPackage: "@playwright/mcp",
		command: "npx",
		args: ["-y", "@playwright/mcp"],
		description: "Browser automation and end-to-end testing via Playwright",
		keywords: ["playwright", "e2e", "browser test", "automate browser"],
	},
	{
		name: "brave-search",
		npmPackage: "@modelcontextprotocol/server-brave-search",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-brave-search"],
		description: "Web search via the Brave Search API",
		keywords: [
			"search the web",
			"web search",
			"brave search",
			"google",
			"lookup online",
		],
	},
	{
		name: "memory",
		npmPackage: "@modelcontextprotocol/server-memory",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-memory"],
		description: "Persistent knowledge-graph memory across sessions",
		keywords: ["memory", "knowledge graph", "remember", "long-term"],
	},
	{
		name: "sequential-thinking",
		npmPackage: "@modelcontextprotocol/server-sequential-thinking",
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
		description: "Structured step-by-step reasoning for complex problems",
		keywords: [
			"reasoning",
			"step by step",
			"planning",
			"complex problem",
			"chain of thought",
		],
	},
];

export interface McpRecommendation {
	name: string;
	npmPackage: string;
	command: string;
	args: string[];
	description: string;
}

/**
 * Keyword-match an agent's spec/description text against the MCP catalog,
 * returning 2-4 relevant servers. Empty if nothing matches — MCP is opt-in,
 * never forced on an unrelated agent.
 */
export function recommendMcpServers(promptText: string): McpRecommendation[] {
	const t = promptText.toLowerCase();
	return MCP_CATALOG.filter((e) => e.keywords.some((k) => t.includes(k)))
		.slice(0, 4)
		.map((e) => ({
			name: e.name,
			npmPackage: e.npmPackage,
			command: e.command,
			args: e.args,
			description: e.description,
		}));
}
