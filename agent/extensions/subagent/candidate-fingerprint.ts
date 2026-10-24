// Production candidate fingerprint for fingerprint-bound delivery grants (see references/run-manifest.md, "Candidate fingerprint recipe").
// HEAD + typed records for every status path (staged, unstaged, untracked) + the staged patch digest + the exclusion list. Ignored files and .git internals are never read.
// Hardened: fixed argv, no shell, neutral cwd with explicit -C, and candidate-controlled programs (fsmonitor, external diff, textconv) are disabled. Not an OS sandbox: PATH and global git config stay trusted.
import * as childProcess from "node:child_process"; // namespace import: tests wrap execFileSync
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FINGERPRINT_MAX_RECORDS = 5000;
export const FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
export const FINGERPRINT_MAX_EXCLUDES = 8;
const GIT_TIMEOUT_MS = 15_000;
const NEUTRAL_CWD = path.parse(os.homedir()).root;
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export interface Fingerprint { head: string; value: string; unsupported: string[]; records: string[] }
/** Test seams for deterministic fault and boundary injection; production uses the real lstat and git status. */
export interface FingerprintIo { lstat?: (p: string) => fs.Stats; status?: Buffer; maxRecords?: number; maxBytes?: number }

export function git(repo: string, args: string[], maxBuffer = FINGERPRINT_MAX_BYTES, input?: Buffer): Buffer {
	return childProcess.execFileSync("git", ["-C", repo, "-c", "core.fsmonitor=false", "--no-optional-locks", ...(args[0] === "check-ignore" ? [] : ["--literal-pathspecs"]), ...args], { cwd: NEUTRAL_CWD, timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"], input });
}
const exitedOne = (error: unknown) => (error as { status?: number }).status === 1; // grep-style "no match" for config / check-ignore

const MAX_WALK_ENTRIES = 200_000;
const WORKTREE_LINKS_TRAVERSED = process.platform === "win32"; // Git for Windows follows junctions (reproduced); POSIX Git lstat-s links and never enters them

/** Refuses any repository-local/worktree core.fsmonitor (hook, bool, valueless, include, any casing) visible from `repo`: the helper disables it for its own calls, but the permitted `git worktree remove` does not and would run it. Callers: target preflight and the primary checkout (removal runs there). */
export function assertNoRepoFsmonitor(repo: string): void {
	try {
		const fields = git(repo, ["config", "--show-scope", "-z", "--get-regexp", "^core\\.fsmonitor$"], FINGERPRINT_MAX_BYTES).toString("utf8").split("\0");
		if (fields.pop() !== "" || fields.length % 2 !== 0) throw new RangeError("malformed fsmonitor configuration listing; unsupported");
		for (let i = 0; i < fields.length; i += 2) if (!["system", "global", "command"].includes(fields[i])) throw new RangeError("repository-local fsmonitor configuration would run a candidate-controlled program during checkout removal; unsupported");
	} catch (error) { if (!exitedOne(error)) throw error; }
}

/**
 * Runs before any Git command that reads the working tree. Fails closed (throws) when Git would execute candidate-controlled programs,
 * hide tracked edits, or read through a linked directory outside the candidate. Pathname checks only: the check-then-use race stays documented.
 */
export function preflight(repo: string, lstat: (p: string) => fs.Stats = fs.lstatSync): void {
	assertNoRepoFsmonitor(repo); // step 0, before any Git command that reads the working tree
	// 1. Repository-local content filters (filter.<name>.clean/process/smudge) would be run by `git status` to compare working bytes with the index.
	try {
		// -z --show-scope output: scope, NUL, key, newline, value, NUL (per entry).
		const fields = git(repo, ["config", "--show-scope", "-z", "--get-regexp", "^filter\\."], FINGERPRINT_MAX_BYTES).toString("utf8").split("\0");
		for (let i = 0; i + 1 < fields.length; i += 2) if (!["system", "global", "command"].includes(fields[i])) throw new RangeError("repository-local filter configuration would run candidate-controlled programs; unsupported");
	} catch (error) { if (!exitedOne(error)) throw error; }
	// 2. Index states that hide or skip working files (assume-unchanged / fsmonitor-valid, skip-worktree, sparse, gitlinks) make status an incomplete file list.
	const listing = git(repo, ["ls-files", "-z", "-v", "--stage"]);
	const text = listing.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(listing)) throw new RangeError("tracked path is not UTF-8; unsupported");
	const trackedPaths: string[] = [];
	for (const record of text.split("\0")) {
		if (!record) continue;
		const m = /^(\S) (\d{6}) [0-9a-f]+ \d\t([\s\S]*)$/.exec(record);
		if (!m) throw new RangeError("unrecognized index listing");
		if (!"HM".includes(m[1])) throw new RangeError("index hides or skips a tracked path (assume-unchanged, skip-worktree or sparse checkout); unsupported");
		if (m[2] === "160000" || m[2] === "040000") throw new RangeError("submodule or sparse-directory index entry; unsupported");
		trackedPaths.push(m[3]);
	}
	// 3. A linked ancestor of any tracked path must not exist: Git's status would read the outside bytes through it.
	const verified = new Set<string>();
	for (const file of trackedPaths) assertRealAncestors(repo, file, lstat, verified);
	// 4. Untracked-file discovery walks non-ignored directories; on Windows Git enters junctions, so refuse any link it could enter.
	if (WORKTREE_LINKS_TRAVERSED) assertNoEnterableLinks(repo);
}

/** Every directory component of a repo-relative path must be a real directory (not a symlink or junction), or absent. */
function assertRealAncestors(repo: string, file: string, lstat: (p: string) => fs.Stats, verified: Set<string>): void {
	const parts = file.split("/").slice(0, -1);
	let dir = "";
	for (const part of parts) {
		dir = dir ? `${dir}/${part}` : part;
		if (verified.has(dir)) continue;
		let stat: fs.Stats;
		try { stat = lstat(path.join(repo, dir)); } catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return; // absent: nothing to traverse
			throw error;
		}
		if (stat.isSymbolicLink()) throw new RangeError("a parent directory is a symlink or junction; unsupported");
		verified.add(dir);
	}
}

