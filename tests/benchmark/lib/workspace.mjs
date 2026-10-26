// Harness-only replay from git history. Files are read with `git cat-file --batch` (no checkout, no index or work-tree
// writes in the candidate); every write target must resolve under the assigned scratch root.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HARNESS_ROOTS, assertHarnessPath } from "./manifest.mjs";

export function assertInside(child, parent) {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${child} is outside the assigned scratch root ${parent}`);
	return child;
}

// Harness-root paths of a commit, from the tree listing only. RFID-named paths belong to another project: they are never
// read or written into a replay; they are reported by name (excluded) so the disclosure is explicit.
export function listHarnessTree({ repo, commit, roots = HARNESS_ROOTS }) {
	const out = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots], { cwd: repo, encoding: "utf8", maxBuffer: 256 << 20 });
	const all = out.split("\0").filter(Boolean).sort();
	const excluded = all.filter((p) => /rfid/i.test(p));
	const paths = all.filter((p) => !/rfid/i.test(p)).map(assertHarnessPath);
	return { paths, excluded };
}

export function listHarnessPaths(args) {
	return listHarnessTree(args).paths;
}

// Blob bytes for explicit paths only. Missing or non-blob paths throw (a held-out test that does not exist is never a pass).
export function readBlobs({ repo, commit, paths }) {
	const blobs = new Map();
	if (paths.length === 0) return blobs;
	const out = execFileSync("git", ["cat-file", "--batch"], { cwd: repo, input: paths.map((p) => `${commit}:${p}\n`).join(""), maxBuffer: 1 << 30 });
	let pos = 0;
	for (const p of paths) {
		const nl = out.indexOf(0x0a, pos);
		const header = out.subarray(pos, nl).toString("utf8");
		const m = /^\S+ (\S+) (\d+)$/.exec(header);
		if (!m || m[1] !== "blob") throw new Error(`cannot read ${commit}:${p}: ${header}`);
		const size = Number(m[2]);
		blobs.set(p, out.subarray(nl + 1, nl + 1 + size));
		pos = nl + 1 + size + 1;
	}
	return blobs;
}

function writeBlobs(blobs, dest) {
	for (const [p, bytes] of blobs) {
		const target = path.join(dest, p);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, bytes);
	}
}

// Replaces dest with the harness roots of one commit (the parent state of a task).
export function materializeHarness({ repo, commit, dest, scratchRoot, roots = HARNESS_ROOTS }) {
	assertInside(dest, scratchRoot);
	const { paths, excluded } = listHarnessTree({ repo, commit, roots });
	const blobs = readBlobs({ repo, commit, paths });
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(dest, { recursive: true });
	writeBlobs(blobs, dest);
	return { files: paths.length, paths, excludedRfidNamed: excluded };
}

// Overwrites explicit paths with their content at a commit (held-out acceptance tests from the post-task tree).
export function writeCommitFiles({ repo, commit, paths, dest, scratchRoot }) {
	assertInside(dest, scratchRoot);
	paths.forEach(assertHarnessPath);
	writeBlobs(readBlobs({ repo, commit, paths }), dest);
	return { files: paths.length };
}

function walk(dir, base = dir, found = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, base, found);
		else found.push(full);
	}
	return found;
}

// Relative POSIX path -> sha256 of every file under dir.
export function snapshot(dir) {
	const map = new Map();
	if (!fs.existsSync(dir)) return map;
	for (const file of walk(dir)) {
		const rel = path.relative(dir, file).split(path.sep).join("/");
		map.set(rel, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
	}
	return map;
}

export function diffSnapshots(before, after) {
	const added = [], modified = [], removed = [];
	for (const [p, h] of after) {
		if (!before.has(p)) added.push(p);
		else if (before.get(p) !== h) modified.push(p);
	}
	for (const p of before.keys()) if (!after.has(p)) removed.push(p);
	const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
	return { added: added.sort(byName), modified: modified.sort(byName), removed: removed.sort(byName) };
}

// The runner's workspace: one stable directory per mode (shared) or per task (fresh), always under the scratch root.
export function createWorkspace({ repo, scratchRoot, roots = HARNESS_ROOTS }) {
	return {
		dirFor: (mode, task) => assertInside(path.join(scratchRoot, mode, mode === "fresh" ? task.id : "shared"), scratchRoot),
		prepare: async (task, dir) => materializeHarness({ repo, commit: task.parent, dest: dir, scratchRoot, roots }),
		heldOut: async (task, dir) => writeCommitFiles({ repo, commit: task.commit, paths: task.acceptanceTests, dest: dir, scratchRoot }),
		snapshot,
		diff: diffSnapshots,
	};
}
