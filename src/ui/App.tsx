import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildHarness } from "../builder";
import type { LocalCommandHandler } from "../commands";
import { COMMANDS, findCommand } from "../commands";
import { conversation } from "../conv";
import { costTracker } from "../cost-tracker";
import type { LoopEngine } from "../loop/LoopEngine";
import {
	createBuildProvider,
	type ProviderConfig,
} from "../services/api/client";
import { resolveProvider } from "../services/api/resolve";
import {
	ACCENT,
	BORDER_STYLE,
	GLYPHS,
	SPINNER_FRAMES,
	TAGLINE,
	VERSION,
	wordmarkChars,
} from "./brand";
import { isBuildIntent } from "./build-intent";
import { Markdown } from "./markdown";

export type HistoryItem =
	| { kind: "user"; text: string }
	| { kind: "agent"; text: string }
	| { kind: "tool"; label: string }
	| { kind: "error"; text: string }
	| { kind: "info"; text: string };

interface AppProps {
	config: ProviderConfig;
	engine: LoopEngine;
	branch?: string;
	resumeState?: import("../loop/types").LoopState;
	/** Unfinished goal from last session to mention when started without --resume. */
	unfinishedHint?: string;
	/** --resume was passed but no interrupted loop was found. */
	noResumeFound?: boolean;
}

function Banner({
	config,
	branch,
}: {
	config: ProviderConfig;
	branch?: string;
}) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box
				borderStyle={BORDER_STYLE}
				borderColor={ACCENT}
				paddingLeft={1}
				paddingRight={1}
			>
				<Text>
					<Text color={ACCENT}>{`${GLYPHS.gear} `}</Text>
					{wordmarkChars().map(({ ch, color }, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static wordmark, never reorders
						<Text key={i} color={color} bold>
							{ch}
						</Text>
					))}
					<Text dimColor>{`  ${VERSION}`}</Text>
				</Text>
			</Box>
			<Box paddingLeft={1} justifyContent="space-between">
				<Text dimColor>{TAGLINE}</Text>
				<Text>
					<Text backgroundColor={ACCENT} color="black" bold>
						{` ${config.type} `}
					</Text>
					<Text
						dimColor
					>{` ${config.model}${branch ? `  ${GLYPHS.bullet}  ${branch}` : ""}`}</Text>
				</Text>
			</Box>
			<Box paddingLeft={1}>
				<Text dimColor>
					<Text color={ACCENT}>/init</Text> build a harness {GLYPHS.bullet}{" "}
					<Text color={ACCENT}>/help</Text> all commands {GLYPHS.bullet} or type
					a goal to run the agent
				</Text>
			</Box>
		</Box>
	);
}

// No trailing ellipsis — the busy line renders `Running ${activeTool}…` and
// appends its own, so a label ending in "…" would double it ("files……").
const BUILD_STEP_LABELS: Record<string, string> = {
	analyzing: "Analyzing your request",
	planning: "Generating build plan",
	building: "Building harness files",
	verifying: "Running verification",
	repairing: "Repairing build errors",
};

function toolLabel(name: string | undefined, input: unknown): string {
	const o = (input ?? {}) as Record<string, unknown>;
	const preview =
		typeof o.command === "string"
			? o.command
			: typeof o.path === "string"
				? o.path
				: typeof o.pattern === "string"
					? o.pattern
					: "";
	const n = name ?? "Tool";
	return preview ? `${n} ${GLYPHS.bullet} ${preview.slice(0, 80)}` : n;
}

