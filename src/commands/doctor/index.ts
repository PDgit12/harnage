import chalk from "chalk";
import type { LocalCommandHandler } from "../../commands";
import { McpClientManager } from "../../services/mcp/client";
import { resolveMcpConfig } from "../../services/mcp/config";
import { checkOllamaHealth } from "../../services/ollama/discovery";

interface Check {
	label: string;
	status: "pass" | "fail" | "warn";
	detail: string;
}

async function checkApi(provider: string): Promise<Check> {
	const endpoints: Record<string, string> = {
		anthropic: "https://api.anthropic.com",
		openai: "https://api.openai.com",
	};
	const url = endpoints[provider];
	if (!url)
		return {
			label: `API: ${provider}`,
			status: "fail",
			detail: `Unknown provider: ${provider}`,
		};
	try {
		const res = await fetch(url, {
			method: "HEAD",
			signal: AbortSignal.timeout(5000),
		});
		return {
			label: `API: ${provider}`,
			status: "pass",
			detail: `${url} — ${res.status}`,
		};
	} catch (e) {
		return {
			label: `API: ${provider}`,
			status: "warn",
			detail: `${url} — ${(e as Error).message}`,
		};
	}
}

async function checkOllama(): Promise<Check> {
	const health = await checkOllamaHealth();
	if (health.running) {
		const modelList =
			health.models.length > 0
				? health.models.map((m) => chalk.cyan(m)).join(", ")
				: chalk.dim("none pulled yet");
		return {
			label: "Ollama",
			status: "pass",
			detail: `running ${chalk.dim(`${health.responseTimeMs}ms`)} — models: ${modelList}`,
		};
	}
	if (health.error?.includes("ECONNREFUSED")) {
		return {
			label: "Ollama",
			status: "fail",
			detail:
				"Ollama is not running. Install from https://ollama.ai or run `ollama serve`",
		};
	}
	return {
		label: "Ollama",
		status: "fail",
		detail: health.error
			? `${health.error}`
			: "not detected. Install at https://ollama.ai or run `ollama serve`",
	};
}

async function checkGit(): Promise<Check> {
	try {
		const proc = Bun.spawnSync(["git", "status", "--porcelain"]);
		const out = proc.stdout.toString().trim();
		if (!out)
			return {
				label: "Git",
				status: "pass",
				detail: "clean — no uncommitted changes",
			};
		return {
			label: "Git",
			status: "warn",
			detail: `${out.split("\n").length} uncommitted file(s)`,
		};
	} catch {
		return {
			label: "Git",
			status: "fail",
			detail: "not a git repository or git not found",
		};
	}
}

async function checkMcp(): Promise<Check> {
	try {
		const cfg = await resolveMcpConfig();
		const names = Object.keys(cfg.servers);
		if (names.length === 0)
			return { label: "MCP Servers", status: "warn", detail: "0 configured" };
		const mgr = new McpClientManager();
		let connected = 0;
		for (const name of names) {
			try {
				await mgr.connectServer(name, cfg.servers[name]);
				connected++;
			} catch {
				/* ignore */
			}
		}
		return {
			label: "MCP Servers",
			status: connected === names.length ? "pass" : "warn",
			detail: `${connected}/${names.length} connected`,
		};
	} catch {
		return {
			label: "MCP Servers",
			status: "fail",
			detail: "could not read config",
		};
	}
}

function checkSystem(): Check {
	const os = `${process.platform} (${process.arch})`;
	const node = process.version;
	const cpus = require("node:os").cpus().length;
	const mem = `${Math.round(require("node:os").totalmem() / 1024 ** 3)} GB`;
	return {
		label: "System",
		status: "pass",
		detail: `${os} · node ${node} · ${cpus} cores · ${mem}`,
	};
}

function checkProject(): Check {
	const fs = require("node:fs");
	const path = require("node:path");
	const root = process.cwd();
	function countFiles(dir: string): number {
		try {
			let count = 0;
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (
					e.isDirectory() &&
					!e.name.startsWith(".") &&
					e.name !== "node_modules"
				)
					count += countFiles(p);
				else if (e.isFile()) count++;
			}
			return count;
		} catch {
			return 0;
		}
	}
	const total = countFiles(root);
	const exts = new Set<string>();
	function scanExts(dir: string) {
		try {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (
					e.isDirectory() &&
					!e.name.startsWith(".") &&
					e.name !== "node_modules"
				)
					scanExts(p);
				else if (e.isFile()) {
					const ext = path.extname(e.name).replace(".", "");
					if (ext) exts.add(ext);
				}
			}
		} catch {
			/* ignore */
		}
	}
	scanExts(root);
	return {
		label: "Project",
		status: "pass",
		detail: `${total} files · ${[...exts].sort().join(", ")}`,
	};
}

function formatCheck(c: Check): string {
	const badge =
		c.status === "pass"
			? chalk.green("PASS")
			: c.status === "warn"
				? chalk.yellow("WARN")
				: chalk.red("FAIL");
	let line = `  ${badge}  ${chalk.bold(c.label)}  ${chalk.dim(c.detail)}`;
	if (c.label === "Ollama" && c.status === "fail") {
		line += `\n${chalk.dim("    Install: brew install ollama")}`;
		line += `\n${chalk.dim("    Or download from https://ollama.ai")}`;
		line += `\n${chalk.dim("    Start: ollama serve")}`;
	}
	return line;
}

const handler: LocalCommandHandler = {
	async call(_args: string[], _context: unknown): Promise<{ value: string }> {
		const results = await Promise.all([
			...["anthropic", "openai"].map((p) => checkApi(p)),
			checkOllama(),
			checkGit(),
			checkMcp(),
			Promise.resolve(checkSystem()),
			Promise.resolve(checkProject()),
		]);
		const lines = [chalk.bold.underline("System Diagnostics")];
		for (const c of results) lines.push(formatCheck(c));
		return { value: lines.join("\n") };
	},
};

export default handler;
