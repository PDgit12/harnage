# Changelog

## 0.6.0

Six defects shipped in 0.5.0 made a working harness look unreliable. All are
fixed, each verified against the artifact that exposed it rather than in theory.

### Generated harnesses were broken in ways that compiled

- **No generated harness could reach a remote provider.** The engine appended
  `/v1/chat/completions` to a base URL that already ended in `/v1`, so every
  OpenAI-compatible endpoint 404'd on the first call. Only the Ollama path
  worked, which is why the build evals stayed green.
- **`bash(*)` refused shell redirects.** An explicit allow-everything grant
  denied `echo HELLO > file.txt` and reported `needs an allow rule … bash(*)` —
  add the rule you already have. It silently failed every write-via-shell task
  and looked exactly like a small model refusing to act. The guard now applies
  only to scoped grants, where it still blocks `git status; rm -rf /`.
- **The repair loop could introduce undeclared imports.** It wrote model patches
  to disk with no validation, "fixing" `node-fetch` by inventing `node:fetch`
  and burning both attempts. Fetch shims are now stripped deterministically
  before any model call, and patches importing undeclared packages are rejected.
- **`src/tools.ts` could import modules that were never written.** The registry
  is now built from what is actually on disk.
- **Malformed tool names killed runs.** `GrepTool{"pattern":"x"}` — name and
  args concatenated — was dropped, then echoed back to the provider, which
  rejected the next request entirely. Names are normalised, unresolved calls are
  never echoed, and a tool-format error retries instead of aborting.
- **Generated `catch (e) { e.message }` failed to compile.** It is what every
  model writes; `useUnknownInCatchVariables` is now off in the generated
  tsconfig.

### The model is measured, not guessed

- `characterizeModel()` probes the chosen model before generating anything for
  it — holds a JSON shape, copies an exact path, emits a tool call instead of
  describing one — and the measured scaffold overrides the size-tier guess. This
  is what makes the builder work on models nobody has tested: the harness asks
  the endpoint instead of consulting a table. Fail-safe; an unreachable model
  changes nothing.
- Build-time **acceptance**: the finished harness is executed against an
  LLM-planned domain battery on the model it was built for, and ships its score
  as `ACCEPTANCE.md` + `acceptance.json`. Warns, never blocks.
- Size bands are finer (a "mid" tier spanning 4B–12B is one setting for a 3.5×
  capability range), and `:latest` tags now resolve to real parameter counts.

### Evals

- 12 → **89 tasks** across 8 categories, with an **LLM judge** for open-ended
  tasks that is calibrated against a labelled set and refused below 75%
  agreement.
- New **build-eval**: 10 domain prompts asserted to build, compile, import
  nothing undeclared, and emit a registry that resolves.
- Provider errors are excluded from scores. A dead Ollama produced a fake 1/20
  that read like a regression; runs now abort rather than publish a number.

### Models

- Catalog is no longer qwen-only where it counts: 23 entries across 8 families,
  and every size band offers a real alternative. `scripts/model-matrix.ts`
  characterizes every installed model in one pass.

### Measured

qwen2.5:3b on the 20-task code suite: **14/20 → 18/20** (easy 6/6, hard 5/5).
llama3:latest: 15 of 18 before the run was interrupted. Recursive filesystem
grounding was worth +3 on its own; an A/B showed native tool-calling scores
7/20 against constrained-json's 14/20, so the small tier keeps the grammar the
harness controls.

## 0.5.0

Eval flywheel, autonomy audit, FSL license, runtime-connection fix, per-domain
theming.
