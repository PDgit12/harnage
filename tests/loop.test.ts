import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { z } from "zod";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Tool } from "../src/Tool";
import { SafetyMonitor } from "../src/loop/safety";
import { CostTracker } from "../src/cost-tracker";
import { compactMessages, estimateTokens } from "../src/loop/context";
import { parseToolCalls, validateToolInput } from "../src/loop/tool-parser";
import { runSandboxed } from "../src/loop/sandbox";
import {
  saveLoop,
  loadLoop,
  listLoops,
  recoverLastLoop,
  deleteLoop,
} from "../src/loop/persistence";
import { LoopEngine } from "../src/loop/LoopEngine";
import type { LoopState, LoopPhase } from "../src/loop/types";
import type { Provider } from "../src/services/api/client";
import type { StreamEvent } from "../src/services/api/types";

const engineIds: string[] = [];
afterEach(async () => {
  await Promise.all(engineIds.map((id) => deleteLoop(id).catch(() => {})));
  engineIds.length = 0;
});

function createMockProvider(
  eventBatches: StreamEvent[][],
): Provider {
  let callCount = 0;
  return {
    async *stream() {
      const batch = eventBatches[callCount] ?? [];
      callCount++;
      for (const e of batch) yield e;
    },
  };
}

const mockTools: Tool[] = [
  {
    name: "echo",
    description: "Echo input back",
    inputSchema: z.object({ text: z.string() }),
    call: async (input: { text: string }) => ({ data: input.text }),
    isReadOnly: () => true,
  },
];

const sharedCwd = process.cwd();
const toolContext = {
  cwd: sharedCwd,
  env: process.env as Record<string, string | undefined>,
  permissions: { mode: "auto" as const, rules: [] },
  sandbox: "none" as const,
};

describe("LoopEngine", () => {
  it("basic flow: planning → executing → checking_goal → done", async () => {
    const provider = createMockProvider([
      [{ type: "tool_use", name: "echo", input: { text: "hi" }, id: "t1" }],
      [{ type: "text", content: "verified" }],
      [{ type: "text", content: "no, not done" }],
      [{ type: "tool_use", name: "echo", input: { text: "hi2" }, id: "t2" }],
      [{ type: "text", content: "verified again" }],
      [{ type: "text", content: "yes, goal satisfied" }],
    ]);

    const engine = new LoopEngine({ provider, tools: mockTools, toolContext });
    for await (const _ of engine.run("test goal")) {}

    const state = engine.getState();
    engineIds.push(state.id);

    expect(state.phase).toBe("done");
    expect(state.iteration).toBeGreaterThanOrEqual(2);
    expect(state.toolResults.length).toBeGreaterThanOrEqual(2);
  });
});

describe("SafetyMonitor - max iterations", () => {
  it("stops loop when maxIterations is exceeded with tool calls", async () => {
    const provider = createMockProvider(
      Array.from({ length: 20 }, () => [
        { type: "tool_use", name: "echo", input: { text: "looping" }, id: "1" },
        { type: "text", content: "running" },
      ]),
    );

    const engine = new LoopEngine({
      provider,
      tools: mockTools,
      toolContext,
      safetyConfig: { maxIterations: 3 },
    });

    let lastError = "";
    for await (const ev of engine.run("test")) {
      if (ev.type === "error") lastError = ev.content ?? "";
    }

    const state = engine.getState();
    engineIds.push(state.id);

    expect(state.phase).toBe("failed");
    expect(lastError).toContain("max iterations");
  });
});

describe("SafetyMonitor - cost ceiling", () => {
  it("stops loop when cost exceeds maxCostUsd", () => {
    const costTracker = new CostTracker();
    costTracker.recordUsage(0, 100);
    const monitor = new SafetyMonitor(costTracker, { maxCostUsd: 0.001 });

    const verdict = monitor.check(1);

    expect(verdict.shouldStop).toBe(true);
    expect(verdict.reason).toContain("max cost");
  });
});

describe("Context compaction", () => {
  it("compacts messages over threshold", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "A".repeat(5000),
    }));

    const config = { maxTokens: 32000, summaryTokens: 2000, compactionThreshold: 15000 };
    const result = compactMessages(messages, config);

    expect(result.messages.length).toBeLessThan(20);
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

describe("Context compaction", () => {
  it("maybeCompact compacts a long conversation in mainLoop", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "A".repeat(5000),
    }));

    const longState: LoopState = {
      id: `compact-${Date.now()}`,
      goal: "test compaction",
      phase: "checking_goal",
      iteration: 0,
      messages,
      toolResults: [],
      startedAt: Date.now(),
    };

    const provider = createMockProvider([
      [{ type: "text", content: "summary of earlier conversation" }],
      [{ type: "text", content: "yes, goal satisfied" }],
    ]);

    const engine = new LoopEngine({ provider, tools: mockTools, toolContext });
    for await (const _ of engine.resume(longState)) {}

    const state = engine.getState();
    engineIds.push(state.id);

    expect(state.messages.length).toBeLessThan(20);
    const summaryMsg = state.messages.find(
      (m) => m.role === "system" && m.content.startsWith("Summary of earlier conversation:"),
    );
    expect(summaryMsg).toBeDefined();
  });

  it("maybeCompact is a no-op under the threshold", async () => {
    const shortState: LoopState = {
      id: `compact-short-${Date.now()}`,
      goal: "test compaction",
      phase: "checking_goal",
      iteration: 0,
      messages: [{ role: "user", content: "small" }],
      toolResults: [],
      startedAt: Date.now(),
    };

    const provider = createMockProvider([
      [{ type: "text", content: "yes, goal satisfied" }],
    ]);

    const engine = new LoopEngine({ provider, tools: mockTools, toolContext });
    for await (const _ of engine.resume(shortState)) {}

    const state = engine.getState();
    engineIds.push(state.id);

    expect(
      state.messages.some(
        (m) => m.role === "system" && m.content.startsWith("Summary of earlier conversation:"),
      ),
    ).toBe(false);
    expect(state.messages.some((m) => m.content === "small")).toBe(true);
  });
});

