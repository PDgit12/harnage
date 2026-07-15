import type { HarnessPlan } from "../index";

/**
 * Templates for the generated harness's subsystem modules — the features
 * that make a generated harness "properly built": context compaction,
 * path-rule permissions, skills-as-markdown, session persistence, and
 * sub-agents. Kept plan-independent where possible to minimize escaping.
 */

export const HARNESS_PROFILES = (
	overrides: Record<string, unknown> = {},
) => `// ModelProfile — per-model scaffold adaptation (Engine v3). Resolves the
// plugged-in model to a profile that reconfigures the whole engine: dispatch
// mode, tool exposure, decoding discipline, and loop structure. This is what
// "any model at its best" means concretely — the harness reshapes itself
// around the brain. Frontier models get a free native-tool loop; small local
// models get grammar-forced JSON dispatch + a tight tool budget + structure,
// so narration-instead-of-acting becomes physically impossible.

export type Tier = "frontier" | "strong" | "mid" | "small";
export type LoopMode = "free" | "plan-act" | "pipeline";
export type ToolCalling = "native" | "constrained-json";

export interface ModelProfile {
  tier: Tier;
  loop: LoopMode;
  toolCalling: ToolCalling;
  maxTools: number;
  editFormat: "search-replace" | "whole-file";
  systemPromptBudget: number; // chars (~4 chars/token)
  temperature: number;
  repeatPenalty?: number;
  nudge: boolean; // native-only narration backstop
  contextTokens: number;
}

function paramSize(model: string): number {
  const m = model.match(/(\\d+(?:\\.\\d+)?)\\s*b/i);
  return m ? Number.parseFloat(m[1]) : 0;
}

/** Resolve a model name to its size-tier scaffold. Ordered; first match wins. */
function resolveBase(model: string, contextTokens = 8192): ModelProfile {
  const m = model.toLowerCase();

  // Frontier hosted models — strongest tool callers, free-form loop.
  if (/claude|gpt-4|gpt-5|o1|o3|gemini/.test(m)) {
    return { tier: "frontier", loop: "free", toolCalling: "native", maxTools: 9,
      editFormat: "search-replace", systemPromptBudget: 8000, temperature: 0.2, nudge: true, contextTokens };
  }

  const size = paramSize(m);

  // Large local models (>=13B) are reliable native tool callers.
  if (size >= 13) {
    return { tier: "strong", loop: "free", toolCalling: "native", maxTools: 8,
      editFormat: "search-replace", systemPromptBudget: 8000, temperature: 0.2, nudge: true, contextTokens };
  }

  // Small models (<=3.5B or known small families): fixed pipeline, minimal
  // tools, grammar-forced JSON so narration is physically impossible.
  if ((size > 0 && size <= 3.5) || /phi|tinyllama|gemma:2b|llama3\\.2/.test(m)) {
    return { tier: "small", loop: "pipeline", toolCalling: "constrained-json", maxTools: 4,
      editFormat: "whole-file", systemPromptBudget: 1600, temperature: 0, repeatPenalty: 1.15, nudge: false, contextTokens };
  }

  // Mid models (7-8B) and unknown: plan-act + constrained JSON (safe default).
  return { tier: "mid", loop: "plan-act", toolCalling: "constrained-json", maxTools: 5,
    editFormat: "whole-file", systemPromptBudget: 2400, temperature: 0.1, repeatPenalty: 1.1, nudge: false, contextTokens };
}

// Per-model curation baked at build time — tunes the SPECIFIC chosen model on
// top of its size-tier default (a coder gets precise edits; a proven native
// tool-caller earns the free loop). Empty unless a catalog model was picked.
const BAKED_OVERRIDES: Record<string, Partial<ModelProfile>> = ${JSON.stringify(overrides)};

/** Resolve a model to its profile, then merge any baked per-model curation. */
export function resolveProfile(model: string, contextTokens = 8192): ModelProfile {
  const base = resolveBase(model, contextTokens);
  const ov = BAKED_OVERRIDES[model.toLowerCase()];
  return ov ? { ...base, ...ov } : base;
}
`;

export const HARNESS_COMPACTION = `// Context compaction: keeps long sessions inside the model's context window.
// Rough token estimate (chars/4); when the transcript exceeds the threshold,
// older messages are summarized into a single system note and dropped.

export type CompactableMessage = Record<string, unknown>;

export function estimateTokens(messages: CompactableMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }
  return Math.ceil(chars / 4);
}

export interface Summarizer {
  (messages: CompactableMessage[]): Promise<string>;
}

/**
 * Compact when estimated tokens exceed threshold. Keeps the most recent
 * keepRecent messages verbatim; everything older is replaced by a summary
 * produced by the provided summarizer (an LLM call in practice).
 */
export async function compactMessages(
  messages: CompactableMessage[],
  opts: { maxTokens: number; keepRecent?: number; summarize: Summarizer },
): Promise<CompactableMessage[]> {
  const keepRecent = opts.keepRecent ?? 6;
  if (estimateTokens(messages) <= opts.maxTokens || messages.length <= keepRecent) {
    return messages;
  }
  const older = messages.slice(0, messages.length - keepRecent);
  const recent = messages.slice(messages.length - keepRecent);
  let summary: string;
  try {
    summary = await opts.summarize(older);
  } catch {
    // Summarization failed — fall back to hard truncation rather than dying.
    return recent;
  }
  return [
    { role: "system", content: "Summary of earlier conversation (compacted): " + summary },
    ...recent,
  ];
}
`;

// Long-term memory tier: semantic (durable facts) + episodic (dated events),
// stored in a local bun:sqlite DB under ~/.<name>/memory.db. Procedural memory
// is the skills/ system; working memory is compaction.ts. Fully sovereign —
// nothing leaves the machine. Off switch: HARNAGE_MEMORY=off. The retrieval
// "gate" is deterministic keyword-overlap: an empty match IS the gate deciding
// to skip, so a small model is never asked to make that call.
export const HARNESS_MEMORY = (
	plan: HarnessPlan,
) => `// 3-tier memory (semantic + episodic). Local bun:sqlite; nothing leaves the box.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

const DB_PATH = join(homedir(), ".${plan.name}", "memory.db");

export interface RecalledFact { subject: string; fact: string; }
export interface RecalledEvent { event: string; occurred_at: string; }

export class MemoryStore {
  private db: Database | null = null;

  /** Lazily open the DB. Returns null when memory is disabled or unavailable —
   * every caller no-ops on null, so memory failures never break a run. */
  private open(): Database | null {
    if (process.env.HARNAGE_MEMORY === "off") return null;
    if (this.db) return this.db;
    try {
      mkdirSync(dirname(DB_PATH), { recursive: true });
      const db = new Database(DB_PATH);
      db.run("CREATE TABLE IF NOT EXISTS semantic (subject TEXT NOT NULL, fact TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (subject, fact))");
      db.run("CREATE TABLE IF NOT EXISTS episodic (event TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL)");
      this.db = db;
      return db;
    } catch {
      return null;
    }
  }

  /** Upsert a durable fact (identity, preference, relationship). */
  saveFact(subject: string, fact: string): void {
    const db = this.open();
    if (!db) return;
    const s = subject.trim();
    const f = fact.trim();
    if (!s || !f) return;
    try {
      db.run("INSERT OR REPLACE INTO semantic (subject, fact, updated_at) VALUES (?, ?, ?)", [s, f, new Date().toISOString()]);
    } catch { /* best-effort */ }
  }

  /** Record a dated event. */
  saveEvent(event: string, occurredAt?: string): void {
    const db = this.open();
    if (!db) return;
    const e = event.trim();
    if (!e) return;
    const when = (occurredAt ?? "").trim() || new Date().toISOString();
    try {
      db.run("INSERT INTO episodic (event, occurred_at, created_at) VALUES (?, ?, ?)", [e, when, new Date().toISOString()]);
    } catch { /* best-effort */ }
  }

  /** Deterministic retrieval gate: keyword-overlap match against both tiers.
   * Returns a formatted block, or "" when nothing matches — that empty string
   * is the gate deciding "skip retrieval", with no model call needed. */
  recall(query: string, limit = 8): string {
    const db = this.open();
    if (!db) return "";
    const words = query.toLowerCase().match(/[a-z0-9]{4,}/g);
    if (!words || words.length === 0) return "";
    const terms = [...new Set(words)].slice(0, 12);
    try {
      const facts = new Map<string, string>();
      const events = new Map<string, string>();
      for (const w of terms) {
        const like = "%" + w + "%";
        const fr = db.query("SELECT subject, fact FROM semantic WHERE lower(subject) LIKE ? OR lower(fact) LIKE ? LIMIT ?").all(like, like, limit) as RecalledFact[];
        for (const r of fr) facts.set(r.subject + "|" + r.fact, r.subject + ": " + r.fact);
        const er = db.query("SELECT event, occurred_at FROM episodic WHERE lower(event) LIKE ? ORDER BY occurred_at DESC LIMIT ?").all(like, limit) as RecalledEvent[];
        for (const r of er) events.set(r.event, (r.occurred_at || "").slice(0, 10) + " — " + r.event);
      }
      const f = [...facts.values()].slice(0, limit);
      const e = [...events.values()].slice(0, limit);
      if (f.length === 0 && e.length === 0) return "";
      const lines: string[] = [];
      if (f.length) lines.push("Known facts:", ...f.map((x) => "- " + x));
      if (e.length) lines.push("Relevant past events:", ...e.map((x) => "- " + x));
      return lines.join("\\n");
    } catch {
      return "";
    }
  }

  close(): void {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
  }
}
`;

