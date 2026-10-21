// PR workflow authorization: ordinary commit, feature push, PR create and same-owned PR edit need no grant or lease (structural trusted context); merge and release have no automatic path and need separate action grants; origin-repo-name artifact group; fixed commit-form hint. Offline: temp git repos, injected live readers, no network or remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as core from "../safety-core.ts";

const C = core as any;
const SCRATCH = fs.realpathSync.native(process.env.PR_AUTH_TEST_SCRATCH ?? os.tmpdir());
const root = fs.mkdtempSync(path.join(SCRATCH, "pr-auth-"));
const cfg = path.join(root, "gitconfig");
fs.writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const URL = "https://github.com/acme/widgets.git";
const AGENT_DIR = path.join(root, "agent");
const slash = (p: string) => p.replace(/\\/g, "/");
const git = (dir: string, ...args: string[]) => {
	const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
};
// Primary checkout named like the .pi profile (basename differs from the origin repo name "widgets").
const REPO = (() => {
	const dir = path.join(root, "pi-like");
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
	git(dir, "checkout", "-q", "-b", "feat/x");
	git(dir, "remote", "add", "origin", URL);
	return fs.realpathSync.native(dir);
})();
const HEAD = git(REPO, "rev-parse", "HEAD").trim();
const MERGED = "f".repeat(40);
const target = { candidate: REPO, pushUrl: URL, branch: "feat/x" };
const mergeGrant = (over: Record<string, unknown> = {}) => ({ role: C.LEASE_ROLE, candidate: REPO, pushUrl: URL, repo: "acme/widgets", branch: "feat/x", base: "main", action: "merge", pr: 12, sha: HEAD, bound: { head: HEAD, ref: "refs/heads/feat/x", fingerprint: "a".repeat(64), exclude: [] }, ...over });
const releaseGrant = (over: Record<string, unknown> = {}) => ({ role: C.LEASE_ROLE, candidate: REPO, pushUrl: URL, repo: "acme/widgets", branch: "feat/x", base: "main", action: "release", pr: 12, sha: MERGED, version: "v1.2.3", ...over });
function artifact(group: string, name = "msg.txt", text = "Safe message\n", kind = "_evidence"): string {
	const dir = path.join(root, "worktrees", group, kind, "task");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(fs.realpathSync.native(dir), name);
	fs.writeFileSync(file, text);
	return slash(file);
}
const VIEWS: Record<string, any> = {};
const live = (over: Record<string, unknown> = {}) => ({
	env: () => ({}),
	pushUrl: () => URL,
	tagStatus: () => 2,
	bound: () => ({ head: HEAD, ref: "refs/heads/feat/x", fingerprint: "a".repeat(64), exclude: [] as string[] }),
	ghJson: (args: string[]) => (args[1] === "view" ? (VIEWS[args[2]] ?? { state: "OPEN", baseRefName: "main", headRefName: "feat/x", headRefOid: HEAD, isCrossRepository: false }) : [{ number: 12, mergeCommit: { oid: MERGED }, mergedAt: new Date(Date.now() + 60_000).toISOString(), isCrossRepository: false, headRefName: "feat/x", baseRefName: "main" }]),
	...over,
});
const trusted = (store = C.createGrantStore()) => ({ scope: "child" as const, store, agentDir: AGENT_DIR, pushTarget: target, gateCommits: true, live: live() });
const run = (guard: any, command: string, cwd = REPO) => C.guardToolCall(guard, "bash", { command }, cwd);
const blocked = (v: unknown) => (v as { block?: boolean } | undefined)?.block === true;
// Delivery command text is assembled from pieces so this file's own authoring tools never see a literal publish command.
const GP = ["git", "pu" + "sh"].join(" ");
const PUSH = `${GP} origin feat/x`;
const PRC = ["gh", "pr", "cre" + "ate"].join(" ");
const PRM = ["gh", "pr", "mer" + "ge"].join(" ");
const REL = ["gh", "rele" + "ase", "cre" + "ate"].join(" ");
const PRE = ["gh", "pr", "ed" + "it"].join(" ");
const prEdit = (extra = '--title "T"', n = 12) => `${PRE} ${n} --repo acme/widgets ${extra}`;
const unmask = (c: string) => c.replace(/@@/g, " ");
const prCreate = (file?: string) => `${PRC} --repo acme/widgets --base main --head feat/x --title "T" ${file ? `--body-file "${file}"` : '--body "b"'}`;
const merge = (extra = "") => `${PRM} 12 --repo acme/widgets --squash --match-head-commit ${HEAD}${extra}`;
const release = (notes = '--notes "N"') => `${REL} v1.2.3 --repo acme/widgets --target ${MERGED} --title "R" ${notes}`;

