import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalCommandHandler } from "../../commands";

const handler: LocalCommandHandler = {
	async call(): Promise<{ value: string }> {
		const dir = join(homedir(), ".harnage", "sessions");
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			return { value: "No saved sessions." };
		}
		const jsonFiles = files
			.filter((f) => f.endsWith(".json"))
			.sort()
			.reverse()
			.slice(0, 20);
		if (!jsonFiles.length) return { value: "No saved sessions." };
		const lines: string[] = ["Saved sessions:"];
		for (const f of jsonFiles) {
			const text = await readFile(join(dir, f), "utf-8");
			const s = JSON.parse(text);
			const date = new Date(s.timestamp).toLocaleDateString();
			const goal = s.messages[0]?.content?.slice(0, 60) ?? "(empty)";
			lines.push(
				`  ${s.name} — ${date} — ${s.messages.length} msgs — "${goal}"`,
			);
		}
		return { value: lines.join("\n") };
	},
};

export default handler;
