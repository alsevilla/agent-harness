// Guard block messages, the redacted .env read and artifact-folder creation at grant time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createGrantStore, guardToolCall, REDACTED_ENV_SCRIPT, REDACTED_ENV_SCRIPT_SHA256, redactedEnvRead, validateArtifactDir } from "../safety-core.ts";
import { redactEnv } from "../read-env-redacted.mjs";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "guard-msg-")));
const slash = (p: string) => p.replace(/\\/g, "/");
const cwd = slash(root);
const agentDir = slash(path.join(root, "agent"));
const main = { scope: "main" as const, store: createGrantStore(), agentDir };
const child = { scope: "child" as const, store: createGrantStore(), agentDir };
const reason = (g: typeof main | typeof child, command: string) => (guardToolCall(g, "bash", { command }, cwd) as { reason: string }).reason;

test("block messages name the rule, digest, program and grantability, never the arguments", () => {
	const r = reason(main, "rm -rf ./build-secret-abc123");
	assert.match(r, /^Blocked by harness safety guard \[DESTRUCTIVE_FS\] op [0-9a-f]{16}: rm; grantable: /);
	assert.match(r, /request_authorization; the approval must name this folder and the exact command text/);
	assert.ok(!r.includes("build-secret-abc123"), "no argument echo");
	assert.match(reason(child, "git push origin feat/x"), /git push; grantable: a worker receives only grants requested for its role and this folder before it was launched/);
});

