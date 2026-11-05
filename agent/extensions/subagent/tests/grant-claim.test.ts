// Field report: an approved `Stop-Process -Id 51552 -ErrorAction Stop` for general-worker was refused in the worker that main launched
// next in the same folder. The launch-time claim compared folders case-sensitively while every other check folds case on Windows and
// macOS, and the refusal could not say why no approval arrived. Approvals now reach the worker once, and a launch that carries none
// tells the worker why.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { foldsCase } from "../path-case.ts";
import { authorizableOp, CHILD_GRANT_ENV, CHILD_GRANT_NOTE_ENV, claimChildGuard, createGrantStore, guardToolCall, loadChildGrants } from "../safety-core.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "grant-claim-")));
const folder = path.join(root, "RFIDAttendance-Rust");
const other = path.join(root, "worktrees");
fs.mkdirSync(folder);
fs.mkdirSync(other);
const agentDir = path.join(root, "agent");
const guardFile = path.join(root, "guard.ts");
fs.writeFileSync(guardFile, "");
const STOP = "Stop-Process -Id 51552 -ErrorAction Stop";

function launch(store: ReturnType<typeof createGrantStore>, role: string, cwd: string, window = { open: true } as { open: boolean; claimed?: number }) {
	const env = claimChildGuard(store, role, cwd, guardFile, window).childEnv({});
	const child = createGrantStore();
	if (env[CHILD_GRANT_ENV]) child.importRecords(loadChildGrants(env[CHILD_GRANT_ENV]!));
	const run = () => guardToolCall({ scope: "child", store: child, agentDir, grantNote: env[CHILD_GRANT_NOTE_ENV] }, "powershell", { command: STOP }, cwd) as { reason: string } | undefined;
	return { env, run };
}
const mint = (store: ReturnType<typeof createGrantStore>, role: string | null, cwd: string) => store.mint({ role, candidate: cwd, ops: [authorizableOp("shell", STOP, cwd, agentDir)] });

test("an approved PowerShell process stop reaches the next worker in that folder and runs once", () => {
	const store = createGrantStore();
	assert.match(guardToolCall({ scope: "main", store, agentDir }, "powershell", { command: STOP }, folder)?.reason ?? "", /\[PROC_KILL\]/, "premise: blocked without approval");
	mint(store, "general-worker", folder);
	const w = launch(store, "general-worker", folder);
	assert.equal(w.run(), undefined, "the approved command runs");
	assert.match(w.run()?.reason ?? "", /already approved and that approval was used/, "single use");
	assert.equal(store.size(), 0, "claimed by the launch");
});

test("on Windows and macOS the folder matches whatever its letter case (emulated where the host is case-sensitive)", () => {
	const real = Object.getOwnPropertyDescriptor(process, "platform")!;
	if (!foldsCase()) Object.defineProperty(process, "platform", { value: "win32" });
	try {
		const store = createGrantStore();
		mint(store, "general-worker", folder.toUpperCase());
		assert.equal(launch(store, "general-worker", folder).run(), undefined, "a grant minted as C:\\WORK\\APP reaches a launch in C:\\Work\\App");
	} finally { Object.defineProperty(process, "platform", real); }
});

test("a launch that receives no approval says why: another folder, another role, or a fallback attempt", () => {
	const elsewhere = createGrantStore();
	mint(elsewhere, "general-worker", other);
	const a = launch(elsewhere, "general-worker", folder).run()?.reason ?? "";
	assert.ok(a.includes(`At launch: main holds an approval for general-worker in folder ${other}, but this worker was launched in ${folder}`), a);
	assert.equal(elsewhere.size(), 1, "the other folder's approval stays for its own launch");

	const otherRole = createGrantStore();
	mint(otherRole, "platform-worker", folder);
	assert.match(launch(otherRole, "general-worker", folder).run()?.reason ?? "", /At launch: main holds an approval for this folder bound to role platform-worker, not general-worker/);
	const mainOnly = createGrantStore();
	mint(mainOnly, null, folder);
	assert.match(launch(mainOnly, "general-worker", folder).run()?.reason ?? "", /bound to main, not general-worker/);

	const job = createGrantStore();
	mint(job, "general-worker", folder);
	const window = { open: true };
	launch(job, "general-worker", folder, window);
	assert.match(launch(job, "general-worker", folder, window).run()?.reason ?? "", /retry or fallback attempt of the job, and its single-use approvals went to the first attempt/);

	assert.match(launch(createGrantStore(), "general-worker", folder).run()?.reason ?? "", /This worker was launched with no approved operations\./);
});

// Field report: a release-engineer's multi-line `git commit -m` was refused with the commit-form rule (correct: use -F) plus "This worker
// was launched with no approved operations", which suggested an approval the commit never needs. The note now follows only refusals
// that an approval can unblock.
test("a commit-form refusal carries no launch note about approvals; a grantable refusal still does", () => {
	const store = createGrantStore();
	const commit = 'git commit -m "feat(sms): pace shared sender submissions\n\nAvoid queued SMS bursts.\n\nCo-Authored-By: Claude <noreply@anthropic.com>"';
	const refused = guardToolCall({ scope: "child", store, agentDir, gateCommits: true }, "bash", { command: commit }, folder) as { reason: string };
	assert.match(refused.reason, /\[GIT_COMMIT\][^:]*: not a normal commit form: use git commit -m "<text>" or git commit -F "<absolute \.md\/\.txt file>"/);
	assert.doesNotMatch(refused.reason, /approved operations|At launch/);
	assert.match(launch(store, "general-worker", folder).run()?.reason ?? "", /This worker was launched with no approved operations\./, "grantable refusals keep it");
});
