# harnage — Product / Feature Ideas (ranked)

> Thesis anchor: **a good harness makes any model perform at its ceiling.** Every idea
> below is graded on three axes: **Feasibility** (does the existing chassis already carry
> most of it?), **Small-model win** (does it move the 3B/8B tier, not just frontier?), and
> **Differentiation** (does Claude Code / Codex / OpenCode / Waku-Agent structurally NOT
> have it?). Grounded in: `docs/harness-excellence.md` (L1–L8 levers), `src/builder/{spec,
> llm,generate,assemble,models}`, generated-chassis templates in
> `src/builder/assemble/harness-templates.ts`, bench scripts (`bench-profile`,
> `bench-archetype`, `bench-editformat`, `golden-e2e`, `egress-check`), and the shipped
> profile/memory/eval/trace tiers.

Ranking rule: differentiation × small-model impact, gated by one-day feasibility. The top
band is what turns the thesis from a claim into a falsifiable, self-tuning artifact.

---

## 1. `<name> calibrate` — real per-model profile, measured not guessed

Today `profiles.ts` resolves a model to a static tier table (`resolveBase`) plus a fixed
`BAKED_OVERRIDES` map (PR #11); an **unknown** model gets only the conservative default and
never improves. `calibrate` runs the existing `bench-profile.ts` T1–T5 battery against the
*actually plugged-in* model on first run, measures pass/latency per loop-mode and edit-format,
and writes measured overrides to `~/.<name>/profile.json` that `resolveProfile` merges on top
of the baked table. This is the concrete form of harness-excellence L8 ("the harness
reconfigures itself around the brain plugged in") — but data-driven instead of a hand-authored
guess. **Feasibility: high** — the battery already exists in `scripts/bench-profile.ts`; the
work is porting it into a generated command template and adding a runtime-override read path
that `resolveProfile` already has the shape for. **Small-model win: maximal** — the whole
value of profiles is largest at the small tier, and self-calibration is exactly where a
mis-tiered local model recovers its lost passes. **Differentiation: total** — no shipping
harness (Claude Code/Codex/OpenCode/Waku) does per-model scaffold *measurement*; they assume a
frontier model. This is the moat, executable in a day. **Rank #1.**

## 2. `<name> prove` — head-to-head vs raw model, on the user's box

The README makes a "head-to-head claim" (harness vs raw Ollama chat) and
`docs/harness-excellence.md §5` names it as the measurable definition of "better than most
harnesses," but nothing ships that lets a *user* reproduce it. `prove` runs the T1–T5 battery
twice — once through the full engine, once through raw provider chat with no scaffold — and
prints a side-by-side pass/latency delta the user can screenshot. Turns the entire pitch into a
falsifiable local artifact (the bench proof "3b 1/5→4/5" becomes something the buyer runs
themselves). **Feasibility: high** — battery + provider client already exist; it is a command
template plus a bare-chat code path. **Small-model win: high** — the delta is by construction
biggest on the small tier, which is the sales moment. **Differentiation: high** — this is P4
positioning made self-serve; competitors have no incentive to ship a "your model is better with
us" proof, and Waku has no local-model story to prove. **Rank #2.**

## 3. Builder-generated domain pipeline for the small tier

`harness-excellence.md §3` and implementation-order item 6 spell out the deepest lever: the
BUILDER already knows the domain from the spec/plan, so it can emit **fixed pipeline stages**
baked into the engine for `loop: "pipeline"` (small tier) — a code-census harness ships
`glob→count-by-ext→read-key-files→report`, and the 3B just fills slots instead of free-looping.
"That's how a 3B beats a naive 70B loop on its niche." Likely only partially shipped (profiles
name the mode; the PLAN-stage emission of concrete stages is the missing half). **Feasibility:
medium** — touches `src/builder/llm/plan.ts` (emit stage list) + `assemble` templates (consume
it); more than a day for the full version, but a scoped single-archetype slice fits. **Small-model
win: maximal** — this is the single largest documented small-model lever after constrained
decode. **Differentiation: total** — build-time domain pipelines are unique to a *builder*;
no runtime-only agent can do this. **Rank #3** (below 1–2 only on one-day feasibility).

## 4. Runtime tool-subset cap (enforce `profile.maxTools` by goal relevance)

BFCL finding in L2: small-model tool-call accuracy *collapses* past 5–8 exposed tools. Profiles
already carry `maxTools`, but if the engine exposes all 9 generated tools every turn regardless,
the lever is inert. This idea makes DISPATCH rank tools by trigger/keyword relevance to the goal
and expose only the top `maxTools` for small/mid tiers. **Feasibility: medium** — the skills
system already has trigger-matching to borrow; wiring is in the engine template. **Small-model
win: high** — cited as a 2/10→10/10 swing on a SWE subset purely from shrinking the tool space.
**Differentiation: high** — dynamic per-tier tool-space shrink is a builder/profile feature the
incumbents (fixed frontier tool set) don't have. **Rank #4.**

## 5. Loop-transition hooks in the generated harness

Named explicitly as a Claude Code parity gap (api-build-brain memory: "hooks at loop
transitions"). The `LoopEngine` state machine already has clean
planning→executing→verifying→checking_goal→adapting transitions; expose settings-driven shell
hooks firing at each. This is *also* the sovereign win: policy-as-file (P3, win #1) — a
regulated team gates every tool exec or verify through an audited shell hook. **Feasibility:
medium** — states exist; add a hook-dispatch call at each transition + a settings schema.
**Small-model win: low** (tier-neutral infrastructure). **Differentiation: high** — parity with
Claude Code's headline feature, *plus* the sovereign policy angle no cloud tool can offer.
**Rank #5.**

## 6. Constrained-grammar edit format (extend L1 to file edits)

Constrained decoding (L1) is shipped for the *dispatch* decision but edits still rely on the
model emitting a well-formed search/replace block or whole-file body — the class of failure
`bench-editformat.ts` exists to measure. Grammar-force the edit action's structure so a small
model physically cannot emit a malformed diff, the same way it can't emit a malformed tool call
today. **Feasibility: medium** — reuses the Ollama `format`/GBNF path already in the engine;
schema design is the work. **Small-model win: high** — edit format alone moves pass rates
10–20 points per Aider, and malformed edits are a top small-model failure. **Differentiation:
high** — constrained *edit* decoding is novel even vs Aider (which picks a format but doesn't
grammar-force it). **Rank #6.**

## 7. Auto-bake edit format from `bench-editformat` at build time

`bench-editformat.ts` measures the best edit format per model, and profiles carry `editFormat`,
but selection is currently by hand-authored override (qwen-coder→search-replace, etc.). Close
the loop: at `init`, if the chosen local model isn't in the curated table, run a one-shot
edit-format probe and bake the winner into `plan.modelProfileOverrides`. **Feasibility: high** —
both halves exist (the bench script + the override-baking path from PR #11); this just connects
them. **Small-model win: high** — edit format is a per-model, mostly-small-tier lever.
**Differentiation: medium** — an automation of the existing curation, strong but incremental.
**Rank #7.**

## 8. `<name> doctor` in every generated harness

The builder repo ships a `doctor` command; generated harnesses don't. A ported doctor checks
model reachability, RAM-vs-`profile.contextTokens` fit, permission-rule sanity, memory-db
presence, and egress — directly attacking MVP gap #3 (stranger-test / first-run failures where a
user points the harness at an unreachable model or an oversized profile). **Feasibility: high** —
port an existing command into a generated template. **Small-model win: medium** — catches the
"wrong tier for this RAM" misconfig that silently tanks small-model runs. **Differentiation:
medium** — Claude Code has `/doctor`; the sovereign/local-model checks (RAM fit, egress, local
model reachability) are the differentiated part. **Rank #8.**

## 9. Sub-agent topology baked from the domain plan

Generated harnesses have `AgentTool` and the chassis supports sub-agents, but the *topology*
(which scoped agents, locked to which domains) is generic. The builder already derives the
domain from the spec — it could emit bespoke scoped sub-agents (mirroring this repo's
`.claude/agents/{src,tests,providers}.md`) baked from the plan, e.g. a diff-reviewer harness
ships `security`, `style`, `test-risk` agents. Named as a parity gap in the api-build-brain
memory. **Feasibility: medium** — AgentTool + plan structure exist; the work is a generation
stage emitting agent definitions. **Small-model win: low** (topology helps frontier orchestration
more than a lone 3B). **Differentiation: medium** — Claude Code has subagents; *builder-emitted,
domain-scoped* topology is the twist. **Rank #9.**

## 10. Offline / air-gapped install bundle (`init --offline`)

P3 sovereign win (#1 + #4): `egress-check.ts` already proves zero runtime egress, but the
*install* still hits the network (`bun install`). `--offline` vendors deps into the generated
project so a regulated team can `bun install` on an air-gapped box. **Feasibility: medium** —
bun offline cache / vendored `node_modules` tarball; more packaging than code. **Small-model
win: low** (orthogonal to model tier). **Differentiation: high** — a structural win the cloud
incumbents *cannot* match (they're legally barred from regulated code), but it serves the
beachhead buyer rather than the daily-driver prosumer, so it ranks below the reliability levers.
**Rank #10.**

---

### Cut / deferred (noted, not specced)

- **Repeat-penalty + per-phase temperature wiring (L7):** likely small and possibly already
  partial in `streamProvider` options — verify before treating as new work; too small to headline.
- **Web dashboard / voice / Telegram gateway (Waku parity):** deliberately out — harnage is
  terminal-first by design (memory-tier note). Not a pillar.
- **Golden-archetype CI expansion (P2):** valuable hardening but low novelty; belongs to the
  build/qa workers' lane, not a product idea.
