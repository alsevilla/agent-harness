// Field report (RFIDAttendance-Rust PR #75): the release engineer's after-delivery check reported FAIL because
// `git rev-list --count @{u}..HEAD` was 1, though HEAD matched the published feature branch and the PR head. The branch had
// been created from origin/main, so its upstream was origin/main and every published commit counted as unpushed. The ship
// procedure now checks against the PR's head branch. This test runs the procedure's own commands on real repositories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const procedure = readFileSync(new URL("../agent/skills/engineering-harness/ship/index.md", import.meta.url), "utf8").replace(/\s+/g, " ");
const COUNT = "git rev-list --count origin/<headRefName>..HEAD";
const FETCH = "git fetch origin <headRefName>";
const UPSTREAM = "git rev-parse --abbrev-ref --symbolic-full-name @{u}";
for (const command of [COUNT, FETCH, UPSTREAM, "git rev-parse HEAD", "--json headRefName,headRefOid"]) assert.ok(procedure.includes(command), `ship/index.md names ${command}`);

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd: string, template: string, headRefName: string) => git(cwd, ...template.replace("<headRefName>", headRefName).split(" ").slice(1));

/** The procedure's check: the PR head (headRefName, headRefOid) against local HEAD; the upstream is only a note. */
function afterDelivery(cwd: string, pr: { headRefName: string; headRefOid: string }) {
	run(cwd, FETCH, pr.headRefName);
	const unpushed = Number(run(cwd, COUNT, pr.headRefName));
	const head = git(cwd, "rev-parse", "HEAD");
	const upstream = git(cwd, ...UPSTREAM.split(" ").slice(1));
	return { pass: unpushed === 0 && head === pr.headRefOid, unpushed, matchesPrHead: head === pr.headRefOid, upstreamNote: upstream === `origin/${pr.headRefName}` ? undefined : upstream };
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "after-delivery-"));
	const origin = join(dir, "origin.git"), work = join(dir, "work");
	git(dir, "init", "--bare", "-b", "main", origin);
	git(dir, "clone", origin, work);
	writeFileSync(join(work, "a.txt"), "base\n");
	git(work, "add", "a.txt"); git(work, "commit", "-m", "base"); git(work, "push", "origin", "main");
	git(work, "checkout", "-b", "feat/x", "origin/main"); // tracks origin/main, as in the field report
	writeFileSync(join(work, "a.txt"), "change\n");
	git(work, "commit", "-am", "change"); git(work, "push", "origin", "feat/x"); // pushed without changing the upstream
	const pr = () => ({ headRefName: "feat/x", headRefOid: git(origin, "rev-parse", "refs/heads/feat/x") });
	return { dir, origin, work, pr };
}

test("a branch that tracks origin/main passes when HEAD matches the published PR head; the upstream is only noted", () => {
	const { dir, work, pr } = setup();
	try {
		assert.equal(git(work, "rev-list", "--count", "@{u}..HEAD"), "1", "premise: the old @{u} check reports one unpushed commit");
		assert.deepEqual(afterDelivery(work, pr()), { pass: true, unpushed: 0, matchesPrHead: true, upstreamNote: "origin/main" });
		assert.equal(git(work, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), "origin/main", "the check changes no Git configuration");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delivery still fails with an unpublished local commit, or when HEAD does not match the PR head", () => {
	const { dir, origin, work, pr } = setup();
	try {
		writeFileSync(join(work, "a.txt"), "local only\n");
		git(work, "commit", "-am", "local only");
		const ahead = afterDelivery(work, pr());
		assert.equal(ahead.pass, false); assert.equal(ahead.unpushed, 1); assert.equal(ahead.matchesPrHead, false);

		git(work, "push", "origin", "feat/x");
		git(work, "reset", "--hard", "HEAD~1"); // nothing unpushed, but the PR head has moved past local HEAD
		const behind = afterDelivery(work, pr());
		assert.equal(behind.unpushed, 0); assert.equal(behind.matchesPrHead, false); assert.equal(behind.pass, false);
		assert.notEqual(pr().headRefOid, git(work, "rev-parse", "HEAD"), String(origin));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