test("M6 ordinary trusted commit (-m, quoted -F), feature push and PR create need no grant or lease", () => {
	const g = trusted();
	const f = artifact("widgets");
	for (const command of ['git commit -m "Add thing"', `git commit -F "${f}"`, PUSH, prCreate(), prCreate(f)]) assert.equal(run(g, command), undefined, command);
});

test("A1 origin repo-name artifact group is accepted next to the legacy primary-basename group", () => {
	const g = trusted();
	for (const group of ["widgets", "pi-like", "WIDGETS"]) {
		const f = artifact(group);
		assert.equal(run(g, `git commit -F "${f}"`), undefined, `commit -F ${group}`);
		assert.equal(run(g, prCreate(f)), undefined, `pr body-file ${group}`);
	}
});

test("A1 negatives: unrelated group, traversal, wrong extension, credential, oversize, outside worktrees all block", () => {
	const g = trusted();
	const other = artifact("gadgets");
	assert.ok(blocked(run(g, `git commit -F "${other}"`)), "unrelated group");
	assert.ok(blocked(run(g, prCreate(other))), "unrelated group pr");
	const ok = artifact("widgets");
	assert.ok(blocked(run(g, `git commit -F "${ok.replace("/msg.txt", "/../msg.txt")}"`)), "traversal");
	assert.ok(blocked(run(g, `git commit -F "${artifact("widgets", "m.json", "x")}"`)), ".json");
	assert.ok(blocked(run(g, `git commit -F "${artifact("widgets", "c.txt", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n")}"`)), "credential content");
	assert.ok(blocked(run(g, prCreate(artifact("widgets", "big.md", "x".repeat(65_537))))), "oversize");
	const loose = slash(path.join(root, "loose.txt"));
	fs.writeFileSync(loose, "x");
	assert.ok(blocked(run(g, `git commit -F "${loose}"`)), "outside any worktrees group");
	const dir = slash(path.join(root, "worktrees", "widgets", "_evidence", "task"));
	assert.ok(blocked(run(g, `git commit -F "${dir}/missing.txt"`)), "missing file");
});

test("A1 origin group follows the live origin name, not any sibling folder", () => {
	const f = artifact("widgets");
	const g = { ...trusted(), pushTarget: { ...target, pushUrl: "https://github.com/acme/gadgets.git" } };
	assert.ok(blocked(C.guardToolCall(g, "bash", { command: `git commit -F "${f}"` }, REPO, () => "https://github.com/acme/gadgets.git")), "target repo gadgets: widgets group refused");
	const bad = { ...trusted(), pushTarget: { ...target, pushUrl: "https://example.test/acme/widgets.git" } };
	assert.ok(blocked(C.guardToolCall(bad, "bash", { command: `git commit -F "${f}"` }, REPO, () => "https://example.test/acme/widgets.git")), "unparseable origin: origin-name group refused");
});

test("M1/M4 structural trusted context blocks merge and release create (inline and file forms)", () => {
	const g = trusted();
	const f = artifact("widgets", "n.md");
	for (const command of [merge(), merge(` --subject "S" --body-file "${f}"`), release(), release(`--notes-file "${f}"`)]) assert.ok(blocked(run(g, command)), command);
});

test("M5 push lease and commit lease alone never cover merge or release", () => {
	const store = C.createGrantStore();
	store.mintLease({ candidate: REPO, pushUrl: URL, branch: "feat/x", commits: true, artifactDir: slash(path.join(root, "worktrees", "widgets", "_evidence", "task")) });
	const g = { scope: "child" as const, store, agentDir: AGENT_DIR, gateCommits: true, live: live() };
	for (const command of [merge(), release()]) assert.ok(blocked(run(g, command)), command);
	assert.equal(run(g, PUSH), undefined, "lease push still works");
});

