import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ScriptMap {
	build?: string;
	test?: string;
	lint?: string;
	typecheck?: string;
	start?: string;
}

export interface ProjectContext {
	files: string[];
	languages: string[];
	hasPackageJson: boolean;
	hasGit: boolean;
	scripts: ScriptMap;
}

export async function analyzeProject(cwd: string): Promise<ProjectContext> {
	const files: string[] = [];
	const languages = new Set<string>();
	let scripts: ScriptMap = {};

	async function walk(dir: string, depth = 0): Promise<void> {
		if (depth > 2) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const path = join(dir, e.name);
			if (
				e.isDirectory() &&
				!e.name.startsWith(".") &&
				e.name !== "node_modules"
			) {
				await walk(path, depth + 1);
			} else if (e.isFile()) {
				files.push(path);
				const ext = e.name.split(".").pop();
				if (ext === "ts" || ext === "tsx") languages.add("typescript");
				else if (ext === "rs") languages.add("rust");
				else if (ext === "py") languages.add("python");
				else if (ext === "go") languages.add("go");
				else if (ext === "js" || ext === "jsx") languages.add("javascript");
			}
		}
	}

	await walk(cwd);
	const hasPackageJson = existsSync(join(cwd, "package.json"));
	if (hasPackageJson) {
		try {
			const pkg = JSON.parse(await Bun.file(join(cwd, "package.json")).text());
			scripts = {
				build: pkg.scripts?.build,
				test: pkg.scripts?.test,
				lint: pkg.scripts?.lint,
				typecheck: pkg.scripts?.typecheck,
				start: pkg.scripts?.start,
			};
		} catch {
			/* ignore */
		}
	}
	const hasGit = existsSync(join(cwd, ".git"));

	return {
		files,
		languages: [...languages],
		hasPackageJson,
		hasGit,
		scripts,
	};
}