test("non-grantable rules say so and give the next step", () => {
	const secret = reason(main, `cat ${cwd}/.env`);
	assert.match(secret, /\[SECRET\][^:]*: cat; not grantable: no approval unblocks this for an agent/);
	assert.ok(secret.includes(`node "${REDACTED_ENV_SCRIPT}" "<absolute .env path>"`), "points at the redacted read");
	assert.match(reason(main, "eval x"), /OPAQUE_UNPARSEABLE[\s\S]*write the script to a file in the task's _scratch folder/);
	const read = (guardToolCall(main, "read", { path: `${cwd}/.env` }, cwd) as { reason: string }).reason;
	assert.match(read, /read .*\/\.env; not grantable/);
});

test("redacted .env read: only the exact form with the pinned script is allowed", () => {
	const env = `${cwd}/.env`;
	fs.writeFileSync(env, "HEARTBEAT_SECONDS=30\nJWT_SECRET=abc\n");
	const ok = `node "${REDACTED_ENV_SCRIPT}" "${env}"`;
	assert.equal(redactedEnvRead("bash", { command: ok }), true);
	assert.equal(guardToolCall(child, "bash", { command: ok }, cwd), undefined);
	assert.equal(guardToolCall(main, "powershell", { command: ok }, cwd), undefined);
	for (const bad of [
		`node "${REDACTED_ENV_SCRIPT}" "${env}" extra`, `node "${REDACTED_ENV_SCRIPT}" ${env}`, `node "${cwd}/copy.mjs" "${env}"`,
		`node "${REDACTED_ENV_SCRIPT}" "${cwd}/secrets.json"`, `node "${REDACTED_ENV_SCRIPT}" "${env}" && cat "${env}"`, `cat "${env}"`,
	]) {
		assert.equal(redactedEnvRead("bash", { command: bad }), false, bad);
		if (bad.includes(".env")) assert.ok(guardToolCall(main, "bash", { command: bad }, cwd), `still blocked as SECRET: ${bad}`);
	}
	assert.equal(redactedEnvRead("read", { command: ok }), false, "only shell tools");
});

test("the pinned digest matches the shipped script", () => {
	const text = fs.readFileSync(REDACTED_ENV_SCRIPT).toString("latin1").replace(/\r\n/g, "\n");
	assert.equal(createHash("sha256").update(text, "latin1").digest("hex"), REDACTED_ENV_SCRIPT_SHA256);
});

test("redaction hides secret-like keys, URL credentials, generated values and commented-out secrets; plain settings stay", () => {
	const out = redactEnv([
		"CAPTURE_MODE=local", "LOCAL_READER_ALIASES=front,back", "HEARTBEAT_SECONDS=30", "API_KEY=\"xyz\"", "DB_PASSWORD=hunter2",
		"DATABASE_URL=postgres://u:p@h/db", "OPAQUE=Zm9vYmFyYmF6cXV4cXV1eHh5enp6enp6", "# KIOKOS_LOGIN=admin:pw", "# old Zm9vYmFyYmF6cXV4cXV1eHh5enp6enp6", "garbage line", "EMPTY=",
	].join("\n")).split("\n");
	assert.deepEqual(out, [
		"CAPTURE_MODE=local", "LOCAL_READER_ALIASES=front,back", "HEARTBEAT_SECONDS=30", "API_KEY=<redacted, 3 chars>", "DB_PASSWORD=<redacted, 7 chars>",
		"DATABASE_URL=<redacted, 19 chars>", "OPAQUE=<redacted, 32 chars>", "# KIOKOS_LOGIN=admin:pw", "# old <redacted>", "<unparsed line redacted>", "EMPTY=",
	]);
});

test("artifact folder: created at grant time inside the placement; never without create, never overlapping the candidate", () => {
	const candidate = slash(path.join(root, "proj", "app"));
	fs.mkdirSync(candidate, { recursive: true });
	const dir = slash(path.join(root, "proj", "worktrees", "app", "_evidence", "task-1"));
	assert.throws(() => validateArtifactDir(dir, candidate), /does not exist/);
	assert.equal(validateArtifactDir(dir, candidate, true), dir);
	assert.ok(fs.statSync(dir).isDirectory());
	assert.throws(() => validateArtifactDir(slash(path.join(root, "proj", "elsewhere")), candidate, true), /worktr/);
	assert.ok(!fs.existsSync(path.join(root, "proj", "elsewhere")), "nothing created outside the placement");
});

// Read-only roles: the child guard refuses changes to the candidate checkout, shell included; writes outside it stay allowed.
test("read-only role: writes into the candidate are refused (not grantable); reads, tests and evidence writes outside it pass", () => {
	const candidate = slash(path.join(root, "ro", "app"));
	fs.mkdirSync(candidate, { recursive: true });
	const evidence = slash(path.join(root, "ro", "worktrees", "app", "_evidence", "t"));
	const ro = { scope: "child" as const, store: createGrantStore(), agentDir, readOnlyRoot: candidate };
	const call = (command: string) => guardToolCall(ro, "bash", { command }, candidate) as { block: boolean; reason: string } | undefined;
	for (const ok of ["git status", "git diff --stat", "npm test", "npm test 2>&1", `npm test > "${evidence}/test.log"`, `cat > "${evidence}/REPORT.md"`, "sed -n 1,5p a.ts", "git stash list"]) assert.equal(call(ok), undefined, ok);
	for (const bad of ["npm test > out.log", "git commit -m x", "git checkout -- a.ts", "sed -i s/a/b/ a.ts", "cp a.ts b.ts", "echo x | tee a.ts", "npm install x", 'bash -c "echo x > a.ts"', "mkdir tmp"]) {
		const r = call(bad);
		assert.ok(r?.block, bad);
		assert.match(r!.reason, /^Blocked by harness safety guard \[READ_ONLY_ROLE\] op [0-9a-f]{16}: .*; not grantable: this role is read-only/, bad);
	}
	assert.ok((guardToolCall(ro, "edit", { path: `${candidate}/a.ts` }, candidate) as any)?.block, "edit tool inside the candidate");
	assert.equal(guardToolCall(ro, "write", { path: `${evidence}/notes.md` }, candidate), undefined, "write tool outside the candidate");
	const writer = { scope: "child" as const, store: createGrantStore(), agentDir };
	assert.equal(guardToolCall(writer, "bash", { command: "npm test > out.log" }, candidate), undefined, "a writing role is unaffected");
});

// Claude Code practices: read before edit, and no approval for a delete it cannot resolve.
test("read before edit: a worker edits or overwrites an existing file only after reading it in this run; new files are fine", () => {
	const dir = slash(path.join(root, "rbe"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(`${dir}/a.ts`, "x\n");
	const g = { scope: "child" as const, store: createGrantStore(), agentDir, reads: new Set<string>() };
	const r = guardToolCall(g, "edit", { path: "a.ts" }, dir) as { block: boolean; reason: string };
	assert.ok(r?.block);
	assert.match(r.reason, /^Blocked by harness safety guard \[READ_BEFORE_EDIT\] op [0-9a-f]{16}: edit .*a\.ts; read this file with the read tool in this run first/);
	assert.ok((guardToolCall(g, "write", { path: `${dir}/a.ts` }, dir) as any)?.block, "overwrite counts too");
	assert.equal(guardToolCall(g, "write", { path: `${dir}/new.ts` }, dir), undefined, "a new file needs no read");
	assert.equal(guardToolCall(g, "read", { path: "a.ts" }, dir), undefined);
	assert.equal(guardToolCall(g, "edit", { path: `${dir}/a.ts` }, dir), undefined, "relative read and absolute edit are the same file");
	assert.equal(guardToolCall({ scope: "child" as const, store: createGrantStore(), agentDir }, "edit", { path: `${dir}/a.ts` }, dir), undefined, "only guards that track reads enforce it");
});

test("a delete it cannot resolve is never grantable; an exact target stays grantable", () => {
	for (const bad of ["rm -rf $DIR/", "rm -rf /", "rm -rf ~", "rm -rf .", "rm -rf *", "Remove-Item -LiteralPath $env:TMP -Recurse -Force", "rd /s /q %TEMP%", "rm -rf `pwd`"]) {
		const r = reason(main, bad);
		assert.match(r, /PATH_AMBIGUOUS/, bad);
		assert.match(r, /not grantable/, bad);
		assert.match(r, /a delete never takes a variable, substitution, root, home/, bad);
	}
	for (const ok of ["rm -rf build", 'rm -rf "/w/worktrees/app/_scratch/t"']) assert.match(reason(main, ok), /\[DESTRUCTIVE_FS\][^:]*: rm; grantable/, ok);
});
test("read before edit never hides a secret or config refusal", () => {
	const dir = slash(path.join(root, "rbe2"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(`${dir}/.env`, "X=1\n");
	const g = { scope: "child" as const, store: createGrantStore(), agentDir, reads: new Set<string>() };
	assert.match((guardToolCall(g, "write", { path: `${dir}/.env` }, dir) as any).reason, /\[SECRET\]/);
});

// User permission rules: <agent dir>/harness-permissions.json (user-written only).
test("user permission rules: allow only what an operator could approve; deny blocks for everyone; agents cannot write the file", () => {
	const dir = slash(path.join(root, "perm-agent"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "harness-permissions.json"), JSON.stringify({ allow: ["Stop-Process -Id *", "rm -rf build", "cat .env", "gh pr merge *"], deny: ["git push --force*"] }));
	const g = { scope: "main" as const, store: createGrantStore(), agentDir: dir };
	const run = (command: string, tool = "bash") => guardToolCall(g, tool, { command }, cwd) as { block: boolean; reason: string } | undefined;
	assert.equal(run("Stop-Process -Id 14236 -ErrorAction Stop", "powershell"), undefined, "prefix allow for a grantable rule");
	assert.equal(run("rm -rf  build"), undefined, "exact allow, whitespace collapsed");
	assert.ok(run("rm -rf dist")?.block, "not listed");
	assert.match(run("cat .env")!.reason, /\[SECRET\]/, "an allow never covers a non-grantable rule");
	assert.match(run("rm -rf $DIR")!.reason, /PATH_AMBIGUOUS/, "nor an unresolvable delete");
	assert.ok(run("gh pr merge 12 --squash")?.block, "merge keeps its own approval");
	assert.match(run("git push --force origin main")!.reason, /^Blocked by harness safety guard \[USER_DENY\] op [0-9a-f]{16}: git; not grantable: it matches a deny rule/);
	assert.equal(run("git status"), undefined);
	assert.match((guardToolCall(g, "write", { path: path.join(dir, "harness-permissions.json") }, cwd) as any).reason, /CONFIG_WRITE/, "agents cannot write the rules");
	assert.match(run(`echo '{}' > "${dir}/harness-permissions.json"`)!.reason, /CONFIG_WRITE/);
	const none = { scope: "main" as const, store: createGrantStore(), agentDir: slash(path.join(root, "no-perm")) };
	assert.ok((guardToolCall(none, "powershell", { command: "Stop-Process -Id 1" }, cwd) as any)?.block, "no file: no allows");
});
