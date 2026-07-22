// Self-evolve loop — level-4 (Lilian Weng) self-improving harness, model frozen.
//
//   mine  →  propose (held-in only)  →  full-suite acceptance (per-task)  →  DIFF ARTIFACT
//
// Nothing here mutates the editable surface or merges anything. It emits a
// candidate diff + a per-task report for a human to review. The model layer is
// never touched — only the four numeric knobs in editable-surface.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadSurface, knobValues, applyCandidate, validateCandidate,
  type Candidate, type EditableSurface,
} from "./editable-surface.ts";
import { mineFromFile, type Cluster } from "./mine-weaknesses.ts";
import { runAcceptance, renderTable, type AcceptanceReport } from "./acceptance.ts";
import { HELD_IN, type Task } from "./task-suite.ts";

const OUT_DIR = join(import.meta.dirname, "out");
const AUDIT_FIXTURE = join(import.meta.dirname, "fixtures", "audit.jsonl");

/** Search the suspected knob's range in the suspected direction, scoring only
 * on held-in tasks. Returns the SMALLEST change that maximizes held-in strict
 * improvements with zero held-in regressions (minimal-change principle — avoids
 * overshooting a knob into a new failure mode). Null if nothing helps. */
export function propose(surface: EditableSurface, cluster: Cluster): Candidate | null {
  if (!cluster.suspectedKnob || !cluster.direction) return null;
  const knob = surface.knobs[cluster.suspectedKnob];
  if (!knob) return null;
  const baseline = knobValues(surface);

  const gradeHeldIn = (cand: Candidate) => {
    const next = applyCandidate(surface, cand);
    let improved = 0, regressed = 0;
    for (const t of HELD_IN as Task[]) {
      const b = t.run(baseline).pass, c = t.run(next).pass;
      if (!b && c) improved++;
      else if (b && !c) regressed++;
    }
    return { improved, regressed };
  };

  const range: number[] = [];
  if (cluster.direction === "increase") for (let v = knob.value + 1; v <= knob.max; v++) range.push(v);
  else for (let v = knob.value - 1; v >= knob.min; v--) range.push(v);

  let best: { cand: Candidate; improved: number } | null = null;
  for (const v of range) {
    const cand: Candidate = { [cluster.suspectedKnob]: v };
    if (validateCandidate(surface, cand).length > 0) continue;
    const { improved, regressed } = gradeHeldIn(cand);
    if (regressed > 0) continue;              // never propose a held-in regression
    if (improved === 0) continue;
    // Keep the first value that reaches a new held-in improvement high-water
    // mark; because `range` walks outward from the current value, the first
    // hit at each level is the smallest change achieving it.
    if (!best || improved > best.improved) best = { cand, improved };
  }
  return best?.cand ?? null;
}

export interface EvolveResult {
  cluster: Cluster;
  candidate: Candidate;
  report: AcceptanceReport;
  diff: string;
  markdown: string;
}

function unifiedDiff(surface: EditableSurface, cand: Candidate): string {
  const lines: string[] = ["--- a/scripts/self-evolve/editable-surface.json", "+++ b/scripts/self-evolve/editable-surface.json"];
  for (const [name, val] of Object.entries(cand)) {
    const old = surface.knobs[name]?.value;
    lines.push(`@@ knobs.${JSON.stringify(name)}.value @@`, `-      "value": ${old},`, `+      "value": ${val},`);
  }
  return lines.join("\n");
}

export function runEvolve(): EvolveResult[] {
  const surface = loadSurface();
  const baseline = knobValues(surface);
  const clusters = mineFromFile(AUDIT_FIXTURE).filter((c) => c.suspectedKnob);
  const results: EvolveResult[] = [];

  for (const cluster of clusters) {
    const candidate = propose(surface, cluster);
    if (!candidate) continue;
    const report = runAcceptance(baseline, applyCandidate(surface, candidate));
    if (!report.accepted) continue; // gate: only accepted candidates become artifacts
    const diff = unifiedDiff(surface, candidate);
    const md = [
      `## Self-evolve candidate — ${cluster.suspectedKnob}`,
      "",
      `**Mined weakness:** \`${cluster.signature}\` (×${cluster.count}, one-off flakes dropped)`,
      `**Rationale:** ${cluster.rationale}`,
      `**Proposed edit:** ${Object.entries(candidate).map(([k, v]) => `${k}: ${surface.knobs[k].value} → ${v}`).join(", ")}`,
      "",
      "### Full-suite acceptance (per-task, held-in + held-out)",
      "",
      renderTable(report),
      "",
      "```diff",
      diff,
      "```",
      "",
      "_Candidate only — not applied, not merged. Review and land via PR._",
    ].join("\n");
    results.push({ cluster, candidate, report, diff, markdown: md });
  }
  return results;
}

if (import.meta.main) {
  const results = runEvolve();
  mkdirSync(OUT_DIR, { recursive: true });
  if (results.length === 0) { console.log("No accepted candidate produced."); process.exit(0); }
  const full = results.map((r) => r.markdown).join("\n\n---\n\n");
  const reportPath = join(OUT_DIR, "candidate-report.md");
  const diffPath = join(OUT_DIR, "candidate.diff");
  writeFileSync(reportPath, full + "\n");
  writeFileSync(diffPath, results.map((r) => r.diff).join("\n") + "\n");
  console.log(full);
  console.log(`\nArtifacts written:\n  ${reportPath}\n  ${diffPath}`);
}