// Eval-in-loop: grade every run. Deterministic rules are cheap and local; the
// LLM judge is opt-in (HARNAGE_JUDGE=on) since it costs a model call. The engine
// logs results to the audit trail, and the `trace` command summarizes them.
export const HARNESS_EVAL = `// Post-run evaluation: deterministic rules + an opt-in LLM judge.
export interface EvalResult { name: string; pass: boolean; detail?: string; }
type Msg = Record<string, unknown>;

/** Cheap deterministic quality rules — no model call. */
export function runDeterministicEvals(goal: string, answer: string, messages: Msg[], toolCount: number): EvalResult[] {
  const out: EvalResult[] = [];
  const a = (answer ?? "").trim();
  out.push({ name: "non_empty_answer", pass: a.length > 0 });
  out.push({ name: "completed_without_stop", pass: !/^Stopped:|^Error:/.test(a) });
  // Prose, not a raw JSON/blob dump (weak models sometimes leak scaffolding).
  const first = a[0];
  const last = a[a.length - 1];
  const looksBlob = (first === "{" || first === "[") && (last === "}" || last === "]");
  out.push({ name: "prose_answer", pass: a.length === 0 ? true : !looksBlob });
  // A harness with tools should usually touch at least one on a real task.
  if (toolCount > 0) {
    const usedTool = messages.some((m) => m.role === "tool" || (typeof m.content === "string" && m.content.startsWith("Observation from ")));
    out.push({ name: "used_tool_when_available", pass: usedTool });
  }
  return out;
}

export const JUDGE_SYSTEM = 'You are a strict evaluator. Score how well the assistant answer addresses the user request, from 1 (useless) to 5 (excellent). Reply with only: SCORE: <n> — <one short reason>.';

/** Build the judge request (the engine streams it with its own provider). */
export function judgeRequest(goal: string, answer: string): Msg[] {
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: ("Request: " + goal + "\\nAnswer: " + answer).slice(0, 4000) },
  ];
}

/** Parse the judge's 1–5 score from raw text. Returns null if unscorable. */
export function parseJudgeScore(raw: string): EvalResult | null {
  const m = (raw ?? "").match(/[1-5]/);
  if (!m) return null;
  const score = Number(m[0]);
  return { name: "judge_quality", pass: score >= 3, detail: "score " + score + "/5" };
}
`;

// Sovereign ops view: a \`trace\` command that summarizes the local audit trail
// (runs, latency, tool calls, eval pass rate) — the LLMops pillar, terminal-first,
// no cloud, no external tracing service.
export const HARNESS_TRACE = (
	plan: HarnessPlan,
) => `// Ops summary over the local audit trail (~/.${plan.name}/audit.jsonl).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

const AUDIT_PATH = join(homedir(), ".${plan.name}", "audit.jsonl");

interface Entry { ts?: string; kind?: string; [k: string]: unknown; }

function load(): Entry[] {
  if (!existsSync(AUDIT_PATH)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(AUDIT_PATH, "utf-8").split("\\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as Entry); } catch { /* skip malformed line */ }
  }
  return out;
}

export function printTrace(): void {
  const entries = load();
  if (entries.length === 0) {
    console.log(chalk.dim("No trace yet — run the agent first. (Audit path: " + AUDIT_PATH + ")"));
    return;
  }
  const runs = entries.filter((e) => e.kind === "run_start").length;
  const ends = entries.filter((e) => e.kind === "run_end");
  const latencies = ends.map((e) => Number(e.ms)).filter((n) => Number.isFinite(n) && n > 0);
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const maxMs = latencies.length ? Math.max(...latencies) : 0;
  const chars = ends.map((e) => Number(e.chars)).filter((n) => Number.isFinite(n));
  const estTokens = Math.round(chars.reduce((a, b) => a + b, 0) / 4);

  const toolCalls = entries.filter((e) => e.kind === "tool_call");
  const byTool = new Map<string, { ok: number; fail: number }>();
  for (const t of toolCalls) {
    const name = String(t.tool ?? "?");
    const rec = byTool.get(name) ?? { ok: 0, fail: 0 };
    if (t.ok === false) rec.fail++; else rec.ok++;
    byTool.set(name, rec);
  }
  const denies = entries.filter((e) => e.kind === "permission_deny").length;
  const recalls = entries.filter((e) => e.kind === "memory_recall").length;
  const consolidations = entries.filter((e) => e.kind === "memory_consolidate").length;

  const evals = entries.filter((e) => e.kind === "eval");
  const evalPass = evals.filter((e) => e.pass === true).length;
  const byEval = new Map<string, { pass: number; total: number }>();
  for (const e of evals) {
    const name = String(e.name ?? "?");
    const rec = byEval.get(name) ?? { pass: 0, total: 0 };
    rec.total++;
    if (e.pass === true) rec.pass++;
    byEval.set(name, rec);
  }

  console.log();
  console.log(chalk.bold("  ${plan.name} — ops trace"));
  console.log(chalk.dim("  " + AUDIT_PATH));
  console.log();
  console.log("  " + chalk.bold("Runs") + "          " + runs);
  console.log("  " + chalk.bold("Latency") + "       avg " + avgMs + "ms · max " + maxMs + "ms");
  console.log("  " + chalk.bold("Est. tokens") + "   ~" + estTokens + chalk.dim(" (chars/4 over all replies)"));
  console.log("  " + chalk.bold("Tool calls") + "    " + toolCalls.length + (denies ? chalk.yellow("  · " + denies + " denied") : ""));
  for (const [name, rec] of byTool) {
    console.log("    " + chalk.cyan(name.padEnd(14)) + rec.ok + " ok" + (rec.fail ? chalk.red("  " + rec.fail + " fail") : ""));
  }
  console.log("  " + chalk.bold("Memory") + "        " + recalls + " recalls · " + consolidations + " consolidations");
  if (evals.length) {
    const pct = Math.round((evalPass / evals.length) * 100);
    const color = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;
    console.log("  " + chalk.bold("Eval pass") + "     " + color(pct + "%") + chalk.dim(" (" + evalPass + "/" + evals.length + " checks)"));
    for (const [name, rec] of byEval) {
      const p = Math.round((rec.pass / rec.total) * 100);
      console.log("    " + chalk.dim(name.padEnd(28)) + rec.pass + "/" + rec.total + " (" + p + "%)");
    }
  } else {
    console.log("  " + chalk.bold("Eval pass") + "     " + chalk.dim("no evals logged yet"));
  }
  console.log();
}
`;

export const HARNESS_PERMISSIONS = (
	plan: HarnessPlan,
) => `// Permission system with path rules. Modes:
//   default — read-only tools allowed; writes/executes need a matching allow rule
//   plan    — read-only tools only, everything else denied
//   auto    — everything allowed (trusted automation)
//   bypass  — everything allowed (explicit override)
// Rules live in ~/.${plan.name}/permissions.json:
//   { "mode": "default", "rules": [ { "pattern": "bash(bun *)", "allow": true },
//                                    { "pattern": "file_write(src/**)", "allow": true } ] }
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PermissionRule { pattern: string; allow: boolean; }
export interface PermissionPolicy {
  mode: "default" | "plan" | "auto" | "bypass";
  rules: PermissionRule[];
}

const POLICY_PATH = join(homedir(), ".${plan.name}", "permissions.json");
const READ_ONLY_TOOLS = new Set(["file_read", "glob", "grep", "web_fetch", "web_search"]);

export function loadPolicy(): PermissionPolicy {
  if (existsSync(POLICY_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(POLICY_PATH, "utf-8")) as Partial<PermissionPolicy>;
      return { mode: raw.mode ?? "default", rules: raw.rules ?? [] };
    } catch { /* fall through */ }
  }
  return { mode: "default", rules: [] };
}

/** Persist the policy (used when the user picks "always" on a permission prompt). */
export function savePolicy(policy: PermissionPolicy): void {
  try {
    mkdirSync(dirname(POLICY_PATH), { recursive: true });
    writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));
  } catch { /* best-effort persistence */ }
}

/** Convert "tool(glob)" pattern to a matcher. "*" matches within a segment, "**" matches across. */
function ruleMatches(rule: PermissionRule, toolName: string, target: string): boolean {
  const m = rule.pattern.match(/^([\\w-]+)(?:\\((.*)\\))?$/);
  if (!m) return false;
  if (m[1] !== toolName && m[1] !== "*") return false;
  const glob = m[2];
  if (glob === undefined || glob === "" || glob === "*" || glob === "**") return true;
  const re = new RegExp(
    "^" + glob
      .replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&")
      .replace(/\\*\\*/g, "\\u0000")
      .replace(/\\*/g, ".*")
      .replace(/\\u0000/g, ".*") + "$",
  );
  return re.test(target);
}

/** Pull the path-like or command-like argument out of a tool input for rule matching. */
export function targetOf(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["path", "file_path", "command", "url", "pattern"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
  }
  return "";
}

export function checkPermission(
  policy: PermissionPolicy,
  toolName: string,
  input: unknown,
): { allowed: boolean; reason?: string } {
  if (policy.mode === "auto" || policy.mode === "bypass") return { allowed: true };

  const target = targetOf(input);
  for (const rule of policy.rules) {
    if (ruleMatches(rule, toolName, target)) {
      return rule.allow
        ? { allowed: true }
        : { allowed: false, reason: "denied by rule: " + rule.pattern };
    }
  }

  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
  if (policy.mode === "plan") {
    return { allowed: false, reason: "plan mode is read-only" };
  }
  return {
    allowed: false,
    reason:
      "tool '" + toolName + "' needs an allow rule in " + POLICY_PATH +
      ' — e.g. { "pattern": "' + toolName + '(*)", "allow": true }',
  };
}
`;