function assertNoEnterableLinks(repo: string): void { // no tracked-symlink exemption: an index mode says nothing about what the worktree object is now
	let seen = 0;
	let level = [""];
	while (level.length > 0) {
		const candidates: string[] = [];
		const links = new Set<string>();
		for (const rel of level) {
			for (const entry of fs.readdirSync(path.join(repo, rel), { withFileTypes: true })) {
				if (entry.name === ".git") continue;
				if (++seen > MAX_WALK_ENTRIES) throw new RangeError("working tree too large to check for linked directories");
				if (entry.isFile()) continue;
				const child = rel ? `${rel}/${entry.name}` : entry.name;
				const stat = fs.lstatSync(path.join(repo, child));
				if (stat.isSymbolicLink()) links.add(child);
				else if (!stat.isDirectory()) continue;
				candidates.push(child);
			}
		}
		let ignored = new Set<string>();
		if (candidates.length > 0) {
			try { ignored = new Set(git(repo, ["check-ignore", "-z", "--stdin"], FINGERPRINT_MAX_BYTES, candidates.join("\0") + "\0").toString("utf8").split("\0").filter(Boolean)); } catch (error) { if (!exitedOne(error)) throw error; }
		}
		level = [];
		for (const child of candidates) {
			if (ignored.has(child)) continue; // Git prunes ignored directories and never enters them
			if (!links.has(child)) level.push(child);
			else throw new RangeError("a symlink or junction in the working tree could be entered by Git; unsupported");
		}
	}
}