export function App({
	config,
	engine,
	branch,
	resumeState,
	unfinishedHint,
	noResumeFound,
}: AppProps) {
	const { exit } = useApp();
	const [history, setHistory] = useState<HistoryItem[]>([
		...(unfinishedHint
			? [
					{
						kind: "info" as const,
						text: `${GLYPHS.pause} unfinished task from last session: "${unfinishedHint.slice(0, 100)}" — restart with --resume to continue`,
					},
				]
			: []),
		...(noResumeFound
			? [{ kind: "info" as const, text: "No interrupted loop to resume." }]
			: []),
	]);
	const [input, setInput] = useState("");
	const [streamingText, setStreamingText] = useState("");
	const [activeTool, setActiveTool] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [cost, setCost] = useState(0);
	const [spinnerFrame, setSpinnerFrame] = useState(0);
	const busyRef = useRef(false);
	// Interactive build interview: the builder's `ask(question, default)`
	// callback can't use readline in Ink's raw mode, so it bridges through
	// component state — `askInteractive` shows the question and returns a
	// promise the next Enter resolves. (This is the onboarding flow.)
	const [pendingQuestion, setPendingQuestion] = useState<{
		q: string;
		def: string;
	} | null>(null);
	const askResolveRef = useRef<((answer: string) => void) | null>(null);
	const engineMode = busy ? "working" : "ready";

	const askInteractive = useCallback((q: string, def: string) => {
		return new Promise<string>((resolve) => {
			askResolveRef.current = resolve;
			setPendingQuestion({ q, def });
		});
	}, []);

	useEffect(() => {
		if (!busy) return;
		const id = setInterval(
			() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length),
			80,
		);
		return () => clearInterval(id);
	}, [busy]);

	const push = useCallback((item: HistoryItem) => {
		setHistory((h) => [...h, item]);
	}, []);

	useInput((char, key) => {
		// Escape: quit when idle only (mid-run, it'd be too easy to lose an
		// in-flight goal by accident). Ctrl-C: quit unconditionally, matching
		// the classic REPL's SIGINT behavior — busy or not, it's the user's
		// unambiguous "get me out" signal.
		if (key.escape && !busyRef.current) exit();
		if (key.ctrl && char === "c") exit();
	});

	const consumeStream = useCallback(
		async (
			stream: AsyncGenerator<import("../services/api/types").StreamEvent>,
		) => {
			busyRef.current = true;
			setBusy(true);

			let full = "";
			let current = "";
			try {
				for await (const event of stream) {
					if (event.type === "text") {
						current += event.content ?? "";
						full += event.content ?? "";
						setStreamingText(current);
					} else if (event.type === "tool_use") {
						if (current.trim()) {
							push({ kind: "agent", text: current });
							current = "";
							setStreamingText("");
						}
						const label = toolLabel(event.name, event.input);
						setActiveTool(label);
						push({ kind: "tool", label });
					} else if (event.type === "tool_result") {
						setActiveTool(null);
					} else if (event.type === "error") {
						push({ kind: "error", text: event.content ?? "Error" });
					}
				}
			} catch (err) {
				push({
					kind: "error",
					text: err instanceof Error ? err.message : String(err),
				});
			}

			if (current.trim()) push({ kind: "agent", text: current });
			if (full.trim()) {
				conversation.push({
					role: "assistant",
					content: full,
					timestamp: Date.now(),
				});
			}
			setStreamingText("");
			setActiveTool(null);
			setCost(costTracker.getSessionUsage().cost);
			setBusy(false);
			busyRef.current = false;
		},
		[push],
	);

	const runGoal = useCallback(
		async (goal: string) => {
			push({ kind: "user", text: goal });
			conversation.push({ role: "user", content: goal, timestamp: Date.now() });
			await consumeStream(engine.run(goal));
		},
		[engine, push, consumeStream],
	);

	// Build-intent path: run the real builder (not the chat agent) with the
	// existing spinner wired to live build stages, so a multi-minute build shows
	// progress instead of a frozen TUI.
	const runBuildFlow = useCallback(
		async (description: string) => {
			push({ kind: "user", text: description });
			push({
				kind: "info",
				text: `${GLYPHS.gear} Building a harness from your description…`,
			});
			busyRef.current = true;
			setBusy(true);
			setActiveTool(BUILD_STEP_LABELS.analyzing);

			let options: import("../builder").BuildOptions | undefined;
			try {
				const cfg = await resolveProvider();
				if (cfg.type === "ollama")
					cfg.contextTokens = cfg.contextTokens ?? 8192;
				options = {
					provider: createBuildProvider(cfg),
					ask: askInteractive,
				};
			} catch {
				options = undefined;
			}

			try {
				const result = await buildHarness(
					description,
					undefined,
					(p) => setActiveTool(BUILD_STEP_LABELS[p.stage] ?? "Working…"),
					options,
				);
				if (result.success) {
					push({
						kind: "info",
						text: `${GLYPHS.check} Harness built (${result.usedLLM ? "bespoke" : "generic offline chassis"}) → ${result.outputDir}`,
					});
					// Don't let a rate-limited fallback masquerade as a full bespoke
					// build — say plainly it was generic and why.
					if (!result.usedLLM) {
						push({
							kind: "error",
							text: `  Build brain was unavailable, so this is the generic chassis (no bespoke tools/commands).${result.fallbackReason ? ` Reason: ${result.fallbackReason.slice(0, 120)}` : ""} Retry later for a bespoke build.`,
						});
					}
					push({
						kind: "info",
						text: `  cd ${result.outputDir} ${GLYPHS.bullet} bun install ${GLYPHS.bullet} bun start`,
					});
				} else {
					for (const e of result.errors) push({ kind: "error", text: e });
				}
			} catch (err) {
				push({
					kind: "error",
					text: err instanceof Error ? err.message : String(err),
				});
			}

			setActiveTool(null);
			setBusy(false);
			busyRef.current = false;
		},
		[push, askInteractive],
	);

	const resumedRef = useRef(false);
	useEffect(() => {
		if (resumeState && !resumedRef.current && !busyRef.current) {
			resumedRef.current = true;
			push({
				kind: "info",
				text: `Resuming loop "${resumeState.goal?.slice(0, 60) ?? "?"}" (iteration ${resumeState.iteration})…`,
			});
			void consumeStream(engine.resume(resumeState));
		}
	}, [resumeState, engine, push, consumeStream]);

	const handleCommand = useCallback(
		async (trimmed: string) => {
			if (trimmed === "/exit" || trimmed === "/quit") {
				exit();
				return;
			}
			if (trimmed === "/clear") {
				setHistory([]);
				return;
			}
			const matched = findCommand(trimmed);
			if (!matched) {
				push({ kind: "error", text: "Unknown command. Type /help." });
				return;
			}
			try {
				const mod = await matched.command.load();
				const handler = mod.default as LocalCommandHandler;
				const result = await handler.call(matched.args, { interactive: false });
				if (result.value === "EXIT_APP") {
					exit();
				} else if (result.value === "CLEAR_MESSAGES") {
					setHistory([]);
				} else if (result.value) {
					push({ kind: "info", text: result.value });
				}
			} catch (err) {
				push({
					kind: "error",
					text: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[exit, push],
	);

	const onSubmit = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			setInput("");
			// Answering a build-interview question takes priority over everything
			// else — the build is "busy" while waiting on this answer, so this
			// must run before the busy gate below or the answer would be dropped.
			if (askResolveRef.current) {
				const resolve = askResolveRef.current;
				askResolveRef.current = null;
				const answer = trimmed || pendingQuestion?.def || "";
				push({ kind: "user", text: answer });
				setPendingQuestion(null);
				resolve(answer);
				return;
			}
			if (!trimmed) return;
			if (busyRef.current) {
				// A fast Enter (or a multi-line paste, which submits per embedded
				// newline) while the agent is mid-run would otherwise vanish
				// silently — surface it instead of dropping it with no trace.
				push({
					kind: "info",
					text: "Still working — try again once this run finishes.",
				});
				return;
			}
			if (trimmed.startsWith("/")) {
				void handleCommand(trimmed);
			} else if (isBuildIntent(trimmed)) {
				void runBuildFlow(trimmed);
			} else {
				void runGoal(trimmed);
			}
		},
		[handleCommand, runGoal, runBuildFlow, push, pendingQuestion],
	);

	// Live slash-command menu: surface + highlight matching commands as you type
	// "/". Display-only, so no busy gate — typing "/" mid-run must still show it.
	const slashQuery = input.trim().split(" ")[0];
	const slashMatches = input.startsWith("/")
		? COMMANDS.filter((c) => c.name.startsWith(slashQuery)).slice(0, 7)
		: [];

	return (
		<Box flexDirection="column">
			<Banner config={config} branch={branch} />

			<Static items={history}>
				{(item, i) => (
					<Box key={i} paddingLeft={1}>
						{item.kind === "user" && (
							<Text>
								<Text bold>You</Text>
								<Text dimColor>: </Text>
								{item.text}
							</Text>
						)}
						{item.kind === "agent" && (
							<Box flexDirection="column">
								<Text>
									<Text bold color={ACCENT}>
										Agent
									</Text>
									<Text dimColor>:</Text>
								</Text>
								<Markdown text={item.text} />
							</Box>
						)}
						{item.kind === "tool" && (
							<Text dimColor>
								{GLYPHS.arrow} {item.label}
							</Text>
						)}
						{item.kind === "error" && (
							<Text color="red">
								{GLYPHS.cross} {item.text}
							</Text>
						)}
						{item.kind === "info" && <Text dimColor>{item.text}</Text>}
					</Box>
				)}
			</Static>

			{streamingText !== "" && (
				<Box paddingLeft={1}>
					<Text>
						<Text bold color={ACCENT}>
							Agent
						</Text>
						<Text dimColor>: </Text>
						{streamingText}
					</Text>
				</Box>
			)}

			{busy && !pendingQuestion && (
				<Box paddingLeft={1}>
					<Text color={ACCENT}>{SPINNER_FRAMES[spinnerFrame]}</Text>
					<Text color="yellow">
						{" "}
						{activeTool ? `Running ${activeTool}…` : "Thinking…"}
					</Text>
				</Box>
			)}

			{pendingQuestion && (
				<Box paddingLeft={1}>
					<Text color={ACCENT}>{`? `}</Text>
					<Text>{`${pendingQuestion.q} `}</Text>
					<Text dimColor>{`[${pendingQuestion.def}]`}</Text>
				</Box>
			)}

			{slashMatches.length > 0 && (
				<Box flexDirection="column" paddingLeft={2}>
					{slashMatches.map((c) => (
						<Text key={c.name}>
							<Text color="magenta">{c.name}</Text>
							<Text dimColor>{`  ${c.description}`}</Text>
						</Text>
					))}
				</Box>
			)}

			<Box
				borderStyle={BORDER_STYLE}
				borderColor={input.startsWith("/") ? "magenta" : ACCENT}
				paddingLeft={1}
				paddingRight={1}
			>
				<Text
					color={input.startsWith("/") ? "magenta" : ACCENT}
				>{`${GLYPHS.prompt} `}</Text>
				<TextInput
					value={input}
					onChange={setInput}
					onSubmit={onSubmit}
					placeholder={
						pendingQuestion
							? `press enter for "${pendingQuestion.def}"`
							: busy
								? "working…"
								: "type a goal or / for commands"
					}
				/>
			</Box>

			<Box paddingLeft={2} paddingRight={2} justifyContent="space-between">
				<Text dimColor>
					{GLYPHS.modeReady} {engineMode}{" "}
					<Text dimColor>(esc/ctrl-c to quit · /help for commands)</Text>
				</Text>
				<Text dimColor>${cost.toFixed(4)}</Text>
			</Box>
		</Box>
	);
}