export const HARNESS_SKILLS = `// Skills-as-markdown: drop .md files in skills/ to teach the agent workflows.
// Frontmatter:
//   ---
//   name: review
//   description: How to review a pull request
//   triggers: review, pr, diff
//   ---
//   ...markdown body injected into the system prompt when a trigger matches...
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string;
}

export async function loadSkills(dir = join(process.cwd(), "skills")): Promise<Skill[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), "utf-8");
      const m = raw.match(/^---\\n([\\s\\S]*?)\\n---\\n?([\\s\\S]*)$/);
      const fm: Record<string, string> = {};
      let body = raw;
      if (m) {
        body = m[2];
        for (const line of m[1].split("\\n")) {
          const kv = line.match(/^([\\w-]+):\\s*(.*)$/);
          if (kv) fm[kv[1]] = kv[2];
        }
      }
      skills.push({
        name: fm.name ?? f.replace(/\\.md$/, ""),
        description: fm.description ?? "",
        triggers: (fm.triggers ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
        body: body.trim(),
      });
    } catch { /* skip unreadable skill */ }
  }
  return skills;
}

/** Skills whose triggers appear in the goal text (or with no triggers = always on). */
export function matchSkills(skills: Skill[], goal: string): Skill[] {
  const lower = goal.toLowerCase();
  return skills.filter(
    (s) => s.triggers.length === 0 || s.triggers.some((t) => lower.includes(t)),
  );
}

export function skillsPromptBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return (
    "\\n\\n## Skills\\n" +
    skills.map((s) => "### " + s.name + "\\n" + s.body).join("\\n\\n")
  );
}
`;

export const HARNESS_SESSION = (
	plan: HarnessPlan,
) => `// Session persistence: transcript survives restarts. Run with --resume to
// pick up where you left off.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_DIR = join(homedir(), ".${plan.name}");
const SESSION_PATH = join(SESSION_DIR, "session.json");
const MAX_SAVED_MESSAGES = 200;

export interface SessionState {
  messages: Array<Record<string, unknown>>;
  savedAt: string;
}

export async function saveSession(messages: Array<Record<string, unknown>>): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { recursive: true });
    const state: SessionState = {
      messages: messages.slice(-MAX_SAVED_MESSAGES),
      savedAt: new Date().toISOString(),
    };
    await writeFile(SESSION_PATH, JSON.stringify(state, null, 2));
  } catch { /* persistence is best-effort */ }
}

export function loadSession(): SessionState | null {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as SessionState;
    if (!Array.isArray(state.messages)) return null;
    return state;
  } catch {
    return null;
  }
}
`;

export const HARNESS_SUBAGENT = `// Sub-agents: spawn a scoped agent with its own fresh transcript and a
// restricted tool set. Registered as the "agent" tool.
import { z } from "zod";
import type { Tool, ToolContext } from "./Tool.ts";
import { LoopEngine, type EngineConfig } from "./engine.ts";

const AgentInput = z.object({
  goal: z.string().describe("The goal for the sub-agent to accomplish"),
  read_only: z.boolean().optional().describe("Restrict the sub-agent to read-only tools (default true)"),
});

const READ_ONLY = new Set(["file_read", "glob", "grep", "web_fetch", "web_search"]);

export function makeAgentTool(allTools: Tool[], engineConfig: EngineConfig): Tool {
  return {
    name: "agent",
    description:
      "Spawn a sub-agent with a fresh context to work on a focused goal. Returns the sub-agent's final answer.",
    inputSchema: AgentInput,
    isReadOnly: () => true,
    async call(input: unknown, _context: ToolContext) {
      const parsed = AgentInput.safeParse(input);
      if (!parsed.success) return { error: "Invalid input: " + parsed.error.message, isError: true };
      const readOnly = parsed.data.read_only ?? true;
      const tools = readOnly ? allTools.filter((t) => READ_ONLY.has(t.name)) : allTools.filter((t) => t.name !== "agent");
      const engine = new LoopEngine({ ...engineConfig, tools, persistSession: false });
      const result = await engine.run(parsed.data.goal);
      return { content: result };
    },
  };
}
`;

export const EXAMPLE_SKILL = (plan: HarnessPlan) => `---
name: verify-before-done
description: Always verify claims with real command output before declaring done
triggers:
---
Before saying a task is done, run the relevant verification (tests, typecheck,
or a direct check of the produced artifact) and quote the real output. Never
claim success without evidence. This harness (${plan.name}) was generated by
harnage — edit or add skills in this directory to teach it your workflows.
`;

export const PIPELINE_TEMPLATE = (
	plan: HarnessPlan,
) => `// Builder-baked domain pipeline for the small-model tier (Engine v3). Stages
// are decided at build time from the harness's domain; an empty array makes the
// engine fall back to the constrained-json decision loop.
export interface PipelineStage { name: string; instruction: string; tool?: string; }
export const PIPELINE: PipelineStage[] = ${JSON.stringify(plan.pipeline ?? [], null, 2)};
`;