describe("Token estimation", () => {
  it("estimateTokens returns ~4:1 ratio for ASCII", () => {
    const text = "Hello, world!";
    const estimated = estimateTokens(text);
    expect(estimated).toBe(Math.ceil(text.length / 4));
  });

  it("estimateTokens returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimateTokens handles non-ASCII", () => {
    const text = "日本語テスト";
    const estimated = estimateTokens(text);
    expect(estimated).toBe(Math.ceil(text.length / 4));
  });
});

describe("Tool parser", () => {
  it("parses JSON in <tool> tags", () => {
    const text = '<tool>{"name":"echo","input":{"text":"hello"}}</tool>';
    const result = parseToolCalls(text, mockTools);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("echo");
    expect(result[0].input).toEqual({ text: "hello" });
    expect(result[0].confidence).toBe(1);
  });

  it("returns empty for text without tool calls", () => {
    const result = parseToolCalls("Just some regular text", mockTools);
    expect(result).toHaveLength(0);
  });
});

describe("validateToolInput", () => {
  const schemaTool: Tool = {
    name: "schema_test",
    description: "Tool with required fields",
    inputSchema: z.object({ name: z.string(), count: z.number() }),
    call: async (_input: Record<string, unknown>) => ({ data: "ok" }),
    isReadOnly: () => true,
  };

  it("accepts valid input", () => {
    const result = validateToolInput(schemaTool, { name: "test", count: 42 });
    expect(result.valid).toBe(true);
  });

  it("rejects input with wrong types", () => {
    const result = validateToolInput(schemaTool, { name: "test", count: "not-a-number" });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects missing required fields", () => {
    const result = validateToolInput(schemaTool, { name: "test" });
    expect(result.valid).toBe(false);
  });
});

describe("Sandbox", () => {
  const canRun = typeof Bun !== "undefined";

  (canRun ? it : it.skip)("runSandboxed with ls returns stdout", async () => {
    const result = await runSandboxed("ls");
    expect(result.stdout).toBeTruthy();
    expect(result.exitCode).toBe(0);
    expect(result.sandboxViolation).toBeUndefined();
    expect(result.durationMs).toBeGreaterThan(0);
  });

  (canRun ? it : it.skip)("runSandboxed blocks dangerous commands", async () => {
    const result = await runSandboxed("rm -rf /tmp/test");
    expect(result.sandboxViolation).toMatch(/blocked/);
    expect(result.exitCode).toBe(1);
  });
});

describe("Persistence", () => {
  async function clearLoops(): Promise<void> {
    const dir = join(homedir(), ".agentforge", "loops");
    try {
      const files = await readdir(dir);
      await Promise.all(
        files.filter((f) => f.endsWith(".json")).map((f) => rm(join(dir, f), { force: true })),
      );
    } catch {
      /* dir may not exist yet */
    }
  }

  beforeEach(async () => {
    await clearLoops();
  });

  const testId = `test-loop-${Date.now()}`;
  const testState: LoopState = {
    id: testId,
    goal: "test persistence",
    phase: "executing",
    iteration: 3,
    messages: [],
    toolResults: [{ tool: "echo", input: "hi", output: "hi", success: true }],
    startedAt: Date.now() - 5000,
  };

  afterEach(async () => {
    await deleteLoop(testId).catch(() => {});
  });

  it("saves and loads a loop state", async () => {
    const savedId = await saveLoop(testState);
    expect(savedId).toBe(testId);
    const loaded = await loadLoop(testId);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(testId);
    expect(loaded!.goal).toBe("test persistence");
    expect(loaded!.phase).toBe("executing");
    expect(loaded!.iteration).toBe(3);
  });

  it("lists and recovers loops", async () => {
    const id2 = `test-loop-list-${Date.now()}`;
    const state2: LoopState = {
      id: id2,
      goal: "second loop",
      phase: "done",
      iteration: 1,
      messages: [],
      toolResults: [],
      startedAt: Date.now(),
    };

    await saveLoop(testState);
    await new Promise((r) => setTimeout(r, 10));
    await saveLoop(state2);

    const loops = await listLoops();
    const match = loops.find((l) => l.id === id2);
    expect(match).toBeDefined();
    expect(match!.goal).toBe("second loop");
    const recovered = await recoverLastLoop();
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(id2);
    await deleteLoop(id2).catch(() => {});
  });
});
