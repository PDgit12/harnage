// Editable-surface loader + writer for the self-evolve loop.
//
// The editable surface is the ONLY thing an external fixer may touch (see the
// `docstring` field in editable-surface.json). This module is the single gate:
// it loads the knob file, exposes typed knob values, validates a candidate edit
// against each knob's [min,max] bound, and writes an accepted candidate back.
// A candidate that touches anything other than a known knob's `value`, or that
// leaves a bound, is rejected here before it can reach the acceptance harness.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SURFACE_PATH = join(import.meta.dirname, "editable-surface.json");

export interface Knob {
  value: number;
  min: number;
  max: number;
  engineRef: string;
  effect: string;
}

export interface EditableSurface {
  version: number;
  docstring: string;
  knobs: Record<string, Knob>;
}

/** Concrete knob values only — what the engine actually reads. */
export type Knobs = Record<string, number>;

export function loadSurface(path = SURFACE_PATH): EditableSurface {
  return JSON.parse(readFileSync(path, "utf8")) as EditableSurface;
}

export function knobValues(surface: EditableSurface): Knobs {
  const out: Knobs = {};
  for (const [k, v] of Object.entries(surface.knobs)) out[k] = v.value;
  return out;
}

/** A candidate edit: a subset of knob names → proposed new values. */
export type Candidate = Record<string, number>;

export interface ValidationError {
  knob: string;
  reason: string;
}

/** Reject anything the surface forbids: unknown knob, non-integer, out of
 * bound, or a no-op (proposing the current value). Returns [] if the candidate
 * is in-bounds and non-trivial. */
export function validateCandidate(surface: EditableSurface, cand: Candidate): ValidationError[] {
  const errs: ValidationError[] = [];
  let anyChange = false;
  for (const [name, val] of Object.entries(cand)) {
    const knob = surface.knobs[name];
    if (!knob) { errs.push({ knob: name, reason: "unknown knob — not on the editable surface" }); continue; }
    if (!Number.isInteger(val)) { errs.push({ knob: name, reason: `value ${val} is not an integer` }); continue; }
    if (val < knob.min || val > knob.max) { errs.push({ knob: name, reason: `value ${val} outside bound [${knob.min},${knob.max}]` }); continue; }
    if (val !== knob.value) anyChange = true;
  }
  if (errs.length === 0 && !anyChange) errs.push({ knob: "*", reason: "no-op candidate — proposes no change to any knob" });
  return errs;
}

/** Apply a candidate on top of current knob values (does not write to disk). */
export function applyCandidate(surface: EditableSurface, cand: Candidate): Knobs {
  const next = knobValues(surface);
  for (const [name, val] of Object.entries(cand)) next[name] = val;
  return next;
}

/** Persist an accepted candidate back into editable-surface.json (only the
 * `value` fields change; version bumps). Used by the PR/diff step, never by the
 * fixer directly. Re-validates first — this is the last gate before an edit
 * touches disk, so an unbounded/float/unknown-knob candidate must never slip
 * through even if a caller skips validateCandidate. */
export function writeCandidate(surface: EditableSurface, cand: Candidate, path = SURFACE_PATH): void {
  const errs = validateCandidate(surface, cand);
  if (errs.length > 0) {
    throw new Error("refusing to write invalid candidate: " + errs.map((e) => `${e.knob}: ${e.reason}`).join("; "));
  }
  for (const [name, val] of Object.entries(cand)) surface.knobs[name].value = val;
  surface.version += 1;
  writeFileSync(path, JSON.stringify(surface, null, 2) + "\n");
}
