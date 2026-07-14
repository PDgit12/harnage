import { resolve } from "node:path";

export interface SandboxConfig {
	allowedCommands: string[];
	blockedCommands: string[];
	maxCpuTimeMs: number;
	maxOutputSize: number;
	allowNetwork: boolean;
	allowWriteToPaths: string[];
	blockWriteToPaths: string[];
	cwd?: string;
}

export interface SandboxResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	sandboxViolation?: string;
}

const DEFAULT_CONFIG: SandboxConfig = {
	allowedCommands: [],
	blockedCommands: ["rm", "dd", "mkfs", "reboot", "shutdown", "halt"],
	maxCpuTimeMs: 10_000,
	maxOutputSize: 1_000_000,
	allowNetwork: false,
	allowWriteToPaths: [],
	blockWriteToPaths: ["/", "/etc", "/usr", "/bin", "/boot", "/dev"],
};

const NETWORK_COMMANDS = new Set([
	"curl",
	"wget",
	"nc",
	"netcat",
	"ssh",
	"scp",
	"sftp",
	"ftp",
	"telnet",
]);

function baseCommand(cmd: string): string {
	return cmd.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
}

function isWriteToBlockedPath(cmd: string, blocked: string[]): boolean {
	if (blocked.length === 0) return false;
	const re = /(?:>+|>>?|tee)\s+(\S+)/g;
	for (const m of cmd.matchAll(re)) {
		try {
			const p = resolve(m[1]);
			if (blocked.some((b) => p.startsWith(resolve(b)))) return true;
		} catch (e) {
			console.warn("[harnage]", (e as Error).message);
		}
	}
	return false;
}

async function readStream(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let result = "";
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			if (total + text.length > limit) {
				result += text.slice(0, limit - total);
				break;
			}
			result += text;
			total += text.length;
		}
	} finally {
		reader.cancel();
	}
	return result;
}

export async function runSandboxed(
	command: string,
	config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const start = performance.now();
	const base = baseCommand(command);

	if (cfg.allowedCommands.length > 0 && !cfg.allowedCommands.includes(base)) {
		return {
			stdout: "",
			stderr: "",
			exitCode: 1,
			durationMs: 0,
			sandboxViolation: `Command '${base}' not in allow list`,
		};
	}

	if (cfg.blockedCommands.includes(base)) {
		return {
			stdout: "",
			stderr: "",
			exitCode: 1,
			durationMs: 0,
			sandboxViolation: `Command '${base}' is blocked by sandbox policy`,
		};
	}

	if (!cfg.allowNetwork && NETWORK_COMMANDS.has(base)) {
		return {
			stdout: "",
			stderr: "",
			exitCode: 1,
			durationMs: 0,
			sandboxViolation: "Network commands are blocked by sandbox policy",
		};
	}

	if (isWriteToBlockedPath(command, cfg.blockWriteToPaths)) {
		return {
			stdout: "",
			stderr: "",
			exitCode: 1,
			durationMs: 0,
			sandboxViolation: "Write to blocked path rejected by sandbox",
		};
	}

	// ponytail: no OS-level containerization (Docker/nsjail). Bun.spawn runs
	// with host process permissions. Policy-only sandbox (command blocklist,
	// write-path deny list). Add Docker sandbox wrapper if multi-tenant usage
	// is required.
	const proc = Bun.spawn(["bash", "-c", command], {
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(cfg.maxCpuTimeMs),
		cwd: cfg.cwd,
		env: {
			...process.env,
			PATH: "/usr/bin:/bin",
			...(cfg.allowNetwork ? {} : { NO_NETWORK: "1" }),
		},
	});

	const [stdout, stderr] = await Promise.all([
		readStream(proc.stdout, cfg.maxOutputSize),
		readStream(proc.stderr, cfg.maxOutputSize),
	]);

	return {
		stdout,
		stderr,
		exitCode: await proc.exited,
		durationMs: performance.now() - start,
	};
}
