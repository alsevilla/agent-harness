// Regression for the production candidate fingerprint (candidate-fingerprint.ts), the recipe in references/run-manifest.md, over disposable temp repositories.
// Enforcement by a consumer (opt-in bound delivery grants) is covered by delivery-bound.test.ts.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 26 });
import { candidateFingerprint } from "../candidate-fingerprint.ts";
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const fingerprint = candidateFingerprint;

function makeRepo(label: string): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), `fingerprint-${label}-`));
	git(repo, "init", "-q");
	for (const [key, value] of [["user.email", "t@example.invalid"], ["user.name", "t"], ["core.autocrlf", "false"], ["core.symlinks", "true"], ["commit.gpgsign", "false"]]) git(repo, "config", key, value);
	fs.writeFileSync(path.join(repo, "f.txt"), "aaaa\n");
	fs.writeFileSync(path.join(repo, "gone.txt"), "to delete\n");
	fs.writeFileSync(path.join(repo, "old-name.txt"), "rename me\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	return repo;
}
const write = (repo: string, name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
const cleanup = (repo: string) => fs.rmSync(repo, { recursive: true, force: true });

test("same-size edits keep status and diffstat identical but change the content fingerprint", () => {
	const repo = makeRepo("same-size");
	try {
		write(repo, "f.txt", "bbbb\n");
		const statusB = git(repo, "status", "--short").toString(), statB = git(repo, "diff", "--stat").toString().split("\n").at(-2), first = fingerprint(repo);
		write(repo, "f.txt", "cccc\n");
		expect(git(repo, "status", "--short").toString()).toBe(statusB); // the weak summary cannot tell the states apart
		expect(git(repo, "diff", "--stat").toString().split("\n").at(-2)).toBe(statB);
		expect(fingerprint(repo).value).not.toBe(first.value);
		expect(fingerprint(repo).value).toBe(fingerprint(repo).value); // deterministic for unchanged bytes
	} finally { cleanup(repo); }
});

test("staged-only and index-only differences change the fingerprint", () => {
	const repo = makeRepo("staged");
	try {
		const clean = fingerprint(repo).value;
		write(repo, "f.txt", "bbbb\n"); git(repo, "add", "f.txt"); write(repo, "f.txt", "aaaa\n"); // staged change, working bytes back at HEAD
		const stagedOnly = fingerprint(repo);
		expect(git(repo, "status", "--short").toString()).toMatch(/^MM f\.txt/m);
		expect(stagedOnly.value).not.toBe(clean);
		// Same working bytes and same status/diffstat, different index content.
		write(repo, "f.txt", "bbbb\n"); git(repo, "add", "f.txt"); write(repo, "f.txt", "cccc\n");
		const indexB = fingerprint(repo).value, statusB = git(repo, "status", "--short").toString();
		write(repo, "f.txt", "dddd\n"); git(repo, "add", "f.txt"); write(repo, "f.txt", "cccc\n");
		expect(git(repo, "status", "--short").toString()).toBe(statusB);
		expect(fingerprint(repo).value).not.toBe(indexB);
	} finally { cleanup(repo); }
});

test("untracked, deleted and renamed paths change the fingerprint; a rename is a delete plus an add", () => {
	const repo = makeRepo("paths");
	try {
		const clean = fingerprint(repo).value;
		write(repo, "new.txt", "x\n");
		const untracked = fingerprint(repo);
		expect(untracked.value).not.toBe(clean);
		expect(untracked.records).toContain(`file new.txt ${sha256("x\n")}`);
		fs.rmSync(path.join(repo, "new.txt"));
		fs.rmSync(path.join(repo, "gone.txt"));
		const deleted = fingerprint(repo);
		expect(deleted.records).toContain("deleted gone.txt");
		expect(deleted.value).not.toBe(clean);
		git(repo, "checkout", "--", "gone.txt");
		git(repo, "mv", "old-name.txt", "new-name.txt");
		const renamed = fingerprint(repo);
		expect(renamed.records).toContain("deleted old-name.txt");
		expect(renamed.records.some((r) => r.startsWith("file new-name.txt "))).toBe(true);
		expect(renamed.value).not.toBe(clean);
	} finally { cleanup(repo); }
});

test("an explicitly excluded artifact directory does not change the fingerprint; the exclusion list itself does", () => {
	const repo = makeRepo("exclude");
	try {
		const base = fingerprint(repo, ["_artifacts/"]).value;
		write(repo, "_artifacts/log.txt", "one\n");
		expect(fingerprint(repo, ["_artifacts/"]).value).toBe(base);
		write(repo, "_artifacts/log.txt", "two\n");
		expect(fingerprint(repo, ["_artifacts/"]).value).toBe(base);
		expect(fingerprint(repo).value).not.toBe(base); // without the exclusion the artifact is a relevant untracked input
		expect(fingerprint(repo, ["_artifacts/", "other/"]).value).not.toBe(base);
	} finally { cleanup(repo); }
});

test("unsupported entries (nested repository directory) are reported so they can never prove a fresh PASS", () => {
	const repo = makeRepo("unsupported");
	try {
		const nested = path.join(repo, "nested");
		fs.mkdirSync(nested);
		git(nested, "init", "-q");
		write(repo, "nested/inner.txt", "x\n");
		const result = fingerprint(repo);
		expect(result.unsupported.length).toBeGreaterThan(0);
		expect(result.records.some((r) => r.startsWith("UNSUPPORTED "))).toBe(true);
	} finally { cleanup(repo); }
});

test("an inspection failure other than confirmed absence is UNSUPPORTED, never a deletion (fault injection, no real ACL)", () => {
	const repo = makeRepo("fault");
	try {
		const fault = (code: string) => (): fs.Stats => { throw Object.assign(new Error(code), { code }); };
		const baseline = fingerprint(repo).value;
		for (const code of ["EACCES", "EIO", "EPERM", "UNKNOWN"]) {
			const result = fingerprint(repo, [], { lstat: fault(code), status: Buffer.from(" M protected.txt\0") });
			expect(result.unsupported).toEqual(["protected.txt"]);
			expect(result.records.some((r) => r.startsWith("deleted "))).toBe(false);
		}
		for (const code of ["ENOENT", "ENOTDIR"]) { // confirmed absence stays an ordinary deletion
			const result = fingerprint(repo, [], { lstat: fault(code), status: Buffer.from(" D protected.txt\0") });
			expect(result.unsupported).toEqual([]);
			expect(result.records).toEqual(["deleted protected.txt"]);
			expect(result.value).not.toBe(baseline);
		}
		const denied = fingerprint(repo, [], { lstat: fault("EACCES"), status: Buffer.from(" M protected.txt\0") });
		const absent = fingerprint(repo, [], { lstat: fault("ENOENT"), status: Buffer.from(" M protected.txt\0") });
		expect(denied.value).not.toBe(absent.value); // unknown can never share a digest with confirmed deletion
	} finally { cleanup(repo); }
});

test("a pathname containing a newline cannot impersonate two records; non-UTF-8 pathnames are UNSUPPORTED", () => {
	const repo = makeRepo("boundary");
	try {
		const absent = (): fs.Stats => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
		// Controlled status bytes: no illegal Windows filename is created.
		const two = fingerprint(repo, [], { lstat: absent, status: Buffer.from(" D a\0 D b\0") });
		const one = fingerprint(repo, [], { lstat: absent, status: Buffer.from(" D a\ndeleted b\0") });
		expect(two.records).toEqual(["deleted a", "deleted b"]);
		expect(one.records).toEqual(["deleted a\ndeleted b"]);
		expect(one.value).not.toBe(two.value);
		// Exclusion names and paths cannot collide either: an exclusion cannot be spoofed by a pathname.
		const withExclusion = fingerprint(repo, ["x"], { lstat: absent, status: Buffer.from("\0") });
		const spoof = fingerprint(repo, [], { lstat: absent, status: Buffer.from(" D \0") });
		expect(withExclusion.value).not.toBe(spoof.value);
		const bad = fingerprint(repo, [], { lstat: absent, status: Buffer.from([0x20, 0x44, 0x20, 0xff, 0xfe, 0]) });
		expect(bad.unsupported).toEqual(["hex:fffe"]);
		const bad2 = fingerprint(repo, [], { lstat: absent, status: Buffer.from([0x20, 0x44, 0x20, 0xff, 0xfd, 0]) });
		expect(bad2.value).not.toBe(bad.value); // distinct raw bytes are not folded into one replacement character
	} finally { cleanup(repo); }
});

// Capability probe in a disposable temp directory; no privilege bypass: without it the case is reported as skipped, not passed.
const canSymlink = (() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-probe-"));
	try { fs.symlinkSync("target", path.join(dir, "probe-link")); return true; } catch { return false; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();

test.skipIf(!canSymlink)("a symlink is recorded by its link text and never followed (skipped when symlink creation is not permitted)", () => {
	const repo = makeRepo("link");
	try {
		fs.symlinkSync("f.txt", path.join(repo, "ln"));
		const first = fingerprint(repo);
		expect(first.records).toContain(`link ln ${sha256("f.txt")}`);
		fs.rmSync(path.join(repo, "ln"));
		fs.symlinkSync("gone.txt", path.join(repo, "ln"));
		expect(fingerprint(repo).value).not.toBe(first.value);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fingerprint-outside-"));
		try {
			fs.rmSync(path.join(repo, "ln"));
			fs.symlinkSync(outside, path.join(repo, "ln"));
			write(outside, "secret.txt", "a\n");
			const before = fingerprint(repo).value;
			write(outside, "secret.txt", "b\n"); // target content outside the candidate is never traversed
			expect(fingerprint(repo).value).toBe(before);
		} finally { cleanup(outside); }
	} finally { cleanup(repo); }
});
