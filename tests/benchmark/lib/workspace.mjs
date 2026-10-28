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

// Time left for an owned blocking subprocess. timeoutMs is a TOTAL budget of one operation on the monotonic `now`; remainingMs (a supplier of the current ms left, for example the
// runner's task clock) overrides it. Neither given: unbounded (direct callers only). The remainder is read again before EVERY subprocess; a remainder under 1 ms never launches one
// (execFileSync treats a timeout of 0 as unbounded), it fails as ETIMEDOUT, which the runner treats as the task deadline.
export function remainingOf({ timeoutMs, remainingMs, now = () => performance.now() } = {}) {
	if (typeof remainingMs === "function") return remainingMs;
	if (timeoutMs === undefined || timeoutMs === null) return null;
	const end = now() + timeoutMs;
	return () => end - now();
}
function subprocessTimeout(remaining, what) {
	if (!remaining) return undefined;
	const ms = remaining();
	if (!(ms >= 1)) throw Object.assign(new Error(`${what} not started: the time budget is spent`), { code: "ETIMEDOUT" });
	return Math.floor(ms);
}

// Harness-root paths of a commit, from the tree listing only. RFID-named paths belong to another project: they are never
// read or written into a replay; they are reported by name (excluded) so the disclosure is explicit.
export function listHarnessTree({ repo, commit, roots = HARNESS_ROOTS, timeoutMs, remainingMs, now }) {
	const timeout = subprocessTimeout(remainingOf({ timeoutMs, remainingMs, now }), "git ls-tree");
	const out = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit, "--", ...roots], { cwd: repo, encoding: "utf8", maxBuffer: 256 << 20, timeout });
	const all = out.split("\0").filter(Boolean).sort();
	const excluded = all.filter((p) => /rfid/i.test(p));
	const paths = all.filter((p) => !/rfid/i.test(p)).map(assertHarnessPath);
	return { paths, excluded };
}

export function listHarnessPaths(args) {
	return listHarnessTree(args).paths;
}

