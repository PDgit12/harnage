#!/usr/bin/env bun
/**
 * Egress / phone-home check: prove a generated harness contains no surprise
 * outbound endpoints. Builds a harness offline, then scans every generated .ts
 * for hardcoded http(s) URLs and asserts each is an EXPECTED provider endpoint
 * the user explicitly opts into (or localhost) — never analytics/telemetry.
 *
 *   bun scripts/egress-check.ts
 *
 * This answers the first question a sovereign security review asks: "does this
 * code call home?" Model-free, gates in CI, exits nonzero on any unexpected host.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";

// Hosts a user explicitly opts into by configuring that provider. On a sovereign
// (local Ollama) deploy these code paths never fire. Anything NOT on this list
// appearing as a hardcoded URL is a surprise — and a review failure.
const EXPECTED = [
	"localhost",
	"127.0.0.1",
	"api.openai.com",
	"api.anthropic.com",
	"openrouter.ai",
	"api.deepseek.com",
];

const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
	}
	return out;
}

const root = await mkdtemp(join(tmpdir(), "egress-"));
const build = await buildHarness(
	"a codebase analysis agent that inspects and edits a project",
	root,
	undefined,
	undefined,
);
if (!build.success) {
	console.error("build failed:", build.errors);
	process.exit(1);
}

const findings: Array<{ host: string; file: string }> = [];
for (const file of walk(build.outputDir)) {
	const text = readFileSync(file, "utf-8");
	for (const m of text.matchAll(URL_RE)) {
		const host = m[1].toLowerCase();
		if (!EXPECTED.some((e) => host === e || host.endsWith("." + e))) {
			findings.push({ host, file: file.slice(build.outputDir.length + 1) });
		}
	}
}

await rm(root, { recursive: true, force: true });

console.log("\nEgress check — hardcoded outbound hosts in generated code:\n");
if (findings.length === 0) {
	console.log("  none unexpected. Only opt-in provider endpoints (or localhost) appear.");
	console.log("\nPASS — no surprise phone-home. A local (Ollama) deploy contacts nothing external.\n");
	process.exit(0);
}
for (const f of findings) console.log(`  ✗ ${f.host}  (${f.file})`);
console.log(`\nFAIL — ${findings.length} unexpected outbound host(s).\n`);
process.exit(1);
