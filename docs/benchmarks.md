# Benchmarks

North-star #3: prove a harnage-generated harness outperforms the same local
model with no harness. Three scripts, all offline (local Ollama only, no API
keys):

| Script | What it proves |
|---|---|
| `scripts/bench-profile.ts <model>` | Generated harness clears the T1-T5 task/release bar for its tier. |
| `scripts/bench-editformat.ts <model>` | Which edit format (search-replace vs whole-file) a model handles reliably. |
| `scripts/bench-harness.ts <model>` | **Harness vs no-harness**: same model, same tasks, harness wins because the baseline structurally can't. |

## bench-harness.ts

```
bun scripts/bench-harness.ts --dry-run          # validates the battery, no model, exit 0
bun scripts/bench-harness.ts qwen2.5:3b         # runs it for real against local Ollama
bun scripts/bench-harness.ts qwen3:8b http://localhost:11434
```

### The two arms

- **harness** — a real generated harness (offline chassis, `buildHarness()`)
  driving its `LoopEngine` with tools, the 3-tier memory store, and session
  persistence, on the given Ollama model.
- **control** — the *same* Ollama model via a bare `/api/chat` call: no
  tools, no filesystem access, no memory tier, no session file. This is not
  a strawman — it's what "just use the model" means without harnage. If the
  control ever passes a task, that task isn't testing anything a harness
  provides and should be dropped or hardened.

### Task battery (5 categories)

1. **File ops (T1)** — create a file with exact content. Harness uses
   `file_write`; control has no filesystem tool, so it can only pass by
   accident (it can't — `existsSync` checks the real fixture dir).
2. **Search (T2)** — read a real file and report what it exports. Harness
   reads the actual file; control has never seen it and can only guess.
3. **Multi-step goal (T3)** — find the largest of several files and quote
   it. Requires listing + comparing + reading — a real tool loop.
4. **Memory recall (T4)** — a fact is seeded (via the harness's
   `MemoryStore`, keyed to `~/.<harness-name>/memory.db`), then a *fresh*
   engine instance (simulating a new session) is asked to recall it. The
   deterministic keyword-overlap gate (`MemoryStore.recall`) injects the
   fact into the system prompt before the model answers. Control runs two
   independent stateless `/api/chat` calls — nothing persists between them,
   so it can only pass by the model coincidentally guessing the answer.
5. **Resume-after-kill (T5)** — after one clean run confirms
   `session.json` is marked `done: true`, the script writes a crash-shaped
   state directly (`done: false`, partial transcript, in-flight goal) to
   simulate a kill mid-task, then reloads it via `loadSession()` and checks
   the state round-trips. Control never writes a session file at all, so a
   killed control run loses the entire turn — there's nothing to resume.

Every task builds one shared generated harness up front and cleans
`~/.<harness-name>` before and after, so re-runs don't leak stale memory or
session state across tasks or invocations.

### Reading the report

The script prints a pass/fail + timing line per task per arm to stdout and
writes a scored markdown report to `.bench-reports/bench-harness-<model>-
<timestamp>.md` with a table (`harness wins` / `both pass` / `both fail` /
`control wins`) plus per-task detail. `control wins` on any row is a signal
the task needs to be re-examined — it means the harness isn't adding
anything measurable there.

### --dry-run

Runs the offline chassis build (no model call — `buildHarness()` without a
`provider` uses deterministic offline generation) and checks the generated
`tools.ts`, `engine.ts`, `profiles.ts`, `memory.ts`, `session.ts` exist,
then prints the task plan. This is what CI / this benchmark's authorship
can verify without a model on the box; the scored run itself needs a human
with Ollama running locally.

## Why no cloud models here

Everything above must run without API keys — the whole point is showing a
*local* model plus a harness can do things a bare local model can't. If you
want to compare against a cloud frontier model, that's a different
benchmark (and a paid one) — not this suite.