export const ENGINE_TEMPLATE = (
	plan: HarnessPlan,
) => `// Goal-driven loop engine with compaction, permissions, session persistence,
// and skills support. Extracted so sub-agents can spawn engines too.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tool, ToolContext } from "./Tool.ts";
import { compactMessages, estimateTokens } from "./compaction.ts";
import { judgeRequest, parseJudgeScore, runDeterministicEvals } from "./eval.ts";
import { MemoryStore } from "./memory.ts";
import { checkPermission, loadPolicy, type PermissionPolicy, savePolicy, targetOf } from "./permissions.ts";
import { PIPELINE } from "./pipeline.ts";
import { type ModelProfile, resolveProfile } from "./profiles.ts";
import { saveSession } from "./session.ts";
import { matchSkills, skillsPromptBlock, type Skill } from "./skills.ts";

export interface ProviderConfig {
  type: "ollama" | "openrouter";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens: number;
  contextTokens?: number;
}

export interface StreamEvent {
  type: "text" | "tool_use" | "error" | "done";
  content?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

interface ToolUse { name: string; input: Record<string, unknown>; id: string; }

// Append-only local audit trail — the sovereign-deployment control. Records
// every run boundary, permission decision, and tool execution to a JSONL file
// that never leaves the machine. On by default; disable with HARNAGE_AUDIT=off.
// Failures are swallowed: auditing must never break or block a run.
const AUDIT_PATH = join(homedir(), ".${plan.name}", "audit.jsonl");
function audit(kind: string, data: Record<string, unknown>): void {
  if (process.env.HARNAGE_AUDIT === "off") return;
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true });
    appendFileSync(AUDIT_PATH, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\\n");
  } catch { /* audit is best-effort — never throw into the loop */ }
}

export class SafetyMonitor {
  private failures = 0;

  check(iteration: number, maxIterations = 20, maxFailures = 5): { shouldStop: boolean; reason?: string } {
    if (iteration > maxIterations) return { shouldStop: true, reason: "Exceeded max iterations" };
    if (this.failures >= maxFailures) return { shouldStop: true, reason: "Too many consecutive failures" };
    return { shouldStop: false };
  }

  recordFailure() { this.failures++; }
  recordSuccess() { this.failures = 0; }
  reset() { this.failures = 0; }
}

export function toToolDefs(tools: Tool[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema.toJSONSchema?.() ?? ({} as Record<string, unknown>),
    },
  }));
}

// Always-keep tools; glob/grep/file_write compete by goal relevance so a tight
// small-model budget still leaves room for the tool the task actually needs.
const CORE_TOOLS = ["file_read", "bash"];

/** Cap the exposed tool set to the profile budget (ACI principle): keep the
 * core tools plus the ones most relevant to the goal. Small models' tool-call
 * accuracy collapses past ~5-8 tools — fewer, better tools recover the gap. */
export function selectTools(tools: Tool[], goal: string, maxTools: number): Tool[] {
  if (tools.length <= maxTools) return tools;
  const lower = goal.toLowerCase();
  const words = lower.split(/\\W+/).filter(w => w.length > 3);
  const core = tools.filter(t => CORE_TOOLS.includes(t.name));
  const rest = tools.filter(t => !CORE_TOOLS.includes(t.name));
  const scored = rest
    .map(t => {
      const desc = (t.description ?? "").toLowerCase();
      const nameHit = lower.includes(t.name.replace(/_/g, " ")) ? 2 : 0;
      const descHit = words.some(w => desc.includes(w)) ? 1 : 0;
      return { t, score: nameHit + descHit };
    })
    .sort((a, b) => b.score - a.score);
  const picked = [...core];
  for (const { t } of scored) {
    if (picked.length >= maxTools) break;
    picked.push(t);
  }
  return picked.slice(0, maxTools);
}

/** Truncate a large tool observation to head+tail windows so garbage-in loops
 * don't blow the small-model context. Short outputs pass through untouched. */
export function compactToolOutput(output: string, maxChars = 2000): string {
  if (output.length <= maxChars) return output;
  const lines = output.split("\\n");
  if (lines.length <= 62) return output.slice(0, maxChars) + "\\n… (truncated) …";
  const head = lines.slice(0, 40);
  const tail = lines.slice(-20);
  const omitted = lines.length - 60;
  return [...head, \`… (\${omitted} lines omitted) …\`, ...tail].join("\\n");
}

// Grammar-forced decision schema for constrained-json dispatch. Under Ollama
// \`format\`, a small model physically cannot narrate — it must emit exactly one
// of: {action:"tool", tool, args} | {action:"final", answer}.
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["tool", "final"] },
    tool: { type: "string" },
    args: { type: "object" },
    answer: { type: "string" },
  },
  required: ["action"],
};

// Grammar for memory consolidation. Passing this as the decode \`format\` makes
// Ollama (and hosted response_format) emit valid JSON, so a 3B model extracts
// facts as reliably as a 70B one — the harness caters to the model, not the
// other way round.
const CONSOLIDATION_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: { subject: { type: "string" }, fact: { type: "string" } },
        required: ["subject", "fact"],
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { event: { type: "string" }, when: { type: "string" } },
        required: ["event"],
      },
    },
  },
  required: ["facts", "events"],
};

interface Decision { action: "tool" | "final"; tool?: string; args?: Record<string, unknown>; answer?: string; }

/** Parse a (possibly prose-wrapped) decision object; null if unrecoverable. */
function parseDecision(raw: string): Decision | null {
  const text = raw.trim();
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(text);
  if (!obj) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) obj = tryParse(text.slice(start, end + 1));
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.action !== "tool" && o.action !== "final") return null;
  return {
    action: o.action,
    tool: typeof o.tool === "string" ? o.tool : undefined,
    args: o.args && typeof o.args === "object" ? (o.args as Record<string, unknown>) : {},
    answer: typeof o.answer === "string" ? o.answer : undefined,
  };
}

/** Small models under grammar sometimes stuff JSON scaffolding into the answer
 * field (e.g. {"text":"./a.ts":1,...}). Strip that so the user sees prose, not
 * wire format. Cheap, always-safe: only rewrites when the answer looks like a
 * JSON artifact; clean prose passes through untouched. */
function unwrapFinal(answer: string): string {
  const s = answer.trim();
  if (!s || !(s.startsWith("{") || s.startsWith("["))) return s;
  // Well-formed wrapper: pull the human field if present.
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    for (const k of ["answer", "text", "result", "content", "message", "output"]) {
      if (typeof o[k] === "string") return (o[k] as string).trim();
    }
  } catch { /* fall through to fragment cleanup */ }
  // Malformed fragment: collapse {"text":"..."} noise into readable pairs.
  const cleaned = s
    .replace(/"?(text|answer|result|content|key|value)"?\\s*:/gi, "")
    .replace(/[{}\\[\\]]/g, "")
    .replace(/"\\s*,\\s*"/g, ", ")
    .replace(/"/g, "")
    .replace(/\\s+/g, " ")
    .trim();
  return cleaned || s;
}

/** True when a final answer reads like wire-format, not prose: starts with a
 * bracket, carries JSON-ish pairs, or has no two real words in a row. Gates the
 * restate step so clean answers are never touched. */
function looksNonProse(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^[{\\[]/.test(t)) return true;
  if (/":\\s*\\d|"\\s*:\\s*"/.test(t)) return true;
  if (!/[a-zA-Z]{3,}\\s+[a-zA-Z]{3,}/.test(t)) return true;
  return false;
}

const DECISION_RULES =
  'You act by returning ONE JSON object and nothing else. ' +
  'To use a tool: {"action":"tool","tool":"<name>","args":{...}}. ' +
  'To give your final answer: {"action":"final","answer":"<text>"}. ' +
  'Do NOT describe what you will do — return the tool action. One tool per turn. ' +
  'NEVER answer from memory or guess a result — you MUST use a tool to inspect or ' +
  'change real files before answering. ' +
  'Example — to read a file, return exactly: ' +
  '{"action":"tool","tool":"file_read","args":{"path":"src/index.ts"}}';

// A final answer that asserts absence/failure. Small models emit these
// prematurely (the #1 grounding error) — trust it only after a tool confirms.
// No regex backslashes: this lives in a template literal. '.' covers n't/nt.
const NEGATIVE_CLAIM = /does ?n.?t exist|does not exist|no such file|not found|cannot find|can.?t find|unable to (read|find|locate|open)|not present|isn.?t there|no file named/i;

// Plan-act: force a numbered step list before execution (Agentless principle —
// structure beats free-form autonomy for mid models).
const PLAN_STEPS_SCHEMA = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" } } },
  required: ["steps"],
};

function parseSteps(raw: string): string[] {
  const text = raw.trim();
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(text);
  if (!obj) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  const o = obj as { steps?: unknown } | null;
  if (o && Array.isArray(o.steps)) return o.steps.filter((s): s is string => typeof s === "string").slice(0, 6);
  return [];
}

export interface StreamOpts {
  /** JSON schema to grammar-constrain the reply (Ollama \`format\`). */
  format?: unknown;
  temperature?: number;
  repeatPenalty?: number;
}

export async function* streamProvider(
  config: ProviderConfig,
  messages: Array<Record<string, unknown>>,
  tools?: Array<Record<string, unknown>>,
  opts?: StreamOpts,
): AsyncGenerator<StreamEvent> {
  const isOllama = config.type === "ollama";
  const base = config.baseUrl || (isOllama ? "http://localhost:11434" : "https://openrouter.ai/api/v1");
  const url = isOllama ? \`\${base}/api/chat\` : \`\${base}/v1/chat/completions\`;

  // low temperature: agentic tool selection needs determinism, not creativity
  const temperature = opts?.temperature ?? 0.2;
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    ...(isOllama
      ? { options: { num_ctx: config.contextTokens ?? 8192, num_predict: config.maxTokens, temperature, ...(opts?.repeatPenalty ? { repeat_penalty: opts.repeatPenalty } : {}) } }
      : { max_tokens: config.maxTokens, temperature }),
  };
  if (tools?.length) body.tools = tools;
  // Keep the model resident between turns so it isn't cold-reloaded into RAM/VRAM
  // on every call — the single biggest felt-latency win for local agentic loops.
  if (isOllama) body.keep_alive = "10m";
  // Constrained decoding: force the reply to match a JSON schema. Ollama uses
  // \`format\`; OpenAI-compatible hosts use \`response_format\` json_schema. Under
  // either, the model physically cannot emit malformed JSON.
  if (opts?.format !== undefined) {
    if (isOllama) body.format = opts.format;
    else body.response_format = { type: "json_schema", json_schema: { name: "decision", strict: true, schema: opts.format } };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = \`Bearer \${config.apiKey}\`;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    yield { type: "error", content: \`\${config.type} \${res.status}: \${text.slice(0, 200)}\` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) { yield { type: "error", content: "Empty response body" }; return; }

  const decoder = new TextDecoder();
  let buffer = "";
  const acc: Record<number, { id: string; name: string; args: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;

      try {
        if (isOllama) {
          const json = JSON.parse(trimmed);
          if (json.message?.content) yield { type: "text", content: json.message.content };
          for (const tc of json.message?.tool_calls ?? []) {
            // Ollama /api/chat returns arguments as an OBJECT, not a string —
            // JSON.parse on it throws and the outer catch drops the call. Handle both.
            const rawArgs = tc.function?.arguments;
            const input = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
            yield { type: "tool_use", name: tc.function?.name ?? "", input, id: tc.function?.name ?? "" };
          }
          if (json.done) yield { type: "done" };
        } else {
          if (!trimmed.startsWith("data: ")) continue;
          const json = JSON.parse(trimmed.slice(6));
          if (json.choices?.[0]?.delta?.content) yield { type: "text", content: json.choices[0].delta.content };
          for (const tc of json.choices?.[0]?.delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            if (!acc[idx]) acc[idx] = { id: "", name: "", args: "" };
            if (tc.id) acc[idx].id = tc.id;
            if (tc.function?.name) acc[idx].name = tc.function.name;
            if (tc.function?.arguments) acc[idx].args += tc.function.arguments;
          }
          if (json.choices?.[0]?.finish_reason) {
            for (const a of Object.values(acc)) {
              yield { type: "tool_use", name: a.name, input: JSON.parse(a.args || "{}"), id: a.id || a.name };
            }
            Object.keys(acc).forEach(k => delete acc[Number(k)]);
          }
          if (json.usage) yield { type: "done" };
        }
      } catch { /* skip parse errors */ }
    }
  }
}

export interface EngineEvent {
  type: "text" | "tool_use" | "tool_done" | "status";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface EngineConfig {
  tools: Tool[];
  providerConfig: ProviderConfig;
  skills?: Skill[];
  persistSession?: boolean;
  policy?: PermissionPolicy;
  initialMessages?: Array<Record<string, unknown>>;
  /** Per-model scaffold profile; resolved from the model name when omitted. */
  profile?: ModelProfile;
  /** Live progress callback — lets a TUI stream text and tool activity. */
  onEvent?: (event: EngineEvent) => void;
  /** Interactive permission gate. Called when a tool is denied by policy in
   * default mode; the UI resolves allow (once) / deny / always (remember). */
  onPermissionRequest?: (req: { tool: string; input: unknown; reason: string }) => Promise<"allow" | "deny" | "always">;
  /** Opt-in escalation: when a small/mid loop gets stuck (safety-stopped,
   * errored, or empty), retry once with plan-act — and, if set, swap to this
   * stronger model for the retry. Off by default; no extra RAM unless used. */
  fallbackModel?: string;
}

export class LoopEngine {
  private messages: Array<Record<string, unknown>> = [];
  private tools: Tool[];
  private config: ProviderConfig;
  private safety = new SafetyMonitor();
  private toolContext: ToolContext;
  private skills: Skill[];
  private persistSession: boolean;
  private policy: PermissionPolicy;
  private profile: ModelProfile;
  private onEvent?: (event: EngineEvent) => void;
  private onPermissionRequest?: EngineConfig["onPermissionRequest"];
  private nudged = false;
  private escalated = false;
  private fallbackModel?: string;
  // Long-term memory: on for top-level user sessions, off for sub-agents
  // (persistSession false) so spawned agents never pollute the durable store.
  private memory: MemoryStore | null = null;

  constructor(config: EngineConfig) {
    this.tools = config.tools;
    this.config = config.providerConfig;
    this.skills = config.skills ?? [];
    this.persistSession = config.persistSession ?? true;
    this.onEvent = config.onEvent;
    this.onPermissionRequest = config.onPermissionRequest;
    this.policy = config.policy ?? loadPolicy();
    this.profile = config.profile ?? resolveProfile(this.config.model, this.config.contextTokens);
    this.fallbackModel = config.fallbackModel;
    this.memory = this.persistSession ? new MemoryStore() : null;
    this.messages = config.initialMessages ? [...config.initialMessages] : [];
    this.toolContext = {
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      permissions: { mode: this.policy.mode, rules: this.policy.rules },
      sandbox: "none",
    };
  }

  getMessages(): Array<Record<string, unknown>> { return this.messages; }

  async run(goal: string): Promise<string> {
    const startedAt = Date.now();
    audit("run_start", { goal: goal.slice(0, 300), model: this.config.model, tier: this.profile.tier });
    this.messages.push({ role: "user", content: goal });
    // Retrieval gate (deterministic): pull matching long-term memory into the
    // transcript before the loop. Empty match = skip, no model call. Seeded as
    // the first message so every dispatch mode inherits it.
    if (this.memory) {
      const recalled = this.memory.recall(goal);
      if (recalled) {
        this.onEvent?.({ type: "status", content: "recalled long-term memory" });
        this.messages.unshift({ role: "system", content: "Relevant long-term memory from earlier sessions:\\n" + recalled });
        audit("memory_recall", { chars: recalled.length });
      }
    }
    let result = await this.dispatch(goal);
    // Router fallback: a stuck small/mid loop gets one escalated retry.
    if (this.shouldEscalate(result)) result = await this.escalate(goal);
    // Consolidation: after a successful reply, extract durable facts + dated
    // events into the semantic/episodic store. Best-effort, never throws.
    if (this.memory && result && !/^Stopped:|^Error:/.test(result.trim())) {
      await this.consolidate(goal, result);
    }
    // Eval-in-loop: grade every top-level run and log the verdict to the audit
    // trail (the ops store). Deterministic rules always run (cheap, local);
    // the LLM judge runs only when HARNAGE_JUDGE=on (it costs a model call).
    if (this.persistSession) {
      try {
        const evals = runDeterministicEvals(goal, result, this.messages, this.tools.length);
        if (process.env.HARNAGE_JUDGE === "on") {
          let raw = "";
          try {
            for await (const e of streamProvider(this.config, judgeRequest(goal, result))) {
              if (e.type === "text") raw += e.content ?? "";
            }
          } catch { /* judge call failed — skip, keep deterministic evals */ }
          const judged = parseJudgeScore(raw);
          if (judged) evals.push(judged);
        }
        for (const e of evals) audit("eval", { name: e.name, pass: e.pass, detail: e.detail ?? "" });
      } catch { /* eval is best-effort — never affect the returned answer */ }
    }
    audit("run_end", { model: this.config.model, chars: result.length, ms: Date.now() - startedAt });
    return result;
  }

  /** One post-reply extraction call → durable facts + dated events. JSON is
   * pulled with indexOf slicing (no regex) and parsed defensively; any failure
   * is swallowed so memory writes never affect the answer already returned. */
  private async consolidate(goal: string, answer: string): Promise<void> {
    if (!this.memory) return;
    const sys = 'Extract durable facts and dated events from this exchange as strict JSON. Output an object with two arrays: "facts" (each {subject, fact}) and "events" (each {event, when} where when is YYYY-MM-DD). Only stable, reusable facts (identities, preferences, relationships) and concrete dated events. Use empty arrays if there is nothing worth remembering. Output JSON only, no prose.';
    const req = [
      { role: "system", content: sys },
      { role: "user", content: ("User: " + goal + "\\nAssistant: " + answer).slice(0, 4000) },
    ];
    let raw = "";
    try {
      // Grammar-force valid JSON so weak models extract as reliably as strong ones.
      for await (const e of streamProvider(this.config, req, undefined, { format: CONSOLIDATION_SCHEMA, temperature: 0 })) {
        if (e.type === "text") raw += e.content ?? "";
      }
    } catch {
      return;
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        facts?: Array<{ subject?: string; fact?: string }>;
        events?: Array<{ event?: string; when?: string }>;
      };
      let stored = 0;
      for (const f of parsed.facts ?? []) {
        if (f.subject && f.fact) { this.memory.saveFact(f.subject, f.fact); stored++; }
      }
      for (const ev of parsed.events ?? []) {
        if (ev.event) { this.memory.saveEvent(ev.event, ev.when); stored++; }
      }
      if (stored > 0) {
        this.onEvent?.({ type: "status", content: "consolidated " + stored + " memory item(s)" });
        audit("memory_consolidate", { stored });
      }
    } catch {
      /* malformed JSON — skip, do not disturb the returned answer */
    }
  }

  /** Dispatch by the resolved model profile — Engine v3's core move. Strong
   * native tool callers get the free loop; weaker models get grammar-forced
   * JSON dispatch, degrading toward more structure as the model shrinks. */
  private dispatch(goal: string): Promise<string> {
    if (this.profile.toolCalling === "native") return this.runFree(goal);
    if (this.profile.loop === "pipeline") return this.runPipeline(goal);
    if (this.profile.loop === "plan-act") return this.runPlanAct(goal);
    return this.runDecisionLoop(goal);
  }

  /** A result signals a stuck loop when it was safety-stopped, errored, or came
   * back empty. Only low tiers escalate, and only once. A confidently-wrong
   * answer is NOT detectable here — that needs a verify pass, not a retry. */
  private shouldEscalate(result: string): boolean {
    if (this.escalated) return false;
    if (this.profile.tier !== "small" && this.profile.tier !== "mid") return false;
    const r = result.trim();
    return r.length === 0 || /^Stopped:|^Error:/.test(r);
  }

  /** Retry the goal once with more structure (plan-act) and, if configured, a
   * stronger model. Resets transcript to the bare goal and clears the failure
   * count so the retry starts clean. */
  private async escalate(goal: string): Promise<string> {
    this.escalated = true;
    if (this.fallbackModel && this.fallbackModel !== this.config.model) {
      this.onEvent?.({ type: "status", content: \`escalating to \${this.fallbackModel}\` });
      this.config = { ...this.config, model: this.fallbackModel };
    } else {
      this.onEvent?.({ type: "status", content: "escalating: retrying with explicit planning" });
    }
    this.safety.reset();
    this.nudged = false;
    this.messages = [{ role: "user", content: goal }];
    return this.runPlanAct(goal);
  }

  /** Compact the transcript when it nears the context window. */
  private async maybeCompact(): Promise<void> {
    const budget = Math.floor((this.config.contextTokens ?? 8192) * 0.7);
    if (estimateTokens(this.messages) <= budget) return;
    this.messages = await compactMessages(this.messages, {
      maxTokens: budget,
      summarize: async (older) => {
        let summary = "";
        const req = [
          { role: "system", content: "Summarize this conversation concisely, preserving decisions, file paths, and open questions." },
          { role: "user", content: JSON.stringify(older).slice(0, 8000) },
        ];
        for await (const e of streamProvider(this.config, req)) {
          if (e.type === "text") summary += e.content ?? "";
        }
        return summary || "(no summary)";
      },
    });
  }

  /** Frontier/strong: free-form native tool loop (Claude Code semantics). */
  private async runFree(goal: string): Promise<string> {
    let iteration = 0;

    while (true) {
      iteration++;
      const verdict = this.safety.check(iteration);
      if (verdict.shouldStop) return \`Stopped: \${verdict.reason}\`;

      await this.maybeCompact();

      const systemPrompt = await this.loadSystemPrompt();
      const activeSkills = matchSkills(this.skills, goal);
      const system = systemPrompt + skillsPromptBlock(activeSkills);
      const planMessages = system.trim()
        ? [{ role: "system", content: \`\${system}\\n\\nGoal: \${goal}\` }, ...this.messages]
        : [...this.messages];

      const selected = selectTools(this.tools, goal, this.profile.maxTools);
      const toolDefs = toToolDefs(selected);
      const decode = { temperature: this.profile.temperature, repeatPenalty: this.profile.repeatPenalty };

      let fullText = "";
      const calls: ToolUse[] = [];

      for await (const event of streamProvider(this.config, planMessages, toolDefs, decode)) {
        if (event.type === "text") {
          fullText += event.content ?? "";
          this.onEvent?.({ type: "text", content: event.content ?? "" });
        }
        if (event.type === "tool_use") calls.push({ name: event.name ?? "", input: (event.input ?? {}) as Record<string, unknown>, id: event.id ?? "" });
        if (event.type === "error") return \`Error: \${event.content}\`;
      }

      const assistantMsg: Record<string, unknown> = { role: "assistant", content: fullText };
      if (calls.length) {
        // Echoed tool_calls: Ollama /api/chat wants arguments as an OBJECT;
        // OpenAI-compatible hosts want a JSON STRING. Sending the wrong one makes
        // Ollama 400 ("looks like object, can't find closing '}'") on the next turn.
        const asObject = this.config.type === "ollama";
        assistantMsg.tool_calls = calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: asObject ? c.input : JSON.stringify(c.input) } }));
      }
      this.messages.push(assistantMsg);

      if (calls.length === 0) {
        // Small models often NARRATE tool use ("I'll now list the files...")
        // instead of emitting tool_calls. A good harness pushes back: if the
        // reply announces action but performs none, nudge once to force a
        // real call instead of returning the narration as a final answer.
        const narrates = this.profile.nudge
          && /\\b(i(?:'| wi)ll|let'?s|going to|first,|now i|i need to use)\\b/i.test(fullText)
          && this.tools.length > 0
          && !this.nudged;
        if (narrates) {
          this.nudged = true;
          this.onEvent?.({ type: "status", content: "nudging model to act" });
          this.messages.push({
            role: "user",
            content: "Do not describe what you will do — DO IT. Call the appropriate tool now via a function call. If the goal is already fully answered, give the final answer with no preamble.",
          });
          continue;
        }
        if (this.persistSession) await saveSession(this.messages);
        return fullText;
      }
      this.nudged = false;

      for (const call of calls) {
        this.onEvent?.({ type: "tool_use", toolName: call.name, toolInput: call.input });
        const tool = this.tools.find(t => t.name === call.name);
        let output = "";
        if (!tool) {
          output = \`Tool '\${call.name}' not found\`;
        } else {
          const permission = await this.resolveToolPermission(call.name, call.input);
          if (!permission.ok) {
            output = \`Permission denied: \${permission.reason}\`;
            this.safety.recordFailure();
          } else {
            output = await this.callToolChecked(tool, call.input);
          }
        }
        this.messages.push({ role: "tool", content: compactToolOutput(output), tool_call_id: call.id });
        this.onEvent?.({ type: "tool_done", toolName: call.name });
      }

      if (this.persistSession) await saveSession(this.messages);

      // Claude Code loop semantics: tool results go back to the model and the
      // loop continues; the model signals completion by replying WITHOUT tool
      // calls. No separate goal-check call — it doubled latency and confused
      // small models.
    }
  }

  /** Build the constrained-json system message for a decision turn. */
  private async decisionSystem(goal: string, toolList: string, stageInstruction?: string): Promise<string> {
    const base = (await this.loadSystemPrompt()).slice(0, this.profile.systemPromptBudget);
    return [
      base,
      \`Goal: \${goal}\`,
      stageInstruction ? \`Current step: \${stageInstruction}\` : "",
      DECISION_RULES,
      \`Available tools:\\n\${toolList}\`,
    ].filter(Boolean).join("\\n\\n");
  }

  /** Small/mid models often emit a correct-but-ugly JSON-ish final answer. One
   * unconstrained call restates it as plain prose using only facts already in
   * the transcript. Fails safe: any error returns the rough draft unchanged. */
  private async finalizeAnswer(goal: string, rough: string): Promise<string> {
    const sys = "Restate the final answer to the user's goal in 1-3 plain English sentences, using only facts already established in this conversation. No JSON, no code fences, no preamble.";
    const msgs = [{ role: "system", content: sys }, ...this.messages, { role: "user", content: \`Goal: \${goal}\\n\\nDraft answer: \${rough}\\n\\nRewrite it as plain prose.\` }];
    let out = "";
    try {
      for await (const e of streamProvider(this.config, msgs, undefined, { temperature: this.profile.temperature })) {
        if (e.type === "text") out += e.content ?? "";
        if (e.type === "error") return rough;
      }
    } catch { return rough; }
    const clean = out.trim();
    return clean.length >= 2 ? clean : rough;
  }

  /** Mid/small: grammar-forced JSON dispatch, one tool per turn. Narration is
   * physically impossible under the decision schema — the #1 small-model failure. */
  private async runDecisionLoop(goal: string, stageInstruction?: string): Promise<string> {
    let iteration = 0;
    const selected = selectTools(this.tools, goal, this.profile.maxTools);
    const toolList = selected.map(t => {
      const schema = t.inputSchema.toJSONSchema?.() as { properties?: Record<string, unknown> } | undefined;
      const params = schema?.properties ? Object.keys(schema.properties).join(", ") : "";
      return \`- \${t.name}(\${params}): \${t.description}\`;
    }).join("\\n");
    const decode = { format: DECISION_SCHEMA, temperature: this.profile.temperature, repeatPenalty: this.profile.repeatPenalty };
    let toolsUsed = 0;
    let actNudged = false;
    let verifyChecked = false;

    // Ground small/mid models against real paths up front. Left to themselves
    // they assume a conventional src/ layout and read (or conclude absence on)
    // files that aren't there — the dominant domain-task failure. Handing over
    // the actual cwd filenames once removes the guess.
    if ((this.profile.tier === "small" || this.profile.tier === "mid") &&
        !this.messages.some(m => typeof m.content === "string" && m.content.startsWith("Files in the working directory:"))) {
      try {
        const entries = (await import("node:fs")).readdirSync(process.cwd());
        const listing = entries.slice(0, 50).join(", ") + (entries.length > 50 ? ", …" : "");
        this.messages.unshift({ role: "user", content: \`Files in the working directory: \${listing}. Read paths relative to this directory — do NOT assume a src/ subfolder.\` });
      } catch { /* fs unavailable — skip grounding */ }
    }

    while (true) {
      iteration++;
      const verdict = this.safety.check(iteration);
      if (verdict.shouldStop) return \`Stopped: \${verdict.reason}\`;

      await this.maybeCompact();

      const sys = await this.decisionSystem(goal, toolList, stageInstruction);
      const reqMessages = [{ role: "system", content: sys }, ...this.messages];

      let raw = "";
      for await (const e of streamProvider(this.config, reqMessages, undefined, decode)) {
        if (e.type === "text") { raw += e.content ?? ""; this.onEvent?.({ type: "text", content: e.content ?? "" }); }
        if (e.type === "error") return \`Error: \${e.content}\`;
      }

      const decision = parseDecision(raw);
      if (!decision) {
        // Grammar should prevent this, but degrade gracefully: one retry, then final.
        if (!this.nudged) {
          this.nudged = true;
          this.messages.push({ role: "assistant", content: raw });
          this.messages.push({ role: "user", content: DECISION_RULES });
          continue;
        }
        if (this.persistSession) await saveSession(this.messages);
        return unwrapFinal(raw.trim());
      }
      this.nudged = false;

      if (decision.action === "final") {
        // Act-before-answer: a small model often answers from memory on turn 1
        // without ever calling a tool (its #1 task-following failure). If it
        // finalizes before touching a single tool, push back once.
        if (toolsUsed === 0 && !actNudged && this.tools.length > 0) {
          actNudged = true;
          this.onEvent?.({ type: "status", content: "pushing model to use a tool" });
          this.messages.push({ role: "assistant", content: JSON.stringify(decision) });
          this.messages.push({ role: "user", content: "You have not used any tool yet. Do not answer from memory — call the appropriate tool to inspect or change the real files first, then finish." });
          continue;
        }
        // Verify pass: a negative claim from a small/mid model is grounded against
        // the real filesystem before it's trusted. Small models hallucinate a
        // path prefix (e.g. src/) then "confirm" absence — so the HARNESS lists
        // the actual cwd and hands over the true filenames, rather than letting
        // the model pick where to look again. Deterministic; a genuine absence
        // survives (the file simply isn't in the list). Fires once.
        if ((this.profile.tier === "small" || this.profile.tier === "mid") &&
            !verifyChecked && this.tools.length > 0 &&
            NEGATIVE_CLAIM.test(unwrapFinal(decision.answer ?? ""))) {
          verifyChecked = true;
          this.onEvent?.({ type: "status", content: "verifying claim against the filesystem" });
          let listing = "";
          try {
            const entries = (await import("node:fs")).readdirSync(process.cwd());
            listing = entries.slice(0, 60).join(", ") + (entries.length > 60 ? ", …" : "");
          } catch { /* fs unavailable — fall back to a plain re-check nudge */ }
          this.messages.push({ role: "assistant", content: JSON.stringify(decision) });
          this.messages.push({ role: "user", content: listing
            ? \`The working directory actually contains these files: \${listing}. Do NOT assume a subdirectory like src/ — read paths relative to the current directory. If the item you called missing is in that list, read it and correct your answer; only conclude absence if it is truly not listed.\`
            : "Before finalizing: verify with a tool, reading paths relative to the current directory (do not assume a src/ prefix). Correct your answer if the item actually exists." });
          continue;
        }
        let answer = unwrapFinal(decision.answer ?? "");
        if ((this.profile.tier === "small" || this.profile.tier === "mid") && looksNonProse(answer)) {
          this.onEvent?.({ type: "status", content: "restating answer" });
          answer = await this.finalizeAnswer(goal, answer);
        }
        this.messages.push({ role: "assistant", content: answer });
        if (this.persistSession) await saveSession(this.messages);
        return answer;
      }

      const name = decision.tool ?? "";
      const args = decision.args ?? {};
      toolsUsed++;
      this.messages.push({ role: "assistant", content: JSON.stringify(decision) });
      this.onEvent?.({ type: "tool_use", toolName: name, toolInput: args });

      const tool = this.tools.find(t => t.name === name);
      let output = "";
      if (!tool) {
        output = \`Tool '\${name}' not found. Available: \${selected.map(t => t.name).join(", ")}\`;
        this.safety.recordFailure();
      } else {
        const permission = await this.resolveToolPermission(name, args);
        if (!permission.ok) {
          output = \`Permission denied: \${permission.reason}\`;
          this.safety.recordFailure();
        } else {
          output = await this.callToolChecked(tool, args);
        }
      }
      this.messages.push({ role: "user", content: \`Observation from \${name}:\\n\${compactToolOutput(output)}\` });
      this.onEvent?.({ type: "tool_done", toolName: name });
      if (this.persistSession) await saveSession(this.messages);
    }
  }

  /** Mid tier: one constrained planning call produces a numbered step list,
   * seeded into the transcript, then the structured decision loop executes it. */
  private async runPlanAct(goal: string): Promise<string> {
    const toolNames = selectTools(this.tools, goal, this.profile.maxTools).map(t => t.name).join(", ");
    const planSys = [
      (await this.loadSystemPrompt()).slice(0, this.profile.systemPromptBudget),
      \`Goal: \${goal}\`,
      \`Break this goal into 2-5 concrete, ordered steps a tool-using agent can execute. Available tools: \${toolNames}.\`,
      'Reply with ONLY a JSON object: {"steps":["step 1","step 2"]}.',
    ].filter(Boolean).join("\\n\\n");

    let raw = "";
    for await (const e of streamProvider(
      this.config,
      [{ role: "system", content: planSys }, { role: "user", content: goal }],
      undefined,
      { format: PLAN_STEPS_SCHEMA, temperature: this.profile.temperature, repeatPenalty: this.profile.repeatPenalty },
    )) {
      if (e.type === "text") raw += e.content ?? "";
      if (e.type === "error") return \`Error: \${e.content}\`;
    }

    const steps = parseSteps(raw);
    if (steps.length) {
      this.onEvent?.({ type: "status", content: \`planned \${steps.length} steps\` });
      this.messages.push({
        role: "user",
        content: "Plan:\\n" + steps.map((s, i) => \`\${i + 1}. \${s}\`).join("\\n") + "\\n\\nExecute the plan step by step using tools.",
      });
    }
    return this.runDecisionLoop(goal);
  }

  /** Small tier: run the builder-baked domain pipeline. The stages are decided
   * at BUILD time (the builder knows the domain), so a 3B model doesn't have to
   * plan — it just fills the slots. Falls back to the decision loop if unbaked. */
  private async runPipeline(goal: string): Promise<string> {
    if (PIPELINE.length) {
      const steps = PIPELINE
        .map((s, i) => \`\${i + 1}. \${s.instruction}\${s.tool ? \` (use the \${s.tool} tool)\` : ""}\`)
        .join("\\n");
      this.onEvent?.({ type: "status", content: \`pipeline: \${PIPELINE.length} stages\` });
      this.messages.push({
        role: "user",
        content: "Follow this fixed procedure to accomplish the goal, one step at a time using tools:\\n" + steps,
      });
    }
    return this.runDecisionLoop(goal);
  }

  /** Permission gate with interactive escalation. A denial in default mode is
   * offered to the UI (allow once / deny / always). "always" persists a
   * conservative rule so the prompt never repeats for that target. */
  private async resolveToolPermission(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    const verdict = checkPermission(this.policy, name, args);
    if (verdict.allowed) return { ok: true };
    if (!this.onPermissionRequest || this.policy.mode !== "default") {
      audit("permission_deny", { tool: name, target: targetOf(args), reason: verdict.reason });
      return { ok: false, reason: verdict.reason };
    }
    const choice = await this.onPermissionRequest({ tool: name, input: args, reason: verdict.reason ?? "needs approval" });
    if (choice === "deny") {
      audit("permission_deny", { tool: name, target: targetOf(args), reason: "denied by user" });
      return { ok: false, reason: "denied by user" };
    }
    if (choice === "always") {
      const target = targetOf(args);
      const glob = !target
        ? "*"
        : name === "bash"
          ? target.split(/\\s+/)[0] + " *"
          : target.split("/")[0] + "/**";
      this.policy.rules.push({ pattern: name + "(" + glob + ")", allow: true });
      this.toolContext.permissions.rules = this.policy.rules;
      savePolicy(this.policy);
    }
    return { ok: true };
  }

  /** Validate args against the tool's schema, then run it. On a schema mismatch
   * (a small model's #2 failure — right tool, wrong arg keys) return a corrective
   * message naming the expected keys so the model self-fixes next turn, instead
   * of a dead exception. Validation misses are recoverable — they don't count
   * toward the consecutive-failure stop; real exceptions do. */
  private async callToolChecked(tool: Tool, args: Record<string, unknown>): Promise<string> {
    const target = targetOf(args);
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      const schema = tool.inputSchema.toJSONSchema?.() as { properties?: Record<string, { type?: string }> } | undefined;
      const sig = schema?.properties
        ? Object.entries(schema.properties).map(([k, v]) => k + ":" + (v?.type ?? "any")).join(", ")
        : "";
      audit("tool_reject", { tool: tool.name, target, reason: "invalid args" });
      return "Invalid arguments for " + tool.name + ". Expected { " + sig + " }, but you sent " + JSON.stringify(args) + ". Retry with those exact keys.";
    }
    try {
      const r = await tool.call(parsed.data as Record<string, unknown>, this.toolContext);
      this.safety.recordSuccess();
      audit("tool_call", { tool: tool.name, target, ok: true });
      return r.error ? r.error : r.content ?? JSON.stringify(r.data ?? "");
    } catch (err) {
      this.safety.recordFailure();
      audit("tool_call", { tool: tool.name, target, ok: false, error: String(err).slice(0, 200) });
      return String(err);
    }
  }

  private async loadSystemPrompt(): Promise<string> {
    const paths = [
      join(process.cwd(), ".${plan.name}", "system.md"),
      join(process.cwd(), ".harnage", "system.md"),
      join(homedir(), ".${plan.name}", "system.md"),
    ];
    for (const p of paths) {
      try { return await import("node:fs/promises").then(fs => fs.readFile(p, "utf-8")); } catch { /* try next */ }
    }
    return "";
  }
}
`;

