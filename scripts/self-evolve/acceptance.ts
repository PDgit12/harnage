// Acceptance harness for a self-evolve candidate.
//
// THE rule (from the video, guardrails not suggestions):
//   1. Run the FULL suite (held-in + held-out) — never just the failing task.
//   2. Accept only if NO task regresses (pass -> fail) AND at least one task
//      strictly improves (fail -> pass).
//   3. Check PER-TASK, not aggregate. An aggregate total can hide one task
//      breaking while another flakes upward; the per-task diff cannot.

import type { Knobs } from "./editable-surface.ts";
import { TASKS, type Task } from "./task-suite.ts";

export interface TaskRow {
  id: string;
  category: string;
  split: string;
  base: boolean;
  cand: boolean;
  delta: "improved" | "regressed" | "same";
  detail: string;
}

export interface AcceptanceReport {
  accepted: boolean;
  reason: string;
  improved: string[];
  regressed: string[];
  basePass: number;
  candPass: number;
  total: number;
  rows: TaskRow[];
}

function gradeAll(knobs: Knobs, tasks: Task[] = TASKS): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const t of tasks) m.set(t.id, t.run(knobs).pass);
  return m;
}

export function runAcceptance(baseline: Knobs, candidate: Knobs, tasks: Task[] = TASKS): AcceptanceReport {
  const base = gradeAll(baseline, tasks);
  const cand = gradeAll(candidate, tasks);
  const rows: TaskRow[] = [];
  const improved: string[] = [];
  const regressed: string[] = [];

  for (const t of tasks) {
    const b = base.get(t.id)!;
    const c = t.run(candidate);
    let delta: TaskRow["delta"] = "same";
    if (!b && c.pass) { delta = "improved"; improved.push(t.id); }
    else if (b && !c.pass) { delta = "regressed"; regressed.push(t.id); }
    rows.push({ id: t.id, category: t.category, split: t.split, base: b, cand: c.pass, delta, detail: c.detail });
  }

  const basePass = [...base.values()].filter(Boolean).length;
  const candPass = [...cand.values()].filter(Boolean).length;

  // Per-task gate — decided by the improved/regressed SETS, never by the totals.
  let accepted = false;
  let reason = "";
  if (regressed.length > 0) {
    reason = `REJECT — ${regressed.length} task(s) regressed: ${regressed.join(", ")} (aggregate ${basePass}->${candPass} would have hidden this)`;
  } else if (improved.length === 0) {
    reason = "REJECT — no task strictly improved (no-op or lateral change)";
  } else {
    accepted = true;
    reason = `ACCEPT — ${improved.length} improved, 0 regressed: ${improved.join(", ")}`;
  }

  return { accepted, reason, improved, regressed, basePass, candPass, total: tasks.length, rows };
}

/** Render the per-task table (the artifact that goes into the PR/diff). */
export function renderTable(rep: AcceptanceReport): string {
  const mark = (b: boolean) => (b ? "PASS" : "FAIL");
  const sym = { improved: "↑ improved", regressed: "↓ REGRESSED", same: "  same" };
  const head = "| task | category | split | base | candidate | delta |\n|---|---|---|---|---|---|";
  const body = rep.rows
    .map((r) => `| ${r.id} | ${r.category} | ${r.split} | ${mark(r.base)} | ${mark(r.cand)} | ${sym[r.delta]} |`)
    .join("\n");
  const foot = `\n\nAggregate: ${rep.basePass}/${rep.total} → ${rep.candPass}/${rep.total}. **${rep.reason}**`;
  return head + "\n" + body + foot;
}
