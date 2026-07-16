# Top-2 buildable one-day specs

Both are **command-shaped** (fit cc-build's lane: `src/builder/llm/**` + commands enrichment).
Neither duplicates shipped work — verified against the profile/bench code before writing.

---

## SPEC 1 — `<name> calibrate` (measured per-model profile)  ★ TOP, sent to cc-build

### Problem
`profiles.ts` in every generated harness resolves a model to a static tier (`resolveBase`) plus
a fixed `BAKED_OVERRIDES` map (PR #11). An **unknown** local model (the long tail `inferFamily`
covers only by heuristic) gets the conservative default and *never* learns. The thesis — "the
harness reconfigures itself around the brain plugged in" (harness-excellence L8) — is currently
a build-time *guess*, not a runtime *measurement*. Result: a mislabeled small model runs in the
wrong loop-mode / edit-format and silently loses passes it could win.

### Approach
Add a `calibrate` command to the generated harness that runs the existing `bench-profile.ts`
T1–T5 battery against the live model, for each candidate `loop` mode (`plan-act`, `pipeline`)
and `editFormat` (`search-replace`, `whole-file`), records pass-count + median latency, picks
the winning combination, and writes it to `~/.<name>/profile.json`. Extend `resolveProfile` to
read that file and merge it on top of `BAKED_OVERRIDES` (precedence: measured > baked > base).
Fail-safe: no file / parse error → current behavior unchanged. Print a before/after profile diff
so the user sees what changed.

### Files to touch (cc-build lane)
- `src/builder/generate/command-generator.ts` — add a `calibrate` command template (mirror the
  existing `model`/`cost` static-command entries; ~50–80 lines emitting the battery + writer).
- `src/builder/assemble/harness-templates.ts` — in the emitted `profiles.ts` template, extend
  `resolveProfile` with a `readCalibration()` merge step + `CALIBRATED` precedence over
  `BAKED_OVERRIDES`. **Watch the template-escaping gotcha** (reliability-fixes memory): any
  regex/backslash inside the template literal must be doubled or Biome `noUselessEscapeInString`
  flags it in the emitted file.
- `src/builder/llm/generate.ts` — register `calibrate` in the generated command list so the
  REPL/TUI slash menu and CLI both expose it.
- `tests/` — new `tests/calibrate.test.ts`: (a) `resolveProfile` merges a fake
  `profile.json` over the baked override; (b) missing/corrupt file falls back cleanly; (c)
  generated harness with `calibrate` still typechecks (extend the existing generated-harness
  compile test rather than adding a new build).

### Verify
```bash
bun run typecheck && bun run test && bun run lint
```
Done when: typecheck clean, `tests/calibrate.test.ts` green (merge + fallback + emitted-command
compile), lint clean. Manual confirm (not in CI): build a harness, `<name> calibrate` writes
`~/.<name>/profile.json` and a second run reflects the measured loop-mode.

### Scope guard
One command + one merge path + tests. Do **not** touch the engine loop itself, memory, or eval.
The battery is reused, not rewritten.

---

## SPEC 2 — `<name> prove` (head-to-head harness vs raw model)

### Problem
README makes a "head-to-head claim" and `harness-excellence.md §5` defines "better than most
harnesses" as the harness-vs-raw-chat delta on T1–T5 — but nothing ships that lets a *user*
reproduce it on their own box/model. The core sales proof ("3B 1/5→4/5 purely from harness")
is currently a number in a doc, not a command the buyer can run.

### Approach
Add a `prove` command that runs the T1–T5 battery twice against the same model: once through the
full generated engine, once through a bare provider-chat path (no scaffold — direct
`streamProvider` chat, no dispatch/verify/profile). Print a side-by-side table: task, raw
pass/latency, harnessed pass/latency, delta. Reuse the T1–T5 task definitions and the existing
provider client; the only new code is the bare-chat runner and the comparison table formatter.

### Files to touch (cc-build lane)
- `src/builder/generate/command-generator.ts` — add a `prove` command template (battery runner
  + bare-chat path + table formatter).
- `src/builder/assemble/harness-templates.ts` — if the T1–T5 task list isn't already a reusable
  symbol in the emitted engine, hoist it to a small shared template const so both `calibrate` and
  `prove` consume one definition (avoids drift). Same escaping caution.
- `src/builder/llm/generate.ts` — register `prove` in the generated command list.
- `tests/prove.test.ts` — assert the comparison table renders both columns from a stubbed
  provider (raw fails T-x, harnessed passes) and that the emitted command compiles.

### Verify
```bash
bun run typecheck && bun run test && bun run lint
```
Done when: typecheck clean, `tests/prove.test.ts` green, lint clean. Manual confirm: `<name>
prove` on a small local model prints a delta table with the harnessed column ahead.

### Scope guard
Read-only proof command — no engine/profile mutation. Shares the T1–T5 task const with Spec 1;
if both land, factor that const once. No new deps.
