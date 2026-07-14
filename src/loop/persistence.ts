import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoopState } from "./types";

const LOOP_DIR = join(homedir(), ".agentforge", "loops");

export interface LoopSnapshot {
	id: string;
	goal: string;
	state: LoopState;
	timestamp: number;
	version: number;
}

async function ensureDir(): Promise<void> {
	if (!existsSync(LOOP_DIR)) {
		await mkdir(LOOP_DIR, { recursive: true });
	}
}

function snapshotPath(id: string, sequence: number): string {
	return join(LOOP_DIR, `${id}-${sequence}.json`);
}

export async function saveLoop(state: LoopState): Promise<string> {
	await ensureDir();
	const snapshots = await listSnapshots(state.id);
	const nextSeq =
		snapshots.length > 0
			? Math.max(...snapshots.map((s) => s.sequence)) + 1
			: 1;

	const snapshot: LoopSnapshot = {
		id: state.id,
		goal: state.goal,
		state,
		timestamp: Date.now(),
		version: 1,
	};

	const path = snapshotPath(state.id, nextSeq);
	await writeFile(path, JSON.stringify(snapshot, null, 2), "utf-8");

	if (nextSeq > 3) {
		const toRemove = snapshots
			.sort((a, b) => a.sequence - b.sequence)
			.slice(0, nextSeq - 3);
		await Promise.all(
			toRemove.map((s) =>
				unlink(snapshotPath(state.id, s.sequence)).catch((e) => {
					console.warn("[agentforge]", (e as Error).message);
				}),
			),
		);
	}

	return state.id;
}

export async function loadLoop(id: string): Promise<LoopState | null> {
	const snapshots = await listSnapshots(id);
	if (snapshots.length === 0) return null;

	const latest = snapshots.sort((a, b) => b.sequence - a.sequence)[0];
	const raw = await readFile(snapshotPath(id, latest.sequence), "utf-8");
	let snapshot: LoopSnapshot;
	try {
		snapshot = JSON.parse(raw);
	} catch (e) {
		console.warn(
			`[persistence] Failed to parse loop snapshot: ${e instanceof Error ? e.message : e}`,
		);
		return null;
	}
	return snapshot.state;
}

export async function listLoops(): Promise<
	Array<{ id: string; goal: string; timestamp: number }>
> {
	await ensureDir();
	const entries = await readdir(LOOP_DIR, { withFileTypes: true });
	const seen = new Map<
		string,
		{ id: string; goal: string; timestamp: number; seq: number }
	>();

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const match = entry.name.match(/^(.+)-(\d+)\.json$/);
		if (!match) continue;
		const id = match[1];
		const seq = parseInt(match[2], 10);
		try {
			const raw = await readFile(join(LOOP_DIR, entry.name), "utf-8");
			const snap: LoopSnapshot = JSON.parse(raw);
			const existing = seen.get(id);
			if (!existing || seq > existing.seq) {
				seen.set(id, { id, goal: snap.goal, timestamp: snap.timestamp, seq });
			}
		} catch (e) {
			console.warn("[agentforge]", (e as Error).message);
		}
	}

	return Array.from(seen.values())
		.map(({ id, goal, timestamp }) => ({ id, goal, timestamp }))
		.sort((a, b) => b.timestamp - a.timestamp);
}

export async function deleteLoop(id: string): Promise<void> {
	await ensureDir();
	const snapshots = await listSnapshots(id);
	await Promise.all(
		snapshots.map((s) =>
			unlink(snapshotPath(id, s.sequence)).catch((e) => {
				console.warn("[agentforge]", (e as Error).message);
			}),
		),
	);
}

export async function recoverLastLoop(): Promise<LoopState | null> {
	const loops = await listLoops();
	if (loops.length === 0) return null;
	return loadLoop(loops[0].id);
}

interface SnapshotEntry {
	sequence: number;
	timestamp: number;
}

async function listSnapshots(id: string): Promise<SnapshotEntry[]> {
	await ensureDir();
	const entries = await readdir(LOOP_DIR, { withFileTypes: true });
	const results: SnapshotEntry[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const match = entry.name.match(
			new RegExp(
				`^${id.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.json$`,
			),
		);
		if (!match) continue;
		const seq = parseInt(match[1], 10);
		try {
			const stat = await readFile(join(LOOP_DIR, entry.name), "utf-8");
			const snap: LoopSnapshot = JSON.parse(stat);
			results.push({ sequence: seq, timestamp: snap.timestamp });
		} catch (e) {
			console.warn("[agentforge]", (e as Error).message);
		}
	}
	return results;
}
