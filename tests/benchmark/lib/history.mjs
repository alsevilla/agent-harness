// Validates every manifest task against candidate git history BEFORE any benchmark run: commit/parent/subject identity,
// declared-vs-changed harness files, and objective acceptance: RED on the parent state (with the post-task held-out tests
// copied in), GREEN on the commit state. Runs ordinary node tests in scratch only; no provider or Pi session is started.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { HARNESS_ROOTS } from "./manifest.mjs";
import { listHarnessPaths, materializeHarness, readBlobs, writeCommitFiles } from "./workspace.mjs";
import { runAcceptance } from "./acceptance.mjs";

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const resolveCommit = (repo, ref) => git(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);

export function validateHistory({ manifest, repo, scratchRoot, acceptance = runAcceptance }) {
	const tasks = [];
	for (const t of manifest.tasks) {
		const problems = [];
		const row = { id: t.id, commit: t.commit, parent: t.parent, problems, red: null, green: null };
		try {
			const commit = resolveCommit(repo, t.commit);
			const parent = resolveCommit(repo, t.parent);
			if (resolveCommit(repo, `${commit}^`) !== parent) problems.push("parent is not the first parent of the commit");
			if (git(repo, "log", "-1", "--format=%s", commit) !== t.subject) problems.push("subject does not match the commit");
			const changed = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit, "--", ...HARNESS_ROOTS).split("\n").filter(Boolean).sort();
			const declared = new Set([...t.allowedFiles, ...t.acceptanceTests]);
			row.undeclaredChanges = changed.filter((p) => !declared.has(p));
			row.declaredNotChanged = t.allowedFiles.filter((p) => !changed.includes(p));
			if (row.undeclaredChanges.length) problems.push(`harness files changed by the commit but not declared: ${row.undeclaredChanges.join(", ")}`);
			if (row.declaredNotChanged.length) problems.push(`declared allowed files not changed by the commit: ${row.declaredNotChanged.join(", ")}`);
			const parentPaths = new Set(listHarnessPaths({ repo, commit: parent }));
			row.acceptanceAtParent = Object.fromEntries(t.acceptanceTests.map((p) => [p, parentPaths.has(p)]));
			readBlobs({ repo, commit, paths: t.acceptanceTests });
			const scratch = path.join(scratchRoot, t.id);
			const redDir = path.join(scratch, "parent-with-held-out");
			const redTree = materializeHarness({ repo, commit: parent, dest: redDir, scratchRoot });
			row.excludedRfidNamed = redTree.excludedRfidNamed;
			writeCommitFiles({ repo, commit, paths: t.acceptanceTests, dest: redDir, scratchRoot });
			row.red = acceptance({ cwd: redDir, files: t.acceptanceTests, runner: t.acceptanceRunner ?? "node" });
			const greenDir = path.join(scratch, "commit");
			const greenTree = materializeHarness({ repo, commit, dest: greenDir, scratchRoot });
			row.excludedRfidNamedGreen = greenTree.excludedRfidNamed;
			row.green = acceptance({ cwd: greenDir, files: t.acceptanceTests, runner: t.acceptanceRunner ?? "node" });
			if (row.green.accepted !== true) problems.push(`GREEN failed: the commit state does not pass its acceptance tests (${row.green.reason ?? ""})`);
			if (row.red.accepted === true) problems.push("RED passed: the parent state with held-out tests shows no regression");
		} catch (e) {
			problems.push(`validation error: ${e.message}`);
		}
		tasks.push(row);
	}
	return { ok: tasks.every((t) => t.problems.length === 0), tasks };
}