/** Relative, literal, normalized (no trailing slash), sorted, de-duplicated exclusion prefixes; throws on anything else. */
export function validateExclude(input: unknown): string[] {
	if (!Array.isArray(input) || input.length > FINGERPRINT_MAX_EXCLUDES) throw new RangeError(`exclude must be a list of at most ${FINGERPRINT_MAX_EXCLUDES} relative paths`);
	const out = new Set<string>();
	for (const item of input) {
		if (typeof item !== "string" || item.length < 1 || item.length > 200 || !/^[\x20-\x7e]+$/.test(item) || item.includes("\\") || item.includes(":") || item.startsWith("/")) throw new RangeError("exclude entries must be relative ASCII forward-slash paths");
		const clean = item.replace(/\/+$/, "");
		const segments = clean.split("/");
		if (segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git" || /[. ]$/.test(s))) throw new RangeError("exclude entry is empty, dot, dot-dot, .git or has a trailing dot or space segment");
		out.add(clean);
	}
	return [...out].sort();
}

/** A tracked path can never be excluded: otherwise an edit to it would not change the fingerprint. */
export function assertExcludeUntracked(repo: string, exclude: string[]): void {
	for (const prefix of exclude) if (git(repo, ["ls-files", "-z", "--", prefix]).length > 0) throw new RangeError("exclude covers a tracked path");
}

export function candidateFingerprint(repo: string, exclude: string[] = [], io: FingerprintIo = {}): Fingerprint {
	const maxRecords = io.maxRecords ?? FINGERPRINT_MAX_RECORDS;
	const maxBytes = io.maxBytes ?? FINGERPRINT_MAX_BYTES;
	const head = git(repo, ["rev-parse", "HEAD"], 4096).toString().trim();
	const lstat = io.lstat ?? fs.lstatSync;
	preflight(repo, lstat);
	const raw = io.status ?? git(repo, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
	const unsupported: string[] = [];
	const records: string[] = [];
	const typed: string[][] = [];
	let hashed = 0;
	const verifiedDirs = new Set<string>();
	const add = (display: string, tuple: string[]) => {
		if (records.length >= maxRecords) throw new RangeError("fingerprint record limit exceeded");
		records.push(display);
		typed.push(tuple);
	};
	let offset = 0;
	while (offset < raw.length) {
		let end = raw.indexOf(0, offset);
		if (end < 0) end = raw.length;
		const bytes = raw.subarray(offset + 3, end);
		offset = end + 1;
		if (bytes.length === 0) continue;
		const file = bytes.toString("utf8");
		if (!Buffer.from(file, "utf8").equals(bytes)) { add(`UNSUPPORTED hex:${bytes.toString("hex")}`, ["UNSUPPORTED", "hex", bytes.toString("hex")]); unsupported.push(`hex:${bytes.toString("hex")}`); continue; }
		if (exclude.some((prefix) => file === prefix || file.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) continue;
		assertRealAncestors(repo, file, lstat, verifiedDirs);
		const full = path.join(repo, file);
		let stat: fs.Stats | undefined;
		try { stat = lstat(full); } catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") { add(`UNSUPPORTED ${file}`, ["UNSUPPORTED", file, `inspect:${String(code)}`]); unsupported.push(file); continue; } // EACCES/EIO/unknown is not absence
		}
		if (!stat) add(`deleted ${file}`, ["deleted", file]);
		else if (stat.isSymbolicLink()) { const digest = sha256(fs.readlinkSync(full)); add(`link ${file} ${digest}`, ["link", file, digest]); } // link text only, never followed
		else if (stat.isFile()) {
			hashed += stat.size;
			if (hashed > maxBytes) throw new RangeError("fingerprint size limit exceeded");
			const digest = sha256(fs.readFileSync(full)); // raw working bytes, no EOL filter
			add(`file ${file} ${digest}`, ["file", file, digest]);
		} else { add(`UNSUPPORTED ${file}`, ["UNSUPPORTED", file, "kind"]); unsupported.push(file); } // directory, submodule or other
	}
	records.sort();
	// Index state that working bytes alone cannot show; unfiltered by exclusions, so staging into an excluded directory still changes the value.
	const staged = sha256(git(repo, ["diff", "--cached", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv"], maxBytes));
	const sortedTyped = typed.map((tuple) => JSON.stringify(tuple)).sort().map((text) => JSON.parse(text));
	const body = JSON.stringify([["HEAD", head], ...sortedTyped, ["staged", staged], ...exclude.slice().sort().map((prefix) => ["exclude", prefix])]);
	return { head, value: sha256(body), unsupported, records };
}