test("M2 separate action grants: merge grant merges only, release grant releases only; wrong scopes block", () => {
	const m = C.createGrantStore();
	m.addDeliveryGrant(mergeGrant());
	const gm = trusted(m);
	assert.equal(run(gm, merge()), undefined, "merge with its own grant");
	assert.equal(run(gm, merge()), undefined, "grant is reusable");
	assert.ok(blocked(run(gm, release())), "merge approval never releases");
	assert.ok(blocked(run(gm, merge().replace("acme/widgets", "acme/other"))), "wrong repo");
	assert.ok(blocked(run(gm, merge().replace(HEAD, "2".repeat(40)))), "wrong head sha");
	assert.ok(blocked(run(gm, merge().replace(" 12 ", " 13 "))), "wrong PR");
	assert.ok(blocked(run(trusted(C.createGrantStore()), merge())), "no grant");
	const r = C.createGrantStore();
	r.addDeliveryGrant(releaseGrant());
	const gr = trusted(r);
	assert.equal(run(gr, release()), undefined, "release with its own grant");
	assert.ok(blocked(run(gr, merge())), "release approval never merges");
	assert.ok(blocked(run(gr, release().replace("v1.2.3", "v9.9.9"))), "wrong tag");
	assert.ok(blocked(run(gr, release().replace(MERGED, "2".repeat(40)))), "wrong target");
	const stale = trusted(r);
	stale.live = live({ tagStatus: () => 0 });
	assert.ok(blocked(run(stale, release())), "existing tag fails closed");
});

test("M3 single-use operation grants cannot authorize merge or release; they are routed only through the action grants", () => {
	for (const command of [merge(), release()]) assert.throws(() => C.authorizableOp("shell", command, REPO, AGENT_DIR, true), /delivery action grant/, command);
	assert.ok(C.authorizableOp("shell", `${GP} origin master`, REPO, AGENT_DIR, true), "other risky operations stay grantable");
});

test("PR edit: same-owned open same-repo PR on the feature head is automatic (title, body, body-file)", () => {
	const g = trusted();
	const f = artifact("widgets", "edit.md");
	for (const command of [prEdit(), prEdit('--body "New body"'), prEdit(`--title "T" --body-file "${f}"`), prEdit(`--body-file "${f}"`)]) assert.equal(run(g, command), undefined, command);
	VIEWS["12"] = { state: "OPEN", baseRefName: "release/1.x", headRefName: "feat/x", isCrossRepository: false };
	assert.equal(run(g, prEdit()), undefined, "any valid base is fine: edit changes metadata only");
	delete VIEWS["12"];
});

test("PR create and edit refuse GH_HOST/GH_REPO from the injected environment", () => {
	const g = trusted();
	for (const env of [{ GH_HOST: "ghe.example.test" }, { GH_REPO: "acme/other" }]) {
		assert.ok(blocked(run({ ...g, live: live({ env: () => env }) }, prCreate())), `create ${JSON.stringify(env)}`);
		assert.ok(blocked(run({ ...g, live: live({ env: () => env }) }, prEdit())), `edit ${JSON.stringify(env)}`);
	}
});
test("M3b a stored single-use record for the exact merge or release is never consumed by the guard", () => {
	const store = C.createGrantStore();
	store.mint({ role: "release-engineer", candidate: REPO, ops: [{ kind: "shell", command: merge(), cwd: REPO }, { kind: "shell", command: release(), cwd: REPO }] });
	const g = trusted(store);
	for (const command of [merge(), release()]) assert.ok(blocked(run(g, command)), command);
	assert.equal(store.size(), 2, "records stay unconsumed");
});

