# CLI Output Improvements — AgentForge REPL & Markdown Renderer

**Date:** 2026-07-12  
**Domain tags:** CLI, REPL, markdown, formatting, UX

## Changes

### `src/utils/md.ts` — Markdown renderer rewrite
- **Problem:** Multi-line code blocks didn't render because the regex `[^\`]+` doesn't match newlines. Fenced code blocks spanning multiple lines produced broken/incomplete output.
- **Fix:** Replaced naive regex approach with a state-machine that tracks `inCodeBlock` / `inInlineCode` flags and uses a `formatBlock` helper for fenced code blocks.
- **Added rendering for:**
  - ATX headings (`#` through `######`) with bold + dim formatting
  - Unordered lists (`-`, `*`, `+`) with `•` bullets and indentation
  - Blockquotes (`>`) with dim `│` prefix
  - Horizontal rules (`---`, `***`, `___`) with a dim line
- **Inline code:** Changed from `inverse` to `cyan` styling for better readability.
- **Edge case:** Backtick at end of bold token (`**something` `text**`) no longer breaks.

### `src/repl.ts` — REPL interface rewrite
- **Banner:** ASCII art "AgentForge" logo with tagline "Your goal-driven AI coding agent" below.
- **Labels:** `You:` tag (cyan) and `Agent:` tag (green) replace plain `user`/`  agent` prefixes.
- **Tool calls:** Inline previews formatted as `↳ ToolName \`arg preview…\`` — shows what tool was called and its first argument.
- **Cost line:** Uses box-drawing characters (`┌───┐`, `│`, `└───┘`) for a bordered cost display with dollar amount and tool call count.
- **Status bar:** Shows model name, total tokens used (input + output), number of tool calls in the current exchange.
- **Separator:** Dimmed `───` line between exchanges instead of plain `\n`.

## Key design decisions
- State-machine parser in `md.ts` over regex-only approach — necessary because regex alone can't correctly handle nested/overlapping patterns across newlines.
- Color choices: cyan for inline code (pops against default terminal background), green for agent label (authoritative), yellow for ASCII art (branding). All use ANSI escape codes via helper functions — no external color library dependency.
- REPL header/footer separator dimmed to visually group exchanges without adding visual noise.
