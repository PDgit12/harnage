import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalCommandHandler } from "../../commands";
import { conversation } from "../../conv";

const handler: LocalCommandHandler = {
	async call(args: string[]): Promise<{ value: string }> {
		const name = args[0];
		if (!name) return { value: "Usage: /save <name>" };
		const dir = join(homedir(), ".harnage", "sessions");
		await mkdir(dir, { recursive: true });
		const data = { name, timestamp: Date.now(), messages: conversation };
		await writeFile(join(dir, `${name}.json`), JSON.stringify(data, null, 2));
		return { value: `Session saved: ${name}` };
	},
};

export default handler;
