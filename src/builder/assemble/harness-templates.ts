import type { HarnessPlan } from "../index";

/**
 * Templates for the generated harness's subsystem modules — the features
 * that make a generated harness "properly built": context compaction,
 * path-rule permissions, skills-as-markdown, session persistence, and
 * sub-agents. Kept plan-independent where possible to minimize escaping.
 */

export const HARNESS_PROFILES = `// ModelProfile — per-model scaffold adaptation (Engine v3). Resolves the
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

/** Resolve a model name to its scaffold profile. Ordered; first match wins. */
export function resolveProfile(model: string, contextTokens = 8192): ModelProfile {
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
    return { tier: "small", loop: "pipeline", toolCalling: "constrained-json", maxTools: 3,
      editFormat: "whole-file", systemPromptBudget: 1600, temperature: 0, repeatPenalty: 1.15, nudge: false, contextTokens };
  }

  // Mid models (7-8B) and unknown: plan-act + constrained JSON (safe default).
  return { tier: "mid", loop: "plan-act", toolCalling: "constrained-json", maxTools: 5,
    editFormat: "whole-file", systemPromptBudget: 2400, temperature: 0.1, repeatPenalty: 1.1, nudge: false, contextTokens };
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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
AgentForge — edit or add skills in this directory to teach it your workflows.
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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "./Tool.ts";
import { compactMessages, estimateTokens } from "./compaction.ts";
import { checkPermission, loadPolicy, type PermissionPolicy } from "./permissions.ts";
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

export class SafetyMonitor {
  private failures = 0;

  check(iteration: number, maxIterations = 20, maxFailures = 3): { shouldStop: boolean; reason?: string } {
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

const CORE_TOOLS = ["file_read", "bash", "glob", "grep"];

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

const DECISION_RULES =
  'You act by returning ONE JSON object and nothing else. ' +
  'To use a tool: {"action":"tool","tool":"<name>","args":{...}}. ' +
  'To give your final answer: {"action":"final","answer":"<text>"}. ' +
  'Do NOT describe what you will do — return the tool action. One tool per turn.';

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
  // Ollama grammar-constrained decoding: force the reply to match a JSON schema.
  // A small model physically cannot emit malformed JSON under this constraint.
  if (opts?.format !== undefined && isOllama) body.format = opts.format;

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
  private nudged = false;

  constructor(config: EngineConfig) {
    this.tools = config.tools;
    this.config = config.providerConfig;
    this.skills = config.skills ?? [];
    this.persistSession = config.persistSession ?? true;
    this.onEvent = config.onEvent;
    this.policy = config.policy ?? loadPolicy();
    this.profile = config.profile ?? resolveProfile(this.config.model, this.config.contextTokens);
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
    this.messages.push({ role: "user", content: goal });
    // Dispatch by the resolved model profile — Engine v3's core move. Strong
    // native tool callers get the free loop; weaker models get grammar-forced
    // JSON dispatch, degrading toward more structure as the model shrinks.
    if (this.profile.toolCalling === "native") return this.runFree(goal);
    if (this.profile.loop === "pipeline") return this.runPipeline(goal);
    if (this.profile.loop === "plan-act") return this.runPlanAct(goal);
    return this.runDecisionLoop(goal);
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
        assistantMsg.tool_calls = calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }));
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
          const permission = checkPermission(this.policy, call.name, call.input);
          if (!permission.allowed) {
            output = \`Permission denied: \${permission.reason}\`;
            this.safety.recordFailure();
          } else {
            try {
              const r = await tool.call(call.input, this.toolContext);
              output = r.error ? r.error : r.content ?? JSON.stringify(r.data ?? "");
              this.safety.recordSuccess();
            } catch (err) {
              output = String(err);
              this.safety.recordFailure();
            }
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

  /** Mid/small: grammar-forced JSON dispatch, one tool per turn. Narration is
   * physically impossible under the decision schema — the #1 small-model failure. */
  private async runDecisionLoop(goal: string, stageInstruction?: string): Promise<string> {
    let iteration = 0;
    const selected = selectTools(this.tools, goal, this.profile.maxTools);
    const toolList = selected.map(t => \`- \${t.name}: \${t.description}\`).join("\\n");
    const decode = { format: DECISION_SCHEMA, temperature: this.profile.temperature, repeatPenalty: this.profile.repeatPenalty };

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
        return raw.trim();
      }
      this.nudged = false;

      if (decision.action === "final") {
        const answer = decision.answer ?? "";
        this.messages.push({ role: "assistant", content: answer });
        if (this.persistSession) await saveSession(this.messages);
        return answer;
      }

      const name = decision.tool ?? "";
      const args = decision.args ?? {};
      this.messages.push({ role: "assistant", content: JSON.stringify(decision) });
      this.onEvent?.({ type: "tool_use", toolName: name, toolInput: args });

      const tool = this.tools.find(t => t.name === name);
      let output = "";
      if (!tool) {
        output = \`Tool '\${name}' not found. Available: \${selected.map(t => t.name).join(", ")}\`;
        this.safety.recordFailure();
      } else {
        const permission = checkPermission(this.policy, name, args);
        if (!permission.allowed) {
          output = \`Permission denied: \${permission.reason}\`;
          this.safety.recordFailure();
        } else {
          try {
            const r = await tool.call(args, this.toolContext);
            output = r.error ? r.error : r.content ?? JSON.stringify(r.data ?? "");
            this.safety.recordSuccess();
          } catch (err) {
            output = String(err);
            this.safety.recordFailure();
          }
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

  private async loadSystemPrompt(): Promise<string> {
    const paths = [
      join(process.cwd(), ".${plan.name}", "system.md"),
      join(process.cwd(), ".agentforge", "system.md"),
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

export function App({ config, tools, skills, profile, initialMessages }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<HistoryItem[]>([
    { kind: "info", text: "⚙ ${plan.name} — " + config.type + " · " + config.model },
    { kind: "info", text: "  scaffold: " + profile.tier + " tier · " + profile.loop + " loop · " + profile.toolCalling + " · " + profile.maxTools + " tools" },
  ]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const messagesRef = useRef<Array<Record<string, unknown>> | undefined>(initialMessages);

  const push = useCallback((item: HistoryItem) => {
    setHistory((h) => [...h, item]);
  }, []);

  useInput((_, key) => {
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

  const onSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    setInput("");
    if (!trimmed || busyRef.current) return;
    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/clear") { setHistory([]); messagesRef.current = undefined; return; }
    void runGoal(trimmed);
  }, [runGoal, exit]);

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

      {busy && (
        <Box paddingLeft={1}>
          <Text color="yellow">✳ {activeTool ? "Running " + activeTool + "…" : "Thinking…"}</Text>
        </Box>
      )}

      <Box borderStyle="round" borderDimColor paddingLeft={1} paddingRight={1}>
        <Text color="cyan">{"❯ "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder={busy ? "working…" : "type a goal · /clear · /exit"} />
      </Box>

      <Box paddingLeft={2} paddingRight={2} justifyContent="space-between">
        <Text dimColor>⏵⏵ {busy ? "working" : "ready"} (esc to quit)</Text>
        <Text dimColor>{config.model.split("/").pop()}</Text>
      </Box>
    </Box>
  );
}
`;
