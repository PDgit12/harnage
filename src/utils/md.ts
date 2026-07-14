import chalk from "chalk";

export function formatInline(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, (_, b: string) => chalk.bold(b))
		.replace(/`([^`]+)`/g, (_, c: string) => chalk.cyan(c))
		.replace(/^###?\s+(.+)/gm, (_, h: string) => chalk.bold.underline(h))
		.replace(/^[-*]\s+(.+)/gm, (_, i: string) => `  ${chalk.dim("•")} ${i}`)
		.replace(
			/^(\d+)[.)]\s+(.+)/gm,
			(_, n: string, t: string) => `  ${chalk.dim(`${n}.`)} ${t}`,
		);
}

export function formatBlock(text: string): string {
	const lines: string[] = [];
	let inCode = false;
	let codeLang = "";
	let buf: string[] = [];
	const flush = () => {
		if (buf.length === 0) return;
		const tag = codeLang ? chalk.dim(` ${codeLang}`) : "";
		lines.push(
			`\n${chalk.bgGray.white(`┌─[code${tag}]`)}\n${buf.map((l) => chalk.bgGray.white(`│ ${l}`)).join("\n")}\n${chalk.bgGray.white("└──────")}\n`,
		);
		buf = [];
		codeLang = "";
	};
	for (const line of text.split("\n")) {
		const m = line.match(/^```(\w*)/);
		if (m) {
			if (inCode) flush();
			else inCode = true;
			codeLang = m[1] ?? "";
			continue;
		}
		if (inCode) {
			buf.push(line);
			continue;
		}
		if (/^###?\s/.test(line)) {
			lines.push(chalk.bold.underline(line.replace(/^#+\s*/, "")));
			continue;
		}
		if (/^[-*]\s/.test(line)) {
			lines.push(`  ${chalk.dim("•")} ${line.slice(2)}`);
			continue;
		}
		if (/^\d+[.)]\s/.test(line)) {
			lines.push(
				`  ${chalk.dim(line.match(/^\d+[.)]/)?.[0])} ${line.replace(/^\d+[.)]\s*/, "")}`,
			);
			continue;
		}
		if (/^>/.test(line)) {
			lines.push(chalk.dim(`│ ${line.replace(/^>\s*/, "")}`));
			continue;
		}
		if (/^---/.test(line)) {
			lines.push(chalk.dim("\n───\n"));
			continue;
		}
		lines.push(line);
	}
	if (inCode) flush();
	return lines.join("\n");
}
