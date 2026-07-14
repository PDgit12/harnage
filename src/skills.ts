import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	triggers: string[];
	body: string;
}

/**
 * Skills-as-markdown for the reference harness: drop .md files in ./skills/
 * (frontmatter: name, description, triggers) and they're injected into the
 * system prompt. Same format the builder ships in generated harnesses.
 */
export async function loadSkills(
	dir = join(process.cwd(), "skills"),
): Promise<Skill[]> {
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	const skills: Skill[] = [];
	for (const f of files) {
		try {
			const raw = await readFile(join(dir, f), "utf-8");
			const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
			const fm: Record<string, string> = {};
			let body = raw;
			if (m) {
				body = m[2];
				for (const line of m[1].split("\n")) {
					const kv = line.match(/^([\w-]+):\s*(.*)$/);
					if (kv) fm[kv[1]] = kv[2];
				}
			}
			skills.push({
				name: fm.name ?? f.replace(/\.md$/, ""),
				description: fm.description ?? "",
				triggers: (fm.triggers ?? "")
					.split(",")
					.map((t) => t.trim().toLowerCase())
					.filter(Boolean),
				body: body.trim(),
			});
		} catch {
			/* skip unreadable skill */
		}
	}
	return skills;
}

export function skillsPromptBlock(skills: Skill[]): string {
	if (skills.length === 0) return "";
	return `\n\n## Skills\n${skills.map((s) => `### ${s.name}\n${s.body}`).join("\n\n")}`;
}