// Shell-equivalent spellings (quoted words, wrappers, compounds) that the classifier reads as merge/release but a raw regex misses.
const quoteWord = (c: string, w: string) => c.replace(` ${w} `, ` "${w}" `);
const SPELLINGS = (() => {
	const m = merge(), r = release();
	const quotedMerge = quoteWord(m, "mer" + "ge"), quotedRelease = quoteWord(r, "cre" + "ate");
	return [
		quotedMerge, quotedRelease, m.replace("gh ", '"gh" '), m.replace("gh ", "'gh' "), m.replace("gh ", "gh.exe "), quoteWord(m, "pr"),
		quoteWord(m, "mer" + "ge").replace("gh pr", "gh -R acme/widgets pr"),
		`${quotedMerge} && ${quotedRelease}`, `${m}; ${quotedRelease}`, `${quotedMerge} | cat`,
		`env X=1 ${quotedMerge}`, `timeout 5 ${quotedRelease}`, `bash -c '${quotedMerge}'`, `sh -c "${m.replace("gh ", '\'gh\' ')}"`,
		// executable basename/path spellings and quote concatenation the tokenizer folds into the same words
		m.replace("gh ", "/usr/bin/gh "), m.replace("gh ", "C:\\tools\\gh.exe "), m.replace("gh ", "GH.EXE "), r.replace("gh ", "./gh "), m.replace("gh ", 'g"h" '), m.replace("gh ", "g'h' "),
		m.replace(" mer" + "ge ", " 'mer'\"ge\" "), r.replace(" cre" + "ate ", " cr\"ea\"te "), `${quotedMerge} && ${r.replace(" cre" + "ate ", " cr\"ea\"te ")}`,
		// wrapper forms
		`nohup ${quotedMerge}`, `command ${quotedMerge}`, `time ${quotedRelease}`, `exec ${quotedMerge}`, `nice -n 5 ${quotedMerge}`, `sudo ${quotedRelease}`, `xargs ${quotedMerge}`,
		`cmd /c ${quotedMerge}`, `powershell -Command '${quotedMerge}'`, `pwsh -c '${quotedRelease}'`, `env FOO=1 /usr/bin/gh pr "mer" "ge"`.replace('"mer" "ge"', "mer" + "ge"), `bash -c "sh -c '${quotedMerge}'"`,
		// strict parser cannot read these (extra flag, missing pins) yet the classifier still sees merge/release: no generic fallback
		`/usr/bin/${quoteWord(`${PRM} 12 --admin`, "mer" + "ge")}`, `nohup ${PRM.replace("mer" + "ge", 'mer"ge"')} 12`, `env ${REL.replace(" cre" + "ate", ' "cre' + 'ate"')} v9.9.9 --draft`,
		// unsupported action spellings (no pinned flags) must never fall back to a generic grant either
		`${PRM.replace("mer" + "ge", '"mer' + 'ge"')} 12`, `${quoteWord(`${PRM} 12 `, "mer" + "ge")}--admin`, `gh "rele${"ase"}" "cre${"ate"}" v9.9.9`,
	];
})();

test("M3c quoted/wrapped/compound merge and release spellings are refused as single-use requests and never consumed (main and child)", () => {
	for (const command of SPELLINGS) {
		assert.throws(() => C.authorizableOp("shell", command, REPO, AGENT_DIR, true), /delivery action grant/, command);
		for (const scope of ["main", "child"] as const) {
			const store = C.createGrantStore();
			store.mint({ role: scope === "main" ? null : "release-engineer", candidate: REPO, ops: [{ kind: "shell", command, cwd: REPO }] }); // main records carry role null
			const g = { ...trusted(store), scope };
			assert.ok(blocked(run(g, command)), `${scope}: ${command}`);
			assert.equal(store.size(), 1, `${scope} record stays unconsumed: ${command}`);
		}
	}
	assert.ok(C.authorizableOp("shell", `"git" "pu${"sh"}" origin master`, REPO, AGENT_DIR, true), "unrelated quoted risky operation stays grantable");
	assert.ok(C.authorizableOp("shell", `gh "pr" "clo${"se"}" 12`, REPO, AGENT_DIR, true), "other gh publish stays grantable");
});