export const GENERATED_TUI = (
	plan: HarnessPlan,
) => `import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useRef, useState } from "react";
import { COMMANDS, findCommand } from "./commands.ts";
import { LoopEngine, type EngineConfig, type ProviderConfig } from "./engine.ts";
import type { ModelProfile } from "./profiles.ts";
import type { Skill } from "./skills.ts";
import type { Tool } from "./Tool.ts";

type HistoryItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "error"; text: string }
  | { kind: "info"; text: string };

interface AppProps {
  config: ProviderConfig;
  tools: Tool[];
  skills: Skill[];
  profile: ModelProfile;
  initialMessages?: Array<Record<string, unknown>>;
}

function toolLabel(name: string | undefined, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const preview =
    typeof o.command === "string" ? o.command :
    typeof o.path === "string" ? o.path :
    typeof o.pattern === "string" ? o.pattern : "";
  const n = name ?? "Tool";
  return preview ? n + " · " + preview.slice(0, 80) : n;
}

function permTarget(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.command === "string") return o.command;
  if (typeof o.path === "string") return o.path;
  if (typeof o.file_path === "string") return o.file_path;
  return "";
}

interface PermPrompt { tool: string; target: string; reason: string; resolve: (c: "allow" | "deny" | "always") => void; }

export function App({ config, tools, skills, profile, initialMessages }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<HistoryItem[]>([
    { kind: "info", text: "⚙ ${plan.name} — " + config.type + " · " + config.model },
    { kind: "info", text: "  scaffold: " + profile.tier + " tier · " + profile.loop + " loop · " + profile.toolCalling + " · " + profile.maxTools + " tools" },
    { kind: "info", text: "  type a goal · / for commands · /help for the full list · esc to quit" },
  ]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const messagesRef = useRef<Array<Record<string, unknown>> | undefined>(initialMessages);
  const [perm, setPerm] = useState<PermPrompt | null>(null);

  const push = useCallback((item: HistoryItem) => {
    setHistory((h) => [...h, item]);
  }, []);

  useInput((inputCh, key) => {
    if (perm) {
      if (inputCh === "a") { perm.resolve("allow"); setPerm(null); }
      else if (inputCh === "y") { perm.resolve("always"); setPerm(null); }
      else if (inputCh === "d" || key.escape) { perm.resolve("deny"); setPerm(null); }
      return;
    }
    if (key.escape && !busyRef.current) exit();
  });

  const runGoal = useCallback(async (goal: string) => {
    busyRef.current = true;
    setBusy(true);
    push({ kind: "user", text: goal });

    let current = "";
    const engineConfig: EngineConfig = {
      tools,
      providerConfig: config,
      skills,
      profile,
      initialMessages: messagesRef.current,
      onEvent: (e) => {
        if (e.type === "text") {
          current += e.content ?? "";
          setStreamingText(current);
        } else if (e.type === "tool_use") {
          if (current.trim()) { push({ kind: "agent", text: current }); current = ""; setStreamingText(""); }
          const label = toolLabel(e.toolName, e.toolInput);
          setActiveTool(label);
          push({ kind: "tool", label });
        } else if (e.type === "tool_done") {
          setActiveTool(null);
        } else if (e.type === "status") {
          setActiveTool(e.content ?? null);
          if (current.trim()) { push({ kind: "agent", text: current }); current = ""; setStreamingText(""); }
        }
      },
      onPermissionRequest: (req) =>
        new Promise((resolve) => {
          setPerm({ tool: req.tool, target: permTarget(req.input), reason: req.reason, resolve });
        }),
    };
    const engine = new LoopEngine(engineConfig);
    try {
      const result = await engine.run(goal);
      if (current.trim() && !result.startsWith(current.slice(0, 20))) {
        push({ kind: "agent", text: current });
      } else if (result.trim()) {
        push({ kind: "agent", text: result });
      }
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
    messagesRef.current = engine.getMessages();
    setStreamingText("");
    setActiveTool(null);
    setBusy(false);
    busyRef.current = false;
  }, [config, tools, skills, profile, push]);

  // Slash commands run through the harness's own command registry (commands.ts)
  // — the same set the classic REPL exposes — so the TUI is a first-class way to
  // invoke /help, /model, /cost, etc., not just a chat box.
  const handleCommand = useCallback(async (trimmed: string) => {
    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/clear") { setHistory([]); messagesRef.current = undefined; return; }
    const matched = findCommand(trimmed);
    if (!matched) { push({ kind: "error", text: "Unknown command '" + trimmed + "'. Type /help." }); return; }
    try {
      const mod = await matched.command.load();
      const handler = mod.default as { call: (args: string[], ctx: unknown) => Promise<{ value: string }> };
      const result = await handler.call(matched.args, {});
      if (result.value === "EXIT_APP") { exit(); }
      else if (result.value === "CLEAR_MESSAGES") { setHistory([]); messagesRef.current = undefined; }
      else if (result.value) { push({ kind: "info", text: result.value }); }
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }, [exit, push]);

  const onSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    setInput("");
    if (!trimmed || busyRef.current) return;
    if (trimmed.startsWith("/")) { void handleCommand(trimmed); return; }
    void runGoal(trimmed);
  }, [runGoal, handleCommand]);

  // Live slash-command menu: as soon as the input starts with "/", surface the
  // matching commands so they are discoverable and highlighted, Claude Code-style.
  const slashQuery = input.trim().split(" ")[0];
  const slashMatches = input.startsWith("/") && !busy
    ? COMMANDS.filter((c) => c.name.startsWith(slashQuery)).slice(0, 6)
    : [];

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(item, i) => (
          <Box key={i} paddingLeft={1}>
            {item.kind === "user" && (<Text><Text bold>You</Text><Text dimColor>: </Text>{item.text}</Text>)}
            {item.kind === "agent" && (<Text><Text bold color="cyan">Agent</Text><Text dimColor>: </Text>{item.text}</Text>)}
            {item.kind === "tool" && <Text dimColor>↳ {item.label}</Text>}
            {item.kind === "error" && <Text color="red">✖ {item.text}</Text>}
            {item.kind === "info" && <Text dimColor>{item.text}</Text>}
          </Box>
        )}
      </Static>

      {streamingText !== "" && (
        <Box paddingLeft={1}>
          <Text><Text bold color="cyan">Agent</Text><Text dimColor>: </Text>{streamingText}</Text>
        </Box>
      )}

      {busy && !perm && (
        <Box paddingLeft={1}>
          <Text color="yellow">✳ {activeTool ? "Running " + activeTool + "…" : "Thinking…"}</Text>
        </Box>
      )}

      {perm && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingLeft={1} paddingRight={1}>
          <Text color="yellow">⚠ Permission needed</Text>
          <Text><Text bold>{perm.tool}</Text>{perm.target ? <Text dimColor> · {perm.target.slice(0, 70)}</Text> : null}</Text>
          <Text dimColor>{perm.reason}</Text>
          <Text><Text color="green">[a]</Text> allow once   <Text color="cyan">[y]</Text> always (remember)   <Text color="red">[d]</Text> deny</Text>
        </Box>
      )}

      {slashMatches.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {slashMatches.map((c) => (
            <Text key={c.name}>
              <Text color="cyan">{c.name}</Text>
              <Text dimColor>{"  " + c.description}</Text>
            </Text>
          ))}
        </Box>
      )}

      <Box borderStyle="round" borderDimColor paddingLeft={1} paddingRight={1}>
        <Text color={input.startsWith("/") ? "magenta" : "cyan"}>{"❯ "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={onSubmit} focus={perm === null} placeholder={busy ? "working…" : "type a goal · / for commands"} />
      </Box>

      <Box paddingLeft={2} paddingRight={2} justifyContent="space-between">
        <Text dimColor>⏵⏵ {busy ? "working" : "ready"} (esc to quit)</Text>
        <Text dimColor>{config.model.split("/").pop()}</Text>
      </Box>
    </Box>
  );
}
`;
