import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression test for the live 0.1.0 bug: typing "/init" inside the Ink TUI
// silently did nothing. Root cause — the handler opened its own readline
// interface, but Ink owns stdin in raw mode there, so rl.question() never
// resolves. Fix: the TUI path (interactive:false) must never touch readline;
// it requires the description inline and returns a clear usage error
// otherwise. This test proves the source contains that guard, not just that
// gates pass — the failure mode was silent, so absence-of-crash isn't proof.
describe("/init command — TUI raw-mode readline deadlock fix", () => {
	it("never constructs readline when context.interactive is false", () => {
		const src = readFileSync("src/commands/init/index.ts", "utf-8");
		expect(src).toContain("if (!context.interactive)");
		expect(src).toContain("Usage: /init <description>");
		// the readline branch must be reachable only after the interactive
		// check, i.e. createInterface appears strictly after the guard
		const guardIdx = src.indexOf("if (!context.interactive)");
		const rlIdx = src.indexOf("createInterface(");
		expect(guardIdx).toBeGreaterThan(-1);
		expect(rlIdx).toBeGreaterThan(guardIdx);
	});

	it("CommandContext threads interactive:false from the TUI and true from classic REPL", () => {
		const app = readFileSync("src/ui/App.tsx", "utf-8");
		const repl = readFileSync("src/repl.ts", "utf-8");
		expect(app).toContain("{ interactive: false }");
		expect(repl).toContain("{ interactive: true }");
	});
});
