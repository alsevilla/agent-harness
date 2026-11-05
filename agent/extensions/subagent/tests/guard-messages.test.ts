// Guard block messages, the redacted .env read and artifact-folder creation at grant time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createGrantStore, guardToolCall, REDACTED_ENV_SCRIPT, REDACTED_ENV_SCRIPT_SHA256, redactedEnvRead, validateArtifactDir, readOnlyViolation } from "../safety-core.ts";
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

// Field report (bg-7@9d52a35084a7, test-engineer): read-only Betterwright verification was refused before it ran, and earlier read-only tasks
// got "[READ_ONLY_ROLE] redirects output into the candidate checkout" for the sibling worktrees/<repo>/_scratch and _evidence folders.
// PowerShell writers counted -Value script text, -ItemType Directory and -Encoding as paths resolved inside the candidate.
test("read-only role: PowerShell and shell writes to the sibling worktrees _scratch/_evidence folders pass; the candidate stays protected", () => {
	const candidate = slash(path.join(root, "RFID", "RFIDAttendance-Rust"));
	fs.mkdirSync(candidate, { recursive: true });
	const scratch = slash(path.join(root, "RFID", "worktrees", "RFIDAttendance-Rust", "_scratch", "sim800c"));
	const evidence = slash(path.join(root, "RFID", "worktrees", "RFIDAttendance-Rust", "_evidence", "sim800c"));
	const ro = { scope: "child" as const, store: createGrantStore(), agentDir, readOnlyRoot: candidate };
	const call = (command: string) => guardToolCall(ro, "powershell", { command }, candidate) as { block: boolean; reason: string } | undefined;
	for (const ok of [
		`New-Item -ItemType Directory -Force -Path "${scratch}"`,
		`Set-Content -Path "${scratch}/check.js" -Value "const ok = await page.isVisible('#kbd'); console.log(ok)" -Encoding utf8`,
		`Set-Content -LiteralPath '${scratch}/check.js' -Value 'x' -NoNewline`,
		`Add-Content -Path "${evidence}/REPORT.md" -Value "STATUS: PASS"`,
		`"done" | Out-File -FilePath "${evidence}/result.txt" -Encoding utf8`,
		`New-Item -Path "${evidence}" -Name "REPORT.md" -ItemType File -Value "x" -Force`,
		`Set-Content "${scratch}/a.txt" "value"`,
		`npx betterwright run < "${scratch}/check.js" > "${evidence}/betterwright.txt" 2>&1`,
		`mkdir -p "${evidence}"`,
	]) assert.equal(call(ok), undefined, ok);
	for (const [bad, why] of [
		[`Set-Content -Path src/app.tsx -Value "x"`, /set-content writes into the candidate checkout \(src\/app\.tsx resolves to .*\/src\/app\.tsx, inside protected root /],
		[`Set-Content src/app.tsx "x"`, /set-content writes into the candidate checkout \(src\/app\.tsx resolves to .*\/src\/app\.tsx, inside protected root /],
		[`New-Item -Name x.ts -ItemType File`, /new-item writes into the candidate checkout \(\.\/x\.ts resolves to .*\/x\.ts, inside protected root /],
		[`"x" | Out-File -FilePath "${candidate}/a.txt"`, /out-file writes into the candidate checkout/],
		[`npm test > $env:TEMP\\x.log`, /redirects output to a target with a variable or substitution the guard cannot resolve \(\$env:TEMP\\x\.log\); use the literal absolute _scratch or _evidence path from the packet/],
	] as const) {
		const r = call(bad);
		assert.ok(r?.block, bad);
		assert.match(r!.reason, /\[READ_ONLY_ROLE\]/, bad);
		assert.match(r!.reason, why, bad);
	}
});

// Field report (refusals 2e15600798145446, 07c3231bac8764b9): a read-only test-engineer's
//   cat > D:/work/RFID/worktrees/RFIDAttendance-Rust/_scratch/sim800c/run.js <<'EOF' … EOF
// was refused as "redirects output into the candidate checkout ()": the heredoc body (JavaScript, "page.evaluate(() =>") was checked as
// shell, and a line ending in "=>" looked like a redirect with no target. Windows paths are checked with Windows rules on every host.
test("read-only role, Windows paths: heredoc scripts to the sibling _scratch pass; shell-read heredocs and candidate writes stay refused", () => {
	const root = "D:/work/RFID/RFIDAttendance-Rust";
	const scratch = "D:/work/RFID/worktrees/RFIDAttendance-Rust/_scratch/sim800c";
	const js = "// Synthetic, mocked browser verification script\nconst ok = await page.evaluate(() =>\n  document.body.scrollHeight > window.innerHeight);\nif (count > 3) console.log(ok);";
	const check = (command: string, tool = "bash") => readOnlyViolation(tool, { command }, root, root);
	for (const ok of [
		`cat > ${scratch}/heartbeat-scroll-reinit-run.js <<'EOF'\n${js}\nEOF`,
		`cat > "${scratch}/a.js" <<EOF\n${js}\nEOF\nnpx betterwright run < "${scratch}/a.js"`,
		`cat > ${scratch.replace(/\//g, "\\")}\\b.js <<-'EOF'\n\t${js}\n\tEOF`,
		`cat > d:/work/rfid/worktrees/rfidattendance-rust/_scratch/sim800c/c.js <<'EOF'\nx > y\nEOF`,
	]) assert.equal(check(ok), undefined, ok.split("\n")[0]);
	assert.equal(check(`@'\n${js}\n'@ | Set-Content -Path "${scratch}/d.js"`, "powershell"), undefined, "a PowerShell here-string is a literal");
	const refused: Array<[string, RegExp]> = [
		[`bash <<'EOF'\necho x > src/app.ts\nEOF`, /\(src\/app\.ts resolves to D:\/work\/RFID\/RFIDAttendance-Rust\/src\/app\.ts, inside protected root D:\/work\/RFID\/RFIDAttendance-Rust\)/],
		[`cat <<'EOF' | bash\necho x > src/app.ts\nEOF`, /inside protected root D:\/work\/RFID\/RFIDAttendance-Rust/],
		[`cat > src/app.ts <<'EOF'\nx\nEOF`, /redirects output into the candidate checkout \(src\/app\.ts resolves to D:\/work\/RFID\/RFIDAttendance-Rust\/src\/app\.ts/],
		[`cat > D:\\work\\RFID\\RFIDAttendance-Rust\\src\\a.ts <<'EOF'\nx\nEOF`, /resolves to D:\/work\/RFID\/RFIDAttendance-Rust\/src\/a\.ts, inside protected root/],
		[`echo x >`, /redirects output with no target the guard can read; write to the literal absolute _scratch or _evidence path from the packet \(protected root D:\/work\/RFID\/RFIDAttendance-Rust\)/],
	];
	for (const [command, why] of refused) {
		const reason = check(command);
		assert.ok(reason, command.split("\n")[0]);
		assert.match(reason!, why, command.split("\n")[0]);
		assert.doesNotMatch(reason!, /\(\)/, "never an empty target");
	}
	assert.equal(readOnlyViolation("bash", { command: "echo x > ../worktrees/RFIDAttendance-Rust/_scratch/sim800c/r.txt" }, root, root), undefined, "a relative path that leaves the checkout");
});

// Field report (op 74876b9d82fc35d2): a read-only test-engineer created its browser script in the task _scratch folder, then could not
// fix a selector in it with sed -i: every in-place edit was refused whatever the file. sed -i and perl -i are judged by their files.
test("read-only role: sed -i and perl -i edit files in the sibling _scratch; candidate files stay refused with destination and root", () => {
	const root = "D:/work/RFID/RFIDAttendance-Rust";
	const script = "D:/work/RFID/worktrees/RFIDAttendance-Rust/_scratch/sim800c/heartbeat-scroll-completion-run.js";
	const check = (command: string) => readOnlyViolation("bash", { command }, root, root);
	for (const ok of [
		`sed -i 's/Reason/REASON/' ${script}`,
		`sed -i.bak -e 's/Reason/REASON/' "${script}"`,
		`sed -i -E 's/"Reason"/"REASON"/g' ${script.replace(/\//g, "\\")}`,
		`sed --in-place=.bak --expression='s/a/b/' ${script}`,
		`sed -i -f D:/work/RFID/worktrees/RFIDAttendance-Rust/_scratch/sim800c/fix.sed ${script}`,
		`perl -pi -e 's/Reason/REASON/' ${script}`,
		`perl -i.bak -pe 's/a/b/' "${script}"`,
		"sed -n 1,5p src/app.tsx",
	]) assert.equal(check(ok), undefined, ok);
	for (const [bad, why] of [
		["sed -i 's/a/b/' src/app.tsx", /sed -i edits into the candidate checkout \(src\/app\.tsx resolves to D:\/work\/RFID\/RFIDAttendance-Rust\/src\/app\.tsx, inside protected root D:\/work\/RFID\/RFIDAttendance-Rust\)/],
		[`sed -i -e 's/a/b/' ${script} src/app.test.tsx`, /resolves to D:\/work\/RFID\/RFIDAttendance-Rust\/src\/app\.test\.tsx/],
		["perl -pi -e 's/a/b/' D:\\work\\RFID\\RFIDAttendance-Rust\\vite.config.ts", /perl -i edits into the candidate checkout .* resolves to D:\/work\/RFID\/RFIDAttendance-Rust\/vite\.config\.ts, inside protected root/],
		["sed -i 's/a/b/' $f", /sed -i edits to a target with a variable or substitution the guard cannot resolve \(\$f\)/],
	] as const) assert.match(check(bad) ?? "", why, bad);
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