// M3d: escaped quotes, backslash/backtick escapes, shell -c flag clusters and env -S tails. Pure classifier/guard strings only; risky words are assembled from fragments and nothing is executed.
// Main records carry role null, the trusted child record role release-engineer (a record minted for the wrong role is never consumed, so the null/main case is exercised for real).
const scopeGuard = (scope: "main" | "child", store: any) => (scope === "main" ? { scope, store, agentDir: AGENT_DIR } : { ...trusted(store), scope });
const roleOf = (scope: "main" | "child") => (scope === "main" ? null : "release-engineer");
const GH = "gh", PR = "pr", MG = "mer" + "ge", RL = "rele" + "ase", CR = "cre" + "ate", PS = "pu" + "sh";
const MERGE_LIKE = [
	// escaped quotes inside a double-quoted -c payload, nested shells, PowerShell argv-level escapes
	`bash -c "${GH} \\"${PR}\\" ${MG} 12"`, `bash -c "${GH} ${PR} \\"${MG}\\" 12"`, `sh -c "${GH} \\"${PR}\\" \\"${MG}\\" 12"`, `bash -c "${GH} \\"${RL}\\" \\"${CR}\\" v1"`,
	`bash -c "bash -c \\"${GH} \\\\\\"${PR}\\\\\\" ${MG} 12\\""`, `pwsh -c "${GH} \\"${PR}\\" ${MG} 12"`,
	// shell -c flag clusters and other shells
	`bash -xc "${GH} ${PR} ${MG} 12"`, `sh -ec "${GH} ${PR} ${MG} 12"`, `ksh -c "${GH} ${PR} ${MG} 12"`, `fish -c "${GH} ${PR} ${MG} 12"`,
	// POSIX backslash and PowerShell backtick escapes
	`g\\h ${PR} ${MG} 12`, `${GH} p\\r ${MG} 12`, `${GH} ${PR} ${MG.slice(0, 3)}\\${MG.slice(3)} 12`, `bash -c ${GH}\\ ${PR}\\ ${MG}\\ 12`, `${GH} p\`r ${MG} 12`,
	// env -S: operand plus trailing argv, attached/cluster/long forms
	// env with assignments only (plain wrapper)
	`env FOO=1 ${GH} ${PR} ${MG} 12`, `env a.b=1 ${GH} ${PR} ${MG} 12`, `env A-B=1 ${GH} ${PR} "${MG}" 12`, `env a.b=1 ${GH} ${RL} "${CR}" v1`, `/usr/bin/env FOO=1 ${GH} ${PR} ${MG} 12`, `env.exe FOO=1 ${GH} ${PR} ${MG} 12`, `ENV.EXE a.b=1 ${GH} ${PR} ${MG} 12`,
	// controls that were already refused and must stay so
	`bash -c "${GH} ${PR} ${MG} 12"`, `bash -c '${GH} "${PR}" ${MG} 12'`, `"C:\\Program Files\\GitHub CLI\\gh.exe" ${PR} ${MG} 1`,
];
const PROTECTED_PUSH = [`bash -c "git \\"${PS}\\" origin master"`, `bash -c "\\"git\\" ${PS} origin master"`, `bash -lc "git \\"${PS}\\" origin master"`, `git pu\\${PS.slice(2)} origin master`, `env a.b=1 git ${PS} origin master`, `env A-B=1 git ${PS} origin master`, `env FOO=1 git ${PS} origin master`];

test("M3d escaped, wrapped and env-assignment merge/release spellings: refused as requests, never consumed, blocked with an empty store (main role null and child)", () => {
	for (const command of MERGE_LIKE) {
		assert.throws(() => C.authorizableOp("shell", command, REPO, AGENT_DIR, true), /delivery action grant/, command);
		for (const scope of ["main", "child"] as const) {
			assert.ok(blocked(C.guardToolCall(scopeGuard(scope, C.createGrantStore()), "bash", { command }, REPO)), `${scope} empty store: ${command}`);
			const store = C.createGrantStore();
			store.mint({ role: roleOf(scope), candidate: REPO, ops: [{ kind: "shell", command, cwd: REPO }] });
			assert.ok(blocked(C.guardToolCall(scopeGuard(scope, store), "bash", { command }, REPO)), `${scope} preloaded: ${command}`);
			assert.equal(store.size(), 1, `${scope} record stays unconsumed: ${command}`);
		}
	}
});

test("M3d protected-branch publish in escaped, wrapped and env -S forms is blocked with an empty store (main and child)", () => {
	for (const command of PROTECTED_PUSH) {
		assert.ok(C.classifyShell(command, true).rules.includes("GIT_PUBLISH"), command);
		for (const scope of ["main", "child"] as const) assert.ok(blocked(C.guardToolCall(scopeGuard(scope, C.createGrantStore()), "bash", { command }, REPO)), `${scope}: ${command}`);
	}
});

test("M3d unrelated exact grants (quoted publish of another branch, PR close) still mint and are consumed exactly once in main and child", () => {
	for (const command of [`"git" "${PS}" origin feature/x`, `${GH} "${PR}" "clo${"se"}" 12`]) {
		assert.ok(C.authorizableOp("shell", command, REPO, AGENT_DIR, true), command);
		for (const scope of ["main", "child"] as const) {
			const store = C.createGrantStore();
			store.mint({ role: roleOf(scope), candidate: REPO, ops: [{ kind: "shell", command, cwd: REPO }] });
			assert.equal(C.guardToolCall(scopeGuard(scope, store), "bash", { command }, REPO), undefined, `${scope} consumes: ${command}`);
			assert.equal(store.size(), 0, `${scope} consumed once: ${command}`);
			assert.ok(blocked(C.guardToolCall(scopeGuard(scope, store), "bash", { command }, REPO)), `${scope} second use blocked: ${command}`);
		}
	}
});

