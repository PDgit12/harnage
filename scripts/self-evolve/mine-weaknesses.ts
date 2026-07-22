// Weakness mining over a harness audit trail (~/.<name>/audit.jsonl).
//
// Reads the append-only audit trail, keeps only failing `eval` records, and
// clusters them by cause signature. The primary signature is the failing eval
// NAME (the "same eval name failing repeatedly" case); numeric noise in the
// detail (scores, counts) is stripped so it can't fragment a real cluster. A
// cluster of size 1 is a one-off flake and is DROPPED — a weakness must repeat
// (>1x, same signature) to be actionable. Surviving clusters are mapped to a
// suspected editable-surface knob via KNOWN_CAUSES (matched on name + detail).
//
// This is authored in harnage's own repo first (dev tool); the same logic is
// what gets templated into generated harnesses later.

import { readFileSync } from "node:fs";

export interface AuditRecord {
  kind: string;
  name?: string;
  pass?: boolean;
  detail?: string;
  [k: string]: unknown;
}

export interface Cluster {
  signature: string;
  evalName: string;
  count: number;
  sampleDetail: string;
  suspectedKnob?: string;
  direction?: "increase" | "decrease";
  rationale?: string;
}

// Bridge from a repeated failure signature to the knob that addresses it. This
// is the fixer's domain knowledge — the ONLY place a failure class is tied to a
// surface knob. Match is by substring on the normalized eval name + detail.
const KNOWN_CAUSES: { match: RegExp; knob: string; direction: "increase" | "decrease"; rationale: string }[] = [
  { match: /judge_quality.*missing earlier context/, knob: "memory.recallLimit", direction: "increase",
    rationale: "judge repeatedly penalizes answers for dropping earlier-session context → long-term recall window too small" },
  { match: /used_tool_when_available.*no tool touched/, knob: "tools.maxTools", direction: "increase",
    rationale: "harness repeatedly fails to touch a tool → the needed tool may be pruned by the ACI budget" },
  { match: /completed_without_stop.*exceeded max iterations/, knob: "loop.maxIterations", direction: "increase",
    rationale: "runs repeatedly hit the iteration cap before finishing" },
];

/** Cluster key: the failing eval name. Repeated failures of the same eval are
 * the actionable signal; the varying detail is kept only as a sample and for
 * KNOWN_CAUSES matching. */
function signatureOf(name: string, _detail: string): string {
  return name;
}

/** Normalized name+detail used to match a cluster to a known cause. Digits are
 * stripped so scores/counts don't matter. */
function causeText(name: string, detail: string): string {
  return `${name} ${detail}`.toLowerCase().replace(/[0-9]+/g, "#").replace(/\s+/g, " ").trim();
}

export function parseAudit(text: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as AuditRecord); } catch { /* skip malformed audit line */ }
  }
  return out;
}

export function mineWeaknesses(records: AuditRecord[]): Cluster[] {
  const buckets = new Map<string, Cluster & { _cause: string }>();
  for (const r of records) {
    if (r.kind !== "eval" || r.pass !== false) continue;
    const name = r.name ?? "unknown";
    const detail = r.detail ?? "";
    const sig = signatureOf(name, detail);
    const c = buckets.get(sig) ?? { signature: sig, evalName: name, count: 0, sampleDetail: detail, _cause: causeText(name, detail) };
    c.count += 1;
    buckets.set(sig, c);
  }
  const clusters: Cluster[] = [];
  for (const c of buckets.values()) {
    if (c.count < 2) continue; // drop one-off flakes
    const cause = KNOWN_CAUSES.find((k) => k.match.test(c._cause));
    if (cause) { c.suspectedKnob = cause.knob; c.direction = cause.direction; c.rationale = cause.rationale; }
    clusters.push(c);
  }
  return clusters.sort((a, b) => b.count - a.count);
}

export function mineFromFile(path: string): Cluster[] {
  return mineWeaknesses(parseAudit(readFileSync(path, "utf8")));
}

// CLI: `bun scripts/self-evolve/mine-weaknesses.ts <audit.jsonl>`
if (import.meta.main) {
  const path = process.argv[2] ?? new URL("./fixtures/audit.jsonl", import.meta.url).pathname;
  const clusters = mineFromFile(path);
  console.log(`Mined ${clusters.length} weakness cluster(s) from ${path} (one-offs dropped):\n`);
  for (const c of clusters) {
    console.log(`  [x${c.count}] ${c.signature}`);
    if (c.suspectedKnob) console.log(`         → suspect knob ${c.suspectedKnob} (${c.direction}) — ${c.rationale}`);
    else console.log(`         → no known knob mapping (needs human triage)`);
  }
}
