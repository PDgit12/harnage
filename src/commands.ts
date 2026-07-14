export type CommandType = "local";

export interface Command {
	type: CommandType;
	name: string;
	description: string;
	load: () => Promise<{ default: CommandHandler }>;
}

export interface LocalCommandHandler {
	call: (args: string[], context: unknown) => Promise<{ value: string }>;
}

export type CommandHandler = LocalCommandHandler;

export const COMMANDS: Command[] = [
	{
		type: "local",
		name: "/cost",
		description: "Show token usage and cost",
		load: () => import("./commands/cost"),
	},
	{
		type: "local",
		name: "/doctor",
		description: "Run system diagnostics",
		load: () => import("./commands/doctor"),
	},
	{
		type: "local",
		name: "/help",
		description: "Show available commands",
		load: () => import("./commands/help"),
	},
	{
		type: "local",
		name: "/clear",
		description: "Clear the conversation",
		load: () => import("./commands/clear"),
	},
	{
		type: "local",
		name: "/model",
		description: "Switch or view current model",
		load: () => import("./commands/model"),
	},
	{
		type: "local",
		name: "/init",
		description: "Generate a new harness from a description",
		load: () => import("./commands/init"),
	},
	{
		type: "local",
		name: "/config",
		description: "Configure provider (API key, model, etc.)",
		load: () => import("./commands/config"),
	},
	{
		type: "local",
		name: "/save",
		description: "Save conversation to a named session",
		load: () => import("./commands/save"),
	},
	{
		type: "local",
		name: "/sessions",
		description: "List saved sessions",
		load: () => import("./commands/sessions"),
	},
	{
		type: "local",
		name: "/exit",
		description: "Exit the CLI",
		load: () => import("./commands/exit"),
	},
];

export function findCommand(
	input: string,
): { command: Command; args: string[] } | null {
	const parsed = parseSlashCommand(input);
	if (!parsed) return null;
	const cmd = COMMANDS.find((c) => c.name === parsed.name);
	if (!cmd) return null;
	return { command: cmd, args: parsed.args };
}

export function parseSlashCommand(
	input: string,
): { name: string; args: string[] } | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;
	const parts = trimmed.slice(1).split(/\s+/);
	const name = parts[0];
	if (!name) return null;
	return { name: `/${name}`, args: parts.slice(1) };
}
