import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessPlan } from "../index";

export const toolTemplates: Record<string, string> = {
	bash: `import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  cwd: z.string().optional().describe("Working directory"),
  timeout: z.number().optional().describe("Timeout in milliseconds"),
});

// Opt-in container isolation. Set HARNAGE_SANDBOX=docker to run every command
// inside a throwaway container with no network and only the working dir mounted
// (image via HARNAGE_SANDBOX_IMAGE, default node:20-alpine). The command is
// passed as a single argv element to \`sh -lc <cmd>\`, never interpolated into a
// host shell, so the host is not exposed to command injection.
async function runSandboxed(command: string, cwd: string, timeoutMs: number) {
  const image = process.env.HARNAGE_SANDBOX_IMAGE ?? "node:20-alpine";
  const args = ["run", "--rm", "--network", "none", "-v", cwd + ":/work", "-w", "/work", image, "sh", "-lc", command];
  try {
    return await execFileAsync("docker", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "ENOENT") {
      throw new Error("HARNAGE_SANDBOX=docker is set but 'docker' was not found on PATH. Start Colima/Docker Desktop, or unset HARNAGE_SANDBOX.");
    }
    throw e;
  }
}

export const BashTool = {
  name: "bash",
  description: "Execute shell commands and return output",
  inputSchema,
  isReadOnly: (input: { command: string }) => {
    const readOnlyCommands = ["ls", "cat", "head", "tail", "echo", "pwd", "which", "whoami", "date", "git status", "git log"];
    return readOnlyCommands.some((cmd) => input.command.startsWith(cmd));
  },
  async call(input: { command: string; cwd?: string; timeout?: number }) {
    // Small models emit cwd:"" or cwd:"." — treat anything blank as the
    // process cwd instead of crashing execAsync with ENOENT.
    const cwd = input.cwd?.trim() ? input.cwd : process.cwd();
    const timeout = input.timeout ?? 30000;
    const { stdout, stderr } =
      process.env.HARNAGE_SANDBOX === "docker"
        ? await runSandboxed(input.command, cwd, timeout)
        : await execAsync(input.command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
    if (stderr) console.warn(stderr);
    return { data: stdout, content: stdout || stderr };
  },
};
`,
	file_read: `import { readFile } from "node:fs/promises";
import { z } from "zod";

const inputSchema = z.object({
  path: z.string().describe("Absolute path to the file"),
  offset: z.number().optional().describe("Line offset (0-indexed)"),
  limit: z.number().optional().describe("Max lines to read"),
});

export const FileReadTool = {
  name: "file_read",
  description: "Read the contents of a file",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { path: string; offset?: number; limit?: number }) {
    const content = await readFile(input.path, "utf-8");
    const lines = content.split("\\n");
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { data: lines.slice(start, end).join("\\n") };
  },
};
`,
	file_edit: `import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const inputSchema = z.object({
  path: z.string().describe("Absolute path to the file"),
  oldString: z.string().describe("Text to replace"),
  newString: z.string().describe("Replacement text"),
});

export const FileEditTool = {
  name: "file_edit",
  description: "Edit a file with string replacement",
  inputSchema,
  isReadOnly: () => false,
  async call(input: { path: string; oldString: string; newString: string }) {
    const content = await readFile(input.path, "utf-8");
    if (!content.includes(input.oldString)) {
      return { error: "oldString not found in file", content: "Error: Pattern not found" };
    }
    const result = content.replace(input.oldString, input.newString);
    await writeFile(input.path, result);
    return { data: { replaced: true }, content: "File updated." };
  },
};
`,
	file_write: `import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const inputSchema = z.object({
  path: z.string().describe("Absolute path to the file"),
  content: z.string().describe("File content to write"),
});

export const FileWriteTool = {
  name: "file_write",
  description: "Write content to a file (creates parent directories)",
  inputSchema,
  isReadOnly: () => false,
  async call(input: { path: string; content: string }) {
    await mkdir(dirname(input.path), { recursive: true });
    await writeFile(input.path, input.content, "utf-8");
    return { data: { written: true }, content: "File written." };
  },
};
`,
	glob: `import { z } from "zod";

const inputSchema = z.object({
  pattern: z.string().describe("Glob pattern to match (e.g. **/*.ts, src/**/*.md)"),
  path: z.string().optional().describe("Root directory"),
});

export const GlobTool = {
  name: "glob",
  description: "Find files matching a glob pattern",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { pattern: string; path?: string }) {
    try {
      const cwd = input.path ?? process.cwd();
      const glob = new Bun.Glob(input.pattern);
      const results = (await Array.fromAsync(glob.scan({ cwd }))).sort();
      return { data: results, content: results.join("\\n") };
    } catch (e) {
      return {
        content: \`Glob failed: \${e instanceof Error ? e.message : String(e)}\`,
        isError: true,
      };
    }
  },
};
`,
	grep: `import { spawn } from "node:child_process";
import { z } from "zod";

const inputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("Directory to search in"),
  include: z.string().optional().describe("File glob pattern (e.g. *.ts)"),
});

export const GrepTool = {
  name: "grep",
  description: "Search file contents with regex",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { pattern: string; path?: string; include?: string }) {
    const args = ["--line-number", "--with-filename", input.pattern, input.path ?? "."];
    if (input.include) args.push("--glob", input.include);
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise<number | Error>((resolve) => {
      child.on("error", (err) => resolve(err));
      child.on("close", (code) => resolve(code ?? 0));
    });
    if (status instanceof Error) {
      return { data: "", content: "ripgrep (rg) not found on PATH", isError: true };
    }
    if (status !== 0 && status !== 1) {
      return { data: "", content: stderr || "grep failed", isError: true };
    }
    return { data: output, content: output || "No matches found." };
  },
};
`,
	web_fetch: `import { z } from "zod";

const inputSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  format: z.enum(["markdown", "text", "html"]).optional().describe("Output format"),
});

export const WebFetchTool = {
  name: "web_fetch",
  description: "Fetch and render a web page",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { url: string; format?: string }) {
    const res = await fetch(input.url, {
      headers: { "User-Agent": "harnage/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: \`HTTP \${res.status}: \${res.statusText}\` };
    const text = await res.text();
    return { data: text, content: text.slice(0, 5000) };
  },
};
`,
	web_search: `import { z } from "zod";

const inputSchema = z.object({
  query: z.string().describe("Search query"),
  numResults: z.number().optional().describe("Number of results"),
});

export const WebSearchTool = {
  name: "web_search",
  description: "Search the web for information",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { query: string; numResults?: number }) {
    const apiKey = process.env.SEARCH_API_KEY;
    if (!apiKey) {
      return { data: [], content: "Web search requires SEARCH_API_KEY env var" };
    }
    const count = input.numResults ?? 5;
    const res = await fetch(
      \`https://serpapi.com/search?q=\${encodeURIComponent(input.query)}&api_key=\${apiKey}&num=\${count}\`
    ).catch(() => null);
    if (!res || !res.ok) {
      return { data: [], content: "Web search unavailable" };
    }
    const data = await res.json();
    return { data, content: JSON.stringify(data, null, 2) };
  },
};
`,
	test_runner: `import { execSync } from "node:child_process";
import { z } from "zod";

const inputSchema = z.object({
  command: z.string().describe("Test command to run (e.g. bun test)"),
  cwd: z.string().optional().describe("Working directory"),
});

export const TestRunnerTool = {
  name: "test_runner",
  description: "Run tests and collect results",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { command: string; cwd?: string }) {
    try {
      const result = execSync(input.command, {
        cwd: input.cwd,
        encoding: "utf-8",
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { data: result, content: result };
    } catch (e: unknown) {
      const err = e as { message?: string; stdout?: string; stderr?: string };
      return {
        error: err.message ?? String(e),
        content: err.stdout || err.stderr || err.message ?? String(e),
        isError: true,
      };
    }
  },
};
`,
	docker: `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  command: z.string().describe("Docker command (e.g. ps, build, run)"),
  args: z.string().describe("Docker arguments"),
});

export const DockerTool = {
  name: "docker",
  description: "Execute Docker commands",
  inputSchema,
  isReadOnly: (input: { command: string }) => ["ps", "images", "info", "version"].includes(input.command),
  async call(input: { command: string; args: string }) {
    // execFile with an argv array — no shell, so args can't inject via
    // \`;\`/\`&&\`/backticks the way a shell-interpolated \`docker \${cmd} \${args}\` would.
    const argv = [input.command, ...input.args.split(/\\s+/).filter(Boolean)];
    try {
      const { stdout, stderr } = await execFileAsync("docker", argv);
      if (stderr) console.warn(stderr);
      return { data: stdout, content: stdout || stderr };
    } catch (e: unknown) {
      const err = e as { message?: string; stdout?: string; stderr?: string };
      return { error: err.message ?? String(e), content: err.stdout || err.stderr || String(e), isError: true };
    }
  },
};
`,
	mcp: `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAllTools } from "../../tools.ts";

const inputSchema = z.object({
  action: z.enum(["serve", "list", "call"]).describe("MCP action"),
  serverName: z.string().optional().describe("Server name for serve action"),
  toolName: z.string().optional().describe("Tool name for call action"),
  args: z.string().optional().describe("JSON arguments for call action"),
});

export const MCPTool = {
  name: "mcp",
  description: "Manage MCP server connections",
  inputSchema,
  isReadOnly: () => true,
  async call(input: { action: string; serverName?: string; toolName?: string; args?: string }) {
    if (input.action === "list") {
      const tools = await getAllTools();
      return {
        data: tools.map(t => ({ name: t.name, description: t.description })),
        content: tools.map(t => \`  \${t.name}: \${t.description}\`).join("\\n"),
      };
    }
    return { data: null, content: "Use 'mcp serve' as a CLI subcommand to start the MCP server." };
  },
};
`,
};

export async function generateToolFiles(
	plan: HarnessPlan,
	outputDir: string,
): Promise<void> {
	const toolsDir = join(outputDir, "tools");
	await mkdir(toolsDir, { recursive: true });

	for (const tool of plan.tools) {
		const source = toolTemplates[tool];
		if (source) {
			const toolDir = join(
				toolsDir,
				`${tool.charAt(0).toUpperCase() + tool.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Tool`,
			);
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(
					toolDir,
					`${tool.charAt(0).toUpperCase() + tool.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Tool.ts`,
				),
				source,
			);
		}
	}
}