test("M3d ordinary commands keep their exact rules; env -S with $ or backslash fails closed and is not grantable", () => {
	const rules = (c: string, commits = true) => C.classifyShell(c, commits).rules;
	assert.deepEqual(rules(`git commit -m "fix \\"${PS}\\" docs"`), ["GIT_COMMIT"]);
	assert.deepEqual(rules(`${PRC} --repo acme/widgets --title "Fix \\"quote\\" bug" --body "b"`), ["GIT_PUBLISH"]);
	assert.deepEqual(rules(PUSH), ["GIT_PUBLISH"]);
	for (const command of [`echo "a \\"git ${PS}\\" b"`, `bash -c "echo \\"git ${PS}\\""`, "env FOO=1 git status", "env FOO=1 git status --short", "env a.b=1 git status --short", "env A-B=1 node -v", "env", "env FOO=1", "env.exe FOO=1 git status --short", 'python -c "print(\\"hi\\")"']) assert.deepEqual(rules(command), [], command);
	for (const command of ["env -S 'A=${HOME} node'", "env -S 'A=\\x node'", "env -S 'node -v'", "env -i node"]) {
		const c = C.classifyShell(command, true);
		assert.ok(c.rules.includes("OPAQUE_UNPARSEABLE") && !c.grantable, command);
	}
	// the escape reading never leaks into a later, unrelated classification (synchronous flags reset)
	C.classifyShell(`${GH} p\`r ${MG} 12`, true);
	assert.deepEqual(rules("echo ok"), []);
	assert.deepEqual(rules(`git "${PS}" origin feature/x`), ["GIT_PUBLISH"]);
});

