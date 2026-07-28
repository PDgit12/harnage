# Third-party sources

harnage's generated harnesses include content adapted from the open-source agent
harnesses listed below. No third-party source is vendored or executed — the material
adapted is prompt and procedure text, rewritten for this harness's format, tool names
and model tiers. Copyright remains with the original authors.

## OpenAI Codex — Apache License 2.0

<https://github.com/openai/codex> · Copyright 2025 OpenAI

Adapted, with modifications:

- the code-review rubric (`codex-rs/prompts/templates/review/rubric.md`) → the
  `review-code` bundled skill
- the AGENTS.md scoping and precedence rules (model prompt, "AGENTS.md spec") → the
  project-instruction loader in the generated harness (`src/instructions.ts`)
- the sandbox / approval-policy prompt shape
  (`codex-rs/prompts/templates/permissions/**`) → `permissionsPromptBlock()` in the
  generated harness (`src/permissions.ts`)
- the plan-quality rubric (model prompt, "Planning") → the `plan-before-acting`
  bundled skill

## OpenHarness — MIT License

<https://github.com/HKUDS/OpenHarness> · Copyright 2025 OpenHarness Contributors

Adapted, with modifications: the bundled skills `plan`, `debug`, `diagnose`, `review`,
`simplify`, `test` and `commit` → the `plan-before-acting`, `investigate-failure`,
`review-code`, `simplify`, `test-changes` and `commit-changes` bundled skills.

## Reference only

The following were studied while designing the generated harness. No content was copied.

- opencode — MIT — <https://github.com/sst/opencode>
- ruflo — MIT — <https://github.com/ruvnet/ruflo>
