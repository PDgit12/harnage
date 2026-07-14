import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalCommandHandler } from "../commands";
import { findCommand } from "../commands";
import { conversation } from "../conv";
import { costTracker } from "../cost-tracker";
import type { LoopEngine } from "../loop/LoopEngine";
import type { ProviderConfig } from "../services/api/client";

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
}

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
	return preview ? `${n} · ${preview.slice(0, 80)}` : n;
}

export function App({ config, engine, branch, resumeState }: AppProps) {
	const { exit } = useApp();
	const [history, setHistory] = useState<HistoryItem[]>([
		{ kind: "info", text: `⚙ AgentForge — ${config.type} · ${config.model}` },
		{
			kind: "info",
			text: "  /init  build a harness   ·   /help  all commands   ·   or type a goal to run the agent",
		},
	]);
	const [input, setInput] = useState("");
	const [streamingText, setStreamingText] = useState("");
	const [activeTool, setActiveTool] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [cost, setCost] = useState(0);
	const busyRef = useRef(false);
	const engineMode = busy ? "working" : "ready";

	const push = useCallback((item: HistoryItem) => {
		setHistory((h) => [...h, item]);
	}, []);

	useInput((_, key) => {
		if (key.escape && !busyRef.current) exit();
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
				const result = await handler.call(matched.args, {});
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
			if (!trimmed || busyRef.current) return;
			if (trimmed.startsWith("/")) {
				void handleCommand(trimmed);
			} else {
				void runGoal(trimmed);
			}
		},
		[handleCommand, runGoal],
	);

	return (
		<Box flexDirection="column">
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
							<Text>
								<Text bold color="cyan">
									Agent
								</Text>
								<Text dimColor>: </Text>
								{item.text}
							</Text>
						)}
						{item.kind === "tool" && <Text dimColor>↳ {item.label}</Text>}
						{item.kind === "error" && <Text color="red">✖ {item.text}</Text>}
						{item.kind === "info" && <Text dimColor>{item.text}</Text>}
					</Box>
				)}
			</Static>

			{streamingText !== "" && (
				<Box paddingLeft={1}>
					<Text>
						<Text bold color="cyan">
							Agent
						</Text>
						<Text dimColor>: </Text>
						{streamingText}
					</Text>
				</Box>
			)}

			{busy && (
				<Box paddingLeft={1}>
					<Text color="yellow">
						✳ {activeTool ? `Running ${activeTool}…` : "Thinking…"}
					</Text>
				</Box>
			)}

			<Box borderStyle="round" borderDimColor paddingLeft={1} paddingRight={1}>
				<Text color="cyan">{"❯ "}</Text>
				<TextInput
					value={input}
					onChange={setInput}
					onSubmit={onSubmit}
					placeholder={busy ? "working…" : "type a goal or /command"}
				/>
			</Box>

			<Box paddingLeft={2} paddingRight={2} justifyContent="space-between">
				<Text dimColor>
					⏵⏵ {engineMode}{" "}
					<Text dimColor>(esc to quit · /help for commands)</Text>
				</Text>
				<Text dimColor>
					{branch ? `${branch} · ` : ""}
					{config.model.split("/").pop()} · ${cost.toFixed(4)}
				</Text>
			</Box>
		</Box>
	);
}
