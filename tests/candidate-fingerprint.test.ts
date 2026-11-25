// Field report: QA reported a backend diff hash mismatch with only "cb5b…" and no command; a follow-up reproduced the tested hash from
// raw Git diff bytes in Git Bash and Python, and the source of cb5b… was never found. verify/index.md now has one canonical procedure:
// Git writes the diff to a file and hashes it, so no shell pipe touches the bytes. This test runs the procedure's own commands.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const procedure = readProcedure();
function readProcedure() {
	const text = readFileSync(new URL("../agent/skills/engineering-harness/verify/index.md", import.meta.url), "utf8");
	const section = text.slice(text.indexOf("## Candidate fingerprint"), text.indexOf("## Refusal and failure routing"));
	const diff = /`(git diff --binary [^`]+)`/.exec(section)?.[1];
	const hash = /`(git hash-object --no-filters [^`]+)`/.exec(section)?.[1];
	assert.ok(diff && hash, "verify/index.md names both fingerprint commands");
	return { section, diff: diff!, hash: hash! };
}

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "fingerprint-"));
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "api.ts"), "export const a = 1;\n");
	writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 1, 2, 255]));
	git(dir, "add", "."); git(dir, "commit", "-qm", "base");
	git(dir, "checkout", "-qb", "feat");
	writeFileSync(join(dir, "api.ts"), "export const a = 2;\r\nexport const b = 3;\n"); // a CRLF line survives as bytes
	writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 1, 2, 254, 7]));
	git(dir, "commit", "-qam", "change");
	return dir;
}
/** The procedure's commands with its placeholders filled, as argv (they hold no shell syntax beyond the quoted path). */
function commands(dir: string, out: string) {
	const fill = (t: string) => t.replace(/"<absolute _scratch\/<task>\/candidate\.diff>"/, out).replace("<base>", "main").replace("<paths>", ".");
	const argv = (t: string) => fill(t).split(" ").slice(1);
	return { diff: argv(procedure.diff), hash: argv(procedure.hash), line: `${fill(procedure.diff).replace(out, `"${out}"`)} && ${fill(procedure.hash).replace(out, `"${out}"`)}` };
}
const digestDirect = (dir: string, out: string) => { const c = commands(dir, out); git(dir, ...c.diff); return git(dir, ...c.hash); };
const digestShell = (shell: string, dir: string, out: string) => execFileSync(shell, ["-c", commands(dir, out).line], { cwd: dir, env, encoding: "utf8" }).trim();
function digestPython(dir: string, out: string) {
	const c = commands(dir, out);
	const r = spawnSync("python3", ["-I", "-c", "import subprocess,sys,json;a=json.loads(sys.argv[1]);subprocess.run(['git',*a['d']],check=True);print(subprocess.run(['git',*a['h']],check=True,capture_output=True,text=True).stdout.strip())", JSON.stringify({ d: c.diff, h: c.hash })], { cwd: dir, env, encoding: "utf8" });
	return r.error ? undefined : r.stdout.trim();
}

test("the canonical procedure gives one full digest whichever shell runs it, and a real change gives another", () => {
	const dir = repo();
	const outs = mkdtempSync(join(tmpdir(), "fingerprint-out-"));
	const out = (n: number) => join(outs, `candidate-${n}.diff`);
	try {
		const direct = digestDirect(dir, out(1));
		assert.match(direct, /^[0-9a-f]{40}$/, "a full 40-character digest");
		assert.equal(digestShell("bash", dir, out(2)), direct, "bash");
		assert.equal(digestShell("sh", dir, out(3)), direct, "sh");
		const python = digestPython(dir, out(4));
		if (python !== undefined) assert.equal(python, direct, "python");
		// The pipe the procedure rules out: the same diff through a shell pipe with CRLF added (PowerShell's piped text) hashes differently.
		const piped = execFileSync("bash", ["-c", "git diff main...HEAD -- . | sed 's/$/\\r/' | git hash-object --stdin"], { cwd: dir, env, encoding: "utf8" }).trim();
		assert.notEqual(piped, direct, "premise: re-encoded pipe bytes change the digest");

		writeFileSync(join(dir, "api.ts"), "export const a = 2;\r\nexport const b = 4;\n");
		assert.notEqual(git(dir, "status", "--porcelain", "--", "."), "", "an uncommitted change makes the scope dirty (step 1)");
		git(dir, "commit", "-qam", "another change");
		assert.notEqual(digestDirect(dir, out(5)), direct, "a real file change gives a different digest");
	} finally { rmSync(dir, { recursive: true, force: true }); rmSync(outs, { recursive: true, force: true }); }
});

test("reports carry the candidate HEAD, the diff scope, the exact commands and the full digest", () => {
	const s = procedure.section.replace(/\s+/g, " ");
	assert.ok(s.includes("Report all four: the candidate HEAD (`git rev-parse HEAD`), the diff scope (`<base>...HEAD -- <paths>`), the exact commands, and the full 40-character digest, never a prefix."));
	assert.ok(s.includes("`git status --porcelain -- <paths>` must be empty"));
	assert.ok(readFileSync(new URL("../agent/skills/engineering-harness/review/index.md", import.meta.url), "utf8").includes("`../verify/index.md` \"Candidate fingerprint\""), "review points to the same procedure");
});
