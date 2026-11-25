// Field report: a documentation worker wrote .block_tmp_check.txt in the checkout root and was interrupted; the file stayed untracked
// and the deletion guard refused the cleanup. A temporary-named write into the candidate is refused for every worker, with the task's
// _scratch folder named; the same write there runs, so an interrupted run leaves nothing new in the checkout.
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createGrantStore, guardToolCall } from "../safety-core.ts";

const slash = (p: string) => p.replace(/\\/g, "/");
function setup() {
	const base = slash(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "temp-cand-"))));
	const repo = `${base}/repo`;
	const scratch = `${base}/worktrees/repo/_scratch/docs-task`;
	fs.mkdirSync(repo);
	fs.mkdirSync(scratch, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "0" } });
	git("init", "-q");
	fs.writeFileSync(`${repo}/README.md`, "# x\n");
	git("add", "README.md");
	git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
	const agentDir = `${base}/agent`;
	fs.mkdirSync(agentDir);
	return { base, repo, scratch, git, agentDir };
}

test("a temporary-named write into the candidate is refused with the _scratch folder; the same write there runs and leaves the checkout clean", () => {
	const { repo, scratch, git, agentDir } = setup();
	const guard = { scope: "child" as const, store: createGrantStore(), agentDir };
	const refused: Array<[string, Record<string, unknown>]> = [
		["bash", { command: "echo check > .block_tmp_check.txt" }],
		["bash", { command: "npm test 2>&1 | tee test-output.tmp" }],
		["bash", { command: "cp README.md README.md.bak" }],
		["write", { path: `${repo}/tmp_probe.txt`, content: "x" }],
		["powershell", { command: "Set-Content -Path .\\temp_check.txt -Value x" }],
	];
	for (const [tool, input] of refused) {
		const r = guardToolCall(guard, tool, input, repo);
		assert.ok(r?.block, JSON.stringify(input));
		assert.match(r!.reason, /^Blocked by harness safety guard \[TEMP_IN_CANDIDATE\] op [0-9a-f]{16}: writes a temporary file into the candidate checkout \(/, JSON.stringify(input));
		assert.ok(r!.reason.includes(`write it in the task's _scratch folder by its literal absolute path (for this candidate: ${slash(path.dirname(path.dirname(scratch)))}/_scratch/<task>/)`), r!.reason);
	}
	// The same verification in the scratch folder is allowed; run it and stop without cleanup, as an interrupted worker would.
	const command = `echo check > ${scratch}/.block_tmp_check.txt`;
	assert.equal(guardToolCall(guard, "bash", { command }, repo), undefined);
	execFileSync("bash", ["-c", command], { cwd: repo });
	assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "no new untracked file in the checkout");
	assert.ok(fs.existsSync(`${scratch}/.block_tmp_check.txt`), "the leftover stays in the task scratch folder for cleanup");
	// Ordinary documentation writes in the candidate are unchanged.
	for (const [tool, input] of [["write", { path: `${repo}/docs/guide.md`, content: "x" }], ["bash", { command: "echo x > notes.md" }], ["write", { path: `${repo}/template.html`, content: "x" }]] as Array<[string, Record<string, unknown>]>) {
		assert.doesNotMatch(guardToolCall(guard, tool, input, repo)?.reason ?? "", /TEMP_IN_CANDIDATE/, JSON.stringify(input));
	}
});