// Blob bytes for explicit paths only. Missing or non-blob paths throw (a held-out test that does not exist is never a pass).
export function readBlobs({ repo, commit, paths, timeoutMs, remainingMs, now }) {
	const blobs = new Map();
	if (paths.length === 0) return blobs;
	const timeout = subprocessTimeout(remainingOf({ timeoutMs, remainingMs, now }), "git cat-file");
	const out = execFileSync("git", ["cat-file", "--batch"], { cwd: repo, input: paths.map((p) => `${commit}:${p}\n`).join(""), maxBuffer: 1 << 30, timeout });
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
// timeoutMs (or remainingMs) is the TOTAL budget of the whole materialization, shared by the sequential git reads; nothing is removed or written once it is spent.
export function materializeHarness({ repo, commit, dest, scratchRoot, roots = HARNESS_ROOTS, timeoutMs, remainingMs, now }) {
	assertInside(dest, scratchRoot);
	const remaining = remainingOf({ timeoutMs, remainingMs, now });
	const { paths, excluded } = listHarnessTree({ repo, commit, roots, remainingMs: remaining });
	const blobs = readBlobs({ repo, commit, paths, remainingMs: remaining });
	subprocessTimeout(remaining, "workspace write");
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(dest, { recursive: true });
	writeBlobs(blobs, dest);
	return { files: paths.length, paths, excludedRfidNamed: excluded };
}

// Overwrites explicit paths with their content at a commit (held-out acceptance tests from the post-task tree).
export function writeCommitFiles({ repo, commit, paths, dest, scratchRoot, timeoutMs, remainingMs, now }) {
	assertInside(dest, scratchRoot);
	paths.forEach(assertHarnessPath);
	writeBlobs(readBlobs({ repo, commit, paths, timeoutMs, remainingMs, now }), dest);
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

// Relative POSIX path -> sha256 of every file under dir. Synchronous: an optional stop() is checked between files (cooperative, so a single blocked read
// still cannot be interrupted); a true stop throws ETIMEDOUT, which the runner treats as the task deadline.
export function snapshot(dir, { stop } = {}) {
	const map = new Map();
	if (!fs.existsSync(dir)) return map;
	for (const file of walk(dir)) {
		if (stop?.()) throw Object.assign(new Error("workspace snapshot stopped at the task deadline"), { code: "ETIMEDOUT" });
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

// Measurement policy for generated backend tool state (Serena writes an untracked root .serena/ into the workspace). It is not implementation output:
// only a file at the root .serena/ that is neither materialized from the parent commit (tracked) nor in the pre-session baseline snapshot qualifies.
// A tracked or preexisting file, a sibling (.serena2/), a nested .serena/ and every other path stay scored. Qualifying files are reported, never hidden.
const SERENA_ROOT = ".serena/";
export const TOOL_STATE_POLICY = {
	id: "untracked-root-serena-v1",
	roots: [SERENA_ROOT],
	rule: "added files under a root tool-state directory that are not materialized tracked paths and absent from the pre-session baseline snapshot",
	isToolState: (p, { tracked, before } = {}) => tracked instanceof Set && before instanceof Map && p.startsWith(SERENA_ROOT) && !tracked.has(p) && !before.has(p),
};

// Task-owned scratch and evidence directories: exact absolute paths under <scratchRoot>/_artifacts/<mode>/<task id>/, a sibling of (never inside) every workspace directory and of the
// scored snapshot boundary. Per task, so sequential tasks never share or overlap; the workspace is rebuilt but these are never removed here.
export const ARTIFACT_POLICY = { id: "task-owned-artifacts-v1", rule: "scratch and evidence directories are exact absolute task-owned paths outside the scored workspace; any file inside the workspace is still scored" };
export function artifactPaths({ scratchRoot, mode, task, workspaceDir }) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(task?.id))) throw new Error(`task id ${task?.id} cannot name an artifact directory`);
	const root = assertInside(path.join(scratchRoot, "_artifacts", mode, task.id), scratchRoot);
	const apart = (a, b) => { const r = path.relative(path.resolve(a), path.resolve(b)); return r.startsWith("..") || path.isAbsolute(r); };
	if (workspaceDir && !(apart(root, workspaceDir) && apart(workspaceDir, root))) throw new Error(`artifact root ${root} overlaps the workspace ${workspaceDir}`);
	const fwd = (p) => path.resolve(p).split(path.sep).join("/");
	return { scratch: fwd(path.join(root, "scratch")), evidence: fwd(path.join(root, "evidence")) };
}

// The runner's workspace: one stable directory per mode (shared) or per task (fresh), always under the scratch root.
export function createWorkspace({ repo, scratchRoot, roots = HARNESS_ROOTS }) {
	return {
		toolStatePolicy: TOOL_STATE_POLICY,
		artifactPolicy: ARTIFACT_POLICY,
		artifactsFor(mode, task) { return artifactPaths({ scratchRoot, mode, task, workspaceDir: this.dirFor(mode, task) }); },
		// New owned directories only (recursive create keeps anything already there); nothing is deleted.
		async prepareArtifacts(a) { for (const p of [a.scratch, a.evidence]) { assertInside(p, scratchRoot); fs.mkdirSync(p, { recursive: true }); } },
		dirFor: (mode, task) => assertInside(path.join(scratchRoot, mode, mode === "fresh" ? task.id : "shared"), scratchRoot),
		// Git reads are bounded by the remaining task time (timeoutMs, kills the git child); the file writes are synchronous and cannot be interrupted, only checked after.
		prepare: async (task, dir, o) => materializeHarness({ repo, commit: task.parent, dest: dir, scratchRoot, roots, timeoutMs: o?.timeoutMs, remainingMs: o?.remainingMs }),
		heldOut: async (task, dir, o) => writeCommitFiles({ repo, commit: task.commit, paths: task.acceptanceTests, dest: dir, scratchRoot, timeoutMs: o?.timeoutMs, remainingMs: o?.remainingMs }),
		snapshot,
		diff: diffSnapshots,
	};
}
