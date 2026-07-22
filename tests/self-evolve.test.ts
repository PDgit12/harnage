import { describe, it, expect } from "vitest";
import { mineWeaknesses, parseAudit } from "../scripts/self-evolve/mine-weaknesses.ts";
import {
  loadSurface, knobValues, applyCandidate, validateCandidate, writeCandidate,
} from "../scripts/self-evolve/editable-surface.ts";
import { runAcceptance } from "../scripts/self-evolve/acceptance.ts";
import { propose, runEvolve } from "../scripts/self-evolve/evolve.ts";
import { mineFromFile } from "../scripts/self-evolve/mine-weaknesses.ts";
import { join } from "node:path";

const surface = loadSurface();
const baseline = knobValues(surface);

describe("weakness mining", () => {
  it("clusters repeated same-signature failures and drops one-off flakes", () => {
    const audit = [
      { kind: "eval", name: "judge_quality", pass: false, detail: "score 2/5 — missing earlier context here" },
      { kind: "eval", name: "judge_quality", pass: false, detail: "score 1/5 — missing earlier context there" },
      { kind: "eval", name: "prose_answer", pass: false, detail: "one-off blob" },
      { kind: "eval", name: "non_empty_answer", pass: true, detail: "" },
    ];
    const clusters = mineWeaknesses(audit as any);
    // judge_quality (x2) survives; prose_answer (x1) is a dropped one-off; passing evals ignored.
    expect(clusters.map((c) => c.evalName)).toEqual(["judge_quality"]);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].suspectedKnob).toBe("memory.recallLimit");
  });

  it("parseAudit skips malformed lines without throwing", () => {
    const recs = parseAudit('{"kind":"eval"}\nnot json\n\n{"kind":"run_end"}');
    expect(recs).toHaveLength(2);
  });
});

describe("editable-surface guard", () => {
  it("rejects unknown knob, out-of-bound, non-integer, and no-op", () => {
    expect(validateCandidate(surface, { "does.not.exist": 5 })[0].reason).toMatch(/unknown/);
    expect(validateCandidate(surface, { "memory.recallLimit": 999 })[0].reason).toMatch(/outside bound/);
    expect(validateCandidate(surface, { "memory.recallLimit": 8.5 })[0].reason).toMatch(/not an integer/);
    expect(validateCandidate(surface, { "memory.recallLimit": 8 })[0].reason).toMatch(/no-op/);
  });
  it("accepts an in-bounds real change", () => {
    expect(validateCandidate(surface, { "memory.recallLimit": 10 })).toHaveLength(0);
  });
  it("writeCandidate refuses an out-of-bound / float / unknown value (last gate before disk)", () => {
    const s = loadSurface();
    expect(() => writeCandidate(s, { "memory.recallLimit": 99999 }, "/dev/null")).toThrow(/invalid candidate/);
    expect(() => writeCandidate(s, { "memory.recallLimit": 7.5 }, "/dev/null")).toThrow(/invalid candidate/);
    expect(() => writeCandidate(s, { "does.not.exist": 5 }, "/dev/null")).toThrow(/invalid candidate/);
  });
});

describe("acceptance rule (per-task, not aggregate)", () => {
  it("accepts a candidate that strictly improves >=1 task with zero regressions", () => {
    const cand = applyCandidate(surface, { "memory.recallLimit": 12 });
    const rep = runAcceptance(baseline, cand);
    expect(rep.accepted).toBe(true);
    expect(rep.regressed).toHaveLength(0);
    expect(rep.improved.length).toBeGreaterThan(0);
  });

  it("REJECTS a candidate that regresses a task even when the aggregate total is not worse (aggregate-hides-regression guard)", () => {
    // recallLimit=15 improves A2,A4 (info loss) but SURFACES the poison at rank
    // 15 in C1,C3 (leak). Net aggregate is flat, so an aggregate-only gate would
    // wave it through; the per-task gate must catch the two regressions.
    const cand = applyCandidate(surface, { "memory.recallLimit": 15 });
    const rep = runAcceptance(baseline, cand);
    expect(rep.basePass).toBe(rep.candPass); // aggregate looks neutral...
    expect(rep.regressed).toContain("C1-inline-directive"); // ...but tasks broke
    expect(rep.regressed).toContain("C3-memory-poison");
    expect(rep.accepted).toBe(false);
  });

  it("REJECTS a do-nothing candidate (no strict improvement) as a false pass", () => {
    const rep = runAcceptance(baseline, baseline);
    expect(rep.improved).toHaveLength(0);
    expect(rep.accepted).toBe(false);
    expect(rep.reason).toMatch(/no task strictly improved/);
  });
});

describe("propose (held-in only) + end-to-end evolve", () => {
  it("proposes only from held-in signal and never a held-in regression", () => {
    const clusters = mineFromFile(join(import.meta.dirname, "../scripts/self-evolve/fixtures/audit.jsonl"));
    const c = clusters.find((x) => x.suspectedKnob === "memory.recallLimit")!;
    const cand = propose(surface, c)!;
    expect(cand["memory.recallLimit"]).toBeGreaterThan(8);
    // smallest change that lifts held-in — recallLimit 10 (held-in A2 rank 10).
    expect(cand["memory.recallLimit"]).toBe(10);
  });

  it("runEvolve yields an accepted candidate with a real per-task report", () => {
    const results = runEvolve();
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.report.accepted).toBe(true);
    expect(r.report.rows).toHaveLength(13);
    expect(r.diff).toMatch(/editable-surface\.json/);
  });
});