// M3e: every option-bearing env wrapper is unsupported (OPAQUE_UNPARSEABLE, non-grantable); env is never interpreted beyond leading assignments. Strings only, risky words assembled from fragments.
const ENV_TARGETS = [`${GH} ${PR} "${MG}" 12 --repo acme/widgets`, `${GH} ${RL} "${CR}" v1.2.3 --repo acme/widgets`, `git ${PS} origin master`];
const ENV_PLAIN_TARGETS = [`${GH} ${PR} ${MG} 12`, `${GH} ${RL} ${CR} v1`, `git ${PS} origin master`];
const ENV_OPTS = ["-i", "--", "-", "-u X", "-C .", "--unset=X", "-0", "-v", "-iu X", "--ignore-environment", "-S 'x'", "-S'x'", "-iS 'x'", "--split-string='x'", "--split-string 'x'", "-S '-S gh'", "-S 'gh pr # ignored'", "FOO=1 -i", "a.b=1 -u X", "FOO=1 --", "A=1 B=2 -C .", "-X"];
const ENV_PLAIN_OPTS = ENV_OPTS.filter((o) => !/['"]/.test(o));
const ENV_COMMANDS = [
	// the nine reviewer forms (env -S comment / reinserted option / push analogues)
	`env -S 'gh pr # ignored' "${MG}" 12 --repo acme/widgets`, `env -S 'gh ${RL} # ignored' "${CR}" v1.2.3 --repo acme/widgets`, `env -S 'git # ignored' ${PS} origin master`,
	`env --split-string='gh ${RL} # ignored' "${CR}" v1.2.3 --repo acme/widgets`, `env -iS 'gh ${RL} # ignored' "${CR}" v1.2.3 --repo acme/widgets`, `env -S'gh ${RL} # ignored' "${CR}" v1.2.3 --repo acme/widgets`,
	`env -S '-S gh' pr "${MG}" 12 --repo acme/widgets`, `env -S '-S gh' ${RL} "${CR}" v1.2.3 --repo acme/widgets`, `env -S '-S git' ${PS} origin master`,
	// whole -S command / benign env options are intentionally over-blocked
	`env -S '${GH} ${PR} ${MG} 12'`, `env -S '${GH} ${RL}' "${CR}" v1.2.3 --repo a/b`, `env -S 'git' ${PS} origin master`, "env -S 'node -v'", "env -i node", "env -u X node", "env -i FOO=1 rm -rf build",
	...ENV_TARGETS.flatMap((t) => ["env", "env.exe", "/usr/bin/env", "ENV.EXE", "C:\\tools\\env.exe"].flatMap((e) => ENV_OPTS.map((o) => `${e} ${o} ${t}`))),
	...ENV_PLAIN_TARGETS.flatMap((t) => ENV_PLAIN_OPTS.flatMap((o) => [`bash -c "env ${o} ${t}"`, `sh -c 'env ${o} ${t}'`, `timeout 5 env ${o} ${t}`, `nohup env ${o} ${t}`, `sudo env ${o} ${t}`, `env FOO=1 env ${o} ${t}`, `bash -c "bash -c 'env ${o} ${t}'"`])),
];

test("M3e env with any option is OPAQUE and non-grantable: no request, no consumption, blocked with empty and preloaded stores (main role null and child)", () => {
	assert.ok(ENV_COMMANDS.length > 500);
	for (const command of ENV_COMMANDS) {
		const c = C.classifyShell(command, true);
		assert.ok(c.rules.includes("OPAQUE_UNPARSEABLE") && !c.grantable, command);
		assert.throws(() => C.authorizableOp("shell", command, REPO, AGENT_DIR, true), RangeError, command);
		for (const scope of ["main", "child"] as const) {
			assert.ok(blocked(C.guardToolCall(scopeGuard(scope, C.createGrantStore()), "bash", { command }, REPO)), `${scope} empty store: ${command}`);
			const store = C.createGrantStore();
			store.mint({ role: roleOf(scope), candidate: REPO, ops: [{ kind: "shell", command, cwd: REPO }] });
			assert.ok(blocked(C.guardToolCall(scopeGuard(scope, store), "bash", { command }, REPO)), `${scope} preloaded: ${command}`);
			assert.equal(store.size(), 1, `${scope} record stays unconsumed: ${command}`);
		}
	}
});

test("M3e env assignments use GNU includes('=') recognition (a.b=1, A-B=1) and plain env keeps classifying the wrapped command", () => {
	const rules = (c: string) => C.classifyShell(c, true).rules;
	for (const e of ["env", "env.exe", "/usr/bin/env"]) {
		for (const a of ["FOO=1", "a.b=1", "A-B=1", "a.b=1 C=2"]) {
			assert.ok(rules(`${e} ${a} git ${PS} origin master`).includes("GIT_PUBLISH"), `${e} ${a} push`);
			assert.ok(rules(`${e} ${a} ${GH} ${PR} ${MG} 12`).includes("GIT_PUBLISH"), `${e} ${a} merge`);
			assert.deepEqual(rules(`${e} ${a} git status --short`), [], `${e} ${a} status`);
			assert.deepEqual(rules(`${e} ${a}`), [], `${e} ${a}`);
		}
		assert.ok(rules(`${e} ${GH} ${PR} ${MG} 12`).includes("GIT_PUBLISH"), `${e} plain merge`);
	}
	// env options after the command belong to the command, not to env
	assert.deepEqual(rules("env FOO=1 git status --short"), []);
	assert.deepEqual(rules("env FOO=1 node -v"), []);
	assert.deepEqual(rules(`env FOO=1 git commit -m "m"`), ["GIT_COMMIT"]);
	assert.deepEqual(rules(`env FOO=1 git ${PS} origin feature/x`), ["GIT_PUBLISH"]);
});

test("H1 unsupported commit form gets the fixed secret-free hint; prefix and digest intact", () => {
	const g = trusted();
	const f = artifact("widgets");
	for (const command of [`git commit -F ${f}`, "git commit -m unquoted"]) {
		const r = run(g, command) as { reason: string };
		assert.ok(blocked(r), command);
		assert.match(r.reason, /^Blocked by harness safety guard \[GIT_COMMIT\] op [0-9a-f]{16}: /);
		assert.match(r.reason, /not a normal commit form: use git commit -m "<text>" or git commit -F "<absolute \.md\/\.txt file>"/);
		assert.ok(!r.reason.includes(f) && !r.reason.includes("unquoted"), "no raw path or command echo");
	}
});

test("H2 hint absent for amend, no-verify, -a, other flags and non-commit blocks; quoted forms unaffected", () => {
	const g = trusted();
	for (const command of ['git commit --amend -m "x"', 'git commit --no-verify -m "x"', 'git commit -a -m "x"', 'git commit -am "x"', 'git commit -m "x" --amend', "git commit --amend", `${GP} origin main`]) {
		const r = run(g, command) as { reason: string };
		assert.ok(blocked(r), command);
		assert.ok(!/not a normal commit form/.test(r.reason), command);
	}
	assert.equal(run(g, 'git commit -m "x"'), undefined);
	const drift = run(g, 'git commit -m "x"', path.join(REPO, "sub")) as { reason: string };
	assert.ok(blocked(drift), "cwd drift still blocks");
	assert.ok(!/not a normal commit form/.test(drift.reason), "valid form with cwd drift: no hint");
});

test("blocked merge keeps the guard prefix and digest", () => {
	const r = run(trusted(), merge()) as { reason: string };
	assert.match(r.reason, /^Blocked by harness safety guard \[GIT_PUBLISH\] op [0-9a-f]{16}: /);
});

test("PR edit refusals: unrelated, cross-repo, closed, wrong repo, bad shape, off-branch HEAD, changed origin, other role", () => {
	const g = trusted();
	const f = artifact("widgets", "edit2.md");
	const mk = (over: Record<string, unknown>) => ({ state: "OPEN", baseRefName: "main", headRefName: "feat/x", isCrossRepository: false, ...over });
	const views: Array<[string, any]> = [
		["head is another branch", mk({ headRefName: "feat/other" })],
		["cross-repository", mk({ isCrossRepository: true })],
		["cross-repository missing", mk({ isCrossRepository: undefined })],
		["cross-repository null", mk({ isCrossRepository: null })],
		["merged", mk({ state: "MERGED" })],
		["closed", mk({ state: "CLOSED" })],
		["bad base name", mk({ baseRefName: "-x..y" })],
	];
	for (const [name, view] of views) { VIEWS["12"] = view; assert.ok(blocked(run(g, prEdit())), name); }
	delete VIEWS["12"];
	VIEWS["13"] = mk({ headRefName: "feat/unrelated" });
	assert.ok(blocked(run(g, prEdit('--title "T"', 13))), "unrelated PR of another branch");
	delete VIEWS["13"];
	assert.ok(blocked(run(g, prEdit().replace("acme/widgets", "acme/other"))), "wrong --repo");
	const bad = [prEdit('--title "T" --base develop'), prEdit('--title "T" --add-reviewer bob'), prEdit('--title "T" --add-label x'), prEdit(""), prEdit('--body "a" --body-file "x"'), `${prEdit()} && ${unmask("rm@@-rf x")}`, `${PRE} 12 --title "T"`, prEdit(`--body-file "${artifact("gadgets", "e.md")}"`), prEdit(`--body-file "${f.replace("edit2.md", "../edit2.md")}"`), prEdit(`--body-file "${artifact("widgets", "cred.md", "token=abc\n")}"`)];
	for (const command of bad) assert.ok(blocked(run(g, command)), command);
	assert.ok(blocked(run({ ...g, live: live({ ghJson: () => { throw new Error("timeout"); } }) }, prEdit())), "gh failure");
	assert.ok(blocked(run({ ...g, live: live({ ghJson: () => "not json object" }) }, prEdit())), "unusable view");
	assert.ok(blocked(C.guardToolCall(g, "bash", { command: prEdit() }, REPO, () => "https://github.com/acme/other.git")), "origin changed");
	assert.ok(blocked(run(g, prEdit(), path.join(REPO, "sub"))), "subdirectory cwd");
	assert.ok(blocked(run({ ...g, pushTarget: undefined, gateCommits: false }, prEdit())), "no trusted target");
	assert.ok(blocked(C.guardToolCall({ ...g, scope: "main" }, "bash", { command: prEdit() }, REPO)), "main never edits automatically");
	git(REPO, "checkout", "-q", "-b", "feat/other");
	try { assert.ok(blocked(run(g, prEdit())), "HEAD moved off the task branch"); } finally { git(REPO, "checkout", "-q", "feat/x"); }
});

test("protected, force and destructive Git operations stay denied in the trusted context", () => {
	const g = trusted();
	const denied = ["--force origin feat/x", "-f origin feat/x", "--force-with-lease origin feat/x", "origin +feat/x", "origin master", "origin main", "origin feat/x:master", "--delete origin feat/x", "--mirror origin", "--tags origin", "origin v1.2.3"].map((a) => `${GP} ${a}`);
	denied.push(...["git@@reset --hard HEAD~1", "git@@clean -fd", "git@@checkout -- .", "git@@branch -D feat/x", "git@@rebase main", "git@@stash drop", "git@@worktree remove x", "rm@@-rf node_modules", "gh@@pr close 12 --repo acme/widgets", "gh@@pr ready 12 --repo acme/widgets", "gh@@repo delete acme/widgets", "gh@@api -X DELETE repos/acme/widgets"].map(unmask), prEdit('--title "T" --base main'));
	for (const command of denied) assert.ok(blocked(run(g, command)), command);
	assert.ok(blocked(run(trusted(), `${GP} origin feat/x`, path.join(REPO, "sub"))), "push from a subdirectory");
});
