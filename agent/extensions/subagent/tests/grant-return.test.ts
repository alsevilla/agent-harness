// Field report (sms-live-retry): main approved a PowerShell backend cleanup for test-engineer. The first worker (bash) was refused for
// syntax before it reached the approved command, but its launch had already claimed the approval; the PowerShell retry launched with
// none and was refused as PROC_KILL. An approval a worker did not use now returns to main when that worker exits, and a launch that
// gets nothing says whether another running worker holds it or an earlier one used it. Unapproved stops stay refused.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { authorizableOp, CHILD_GRANT_ENV, CHILD_GRANT_NOTE_ENV, claimChildGuard, createGrantStore, GRANT_USED_PREFIX, guardToolCall, loadChildGrants } from "../safety-core.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "grant-return-")));
const folder = path.join(root, "RFIDAttendance-Rust");
fs.mkdirSync(folder);
const agentDir = path.join(root, "agent");
const guardFile = path.join(root, "guard.ts");
fs.writeFileSync(guardFile, "");
const STOP = "Get-Process rfid-attendance -ErrorAction SilentlyContinue | Stop-Process -Force";
const ROLE = "test-engineer";

type Store = ReturnType<typeof createGrantStore>;
// One worker launch the way index.ts does it: claim at launch, lend to the holder, run the child guard, return unused at exit.
function launch(store: Store, holder: string) {
	const guard = claimChildGuard(store, ROLE, folder, guardFile, { open: true });
	if (guard.claimed.length) store.lend?.(holder, guard.claimed);
	const env = guard.childEnv({});
	const child = createGrantStore();
	if (env[CHILD_GRANT_ENV]) child.importRecords(loadChildGrants(env[CHILD_GRANT_ENV]!));
	const run = (tool: string, command: string) => guardToolCall({ scope: "child", store: child, agentDir, grantNote: env[CHILD_GRANT_NOTE_ENV] }, tool, { command }, folder) as { reason: string } | undefined;
	const exit = () => store.returnLent?.(holder, new Set(child.spentIds?.() ?? []));
	return { guard, run, exit };
}
const approve = (store: Store, command = STOP, ttlMs?: number) => store.mint({ role: ROLE, candidate: folder, ops: [authorizableOp("shell", command, folder, agentDir)], ttlMs });

test("an approval the first worker did not use returns to main and reaches the retry", () => {
	const store = createGrantStore();
	approve(store);
	const bash = launch(store, "bg-2");
	assert.equal(bash.guard.grantCount, 1, "premise: the first launch claims it");
	assert.match(bash.run("bash", "pgrep rfid | xargs kill")?.reason ?? "", /\[PROC_KILL\]/, "a different command is not the approved one");
	assert.equal(bash.exit(), 1, "returned at exit");
	const ps = launch(store, "bg-3");
	assert.equal(ps.guard.grantCount, 1);
	assert.equal(ps.run("powershell", STOP), undefined, "the approved cleanup runs");
	assert.match(ps.run("powershell", STOP)?.reason ?? "", /already approved and that approval was used/, "still single use");
	ps.exit();
	assert.equal(store.size(), 0, "a used approval does not come back");
});

test("the approval matches the command text and folder, not the shell tool", () => {
	const store = createGrantStore();
	approve(store);
	assert.equal(launch(store, "w").run("bash", STOP), undefined, "approved text through bash");
});

test("a launch that gets nothing says why: held by a running worker, or used by an earlier one", () => {
	const store = createGrantStore();
	approve(store);
	const first = launch(store, "bg-2");
	const second = launch(store, "bg-3");
	assert.match(second.run("powershell", STOP)?.reason ?? "", /held by another test-engineer worker that is still running; it returns to main if that worker exits without using it/);
	assert.equal(first.run("powershell", STOP), undefined);
	first.exit();
	second.exit();
	assert.match(launch(store, "bg-4").run("powershell", STOP)?.reason ?? "", /an earlier test-engineer worker in this folder used main's approval; approvals are single use/);
});

test("an approval that expired while lent does not come back", () => {
	let t = 1_000_000;
	const store = createGrantStore(() => t);
	approve(store, STOP, 60_000);
	const w = launch(store, "bg-2");
	t += 61_000;
	assert.equal(w.exit(), 0);
	assert.equal(store.size(), 0);
});

test("an unapproved stop is still refused, before and after an unused approval returns", () => {
	const store = createGrantStore();
	assert.match(launch(store, "a").run("powershell", STOP)?.reason ?? "", /\[PROC_KILL\]/, "no approval");
	approve(store);
	const w = launch(store, "b");
	assert.match(w.run("powershell", "Stop-Process -Name explorer -Force")?.reason ?? "", /\[PROC_KILL\]/, "another target");
	w.exit();
	assert.match(launch(store, "c").run("powershell", "Stop-Process -Name explorer -Force")?.reason ?? "", /\[PROC_KILL\]/);
});

test("wiring: the child reports each used approval before the tool runs, fails closed, and main returns the rest at exit", () => {
	const entry = fs.readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /ctx\.ui\.notify\(GRANT_USED_PREFIX \+ spent\[announced\]/);
	assert.match(entry, /catch \{ announced = spent\.length; return \{ block: true/, "a used approval that cannot be reported blocks the call");
	const main = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(main, /safetyGrants\.lend\?\.\(ownerId, guard\.claimed\)/);
	assert.match(main, /event\.message\.startsWith\(GRANT_USED_PREFIX\)/);
	assert.match(main, /safetyGrants\.returnLent\?\.\(ownerId, grantsUsed\)/);
	assert.ok(main.indexOf("returnLent?.(ownerId") < main.indexOf("owners.end(ownerId)"), "returned in the finally before the owner ends");
	assert.equal(GRANT_USED_PREFIX.endsWith(" "), true);
});
