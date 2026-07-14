import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionContext } from "./Tool";

export interface PermissionRule {
	pattern: string;
	allow: boolean;
}

const POLICY_PATH = join(homedir(), ".harnage", "permissions.json");

/**
 * Load the user's permission policy from ~/.harnage/permissions.json:
 *   { "mode": "default", "rules": [ { "pattern": "bash(bun *)", "allow": true } ] }
 * Defaults to bypass (current behavior) when no policy file exists — writing
 * a policy file is how a user opts in to path-rule enforcement.
 */
export function loadPolicy(): PermissionContext {
	if (existsSync(POLICY_PATH)) {
		try {
			const raw = JSON.parse(readFileSync(POLICY_PATH, "utf-8")) as {
				mode?: PermissionContext["mode"];
				rules?: PermissionRule[];
			};
			return { mode: raw.mode ?? "default", rules: raw.rules ?? [] };
		} catch {
			/* unreadable policy falls through to default */
		}
	}
	return { mode: "bypass", rules: [] };
}

/** "tool(glob)" pattern matcher: "*" within a segment, "**" across segments. */
function ruleMatches(
	rule: PermissionRule,
	toolName: string,
	target: string,
): boolean {
	const m = rule.pattern.match(/^([\w-]+)(?:\((.*)\))?$/);
	if (!m) return false;
	if (m[1].toLowerCase() !== toolName.toLowerCase() && m[1] !== "*")
		return false;
	const glob = m[2];
	if (glob === undefined || glob === "" || glob === "*" || glob === "**")
		return true;
	// "*" spans any characters (Claude Code Bash(rm *) semantics); "**" same.
	const re = new RegExp(
		`^${glob
			.split("**")
			.map((part) =>
				part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"),
			)
			.join(".*")}$`,
	);
	return re.test(target);
}

/** Pull the path/command-like argument from a tool input for rule matching. */
export function targetOf(input: unknown): string {
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		for (const key of ["path", "file_path", "command", "url", "pattern"]) {
			if (typeof o[key] === "string") return o[key] as string;
		}
	}
	return "";
}

/**
 * Rule verdict for a tool call: true = explicit allow, false = explicit deny,
 * undefined = no rule matched (fall through to the tool's own check).
 */
export function ruleVerdict(
	permissions: PermissionContext,
	toolName: string,
	input: unknown,
): { allowed: boolean; reason?: string } | undefined {
	const target = targetOf(input);
	for (const rule of permissions.rules ?? []) {
		if (ruleMatches(rule as PermissionRule, toolName, target)) {
			return (rule as PermissionRule).allow
				? { allowed: true }
				: { allowed: false, reason: `denied by rule: ${rule.pattern}` };
		}
	}
	return undefined;
}
