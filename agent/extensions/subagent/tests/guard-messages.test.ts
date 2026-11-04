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
