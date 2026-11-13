// Guard block messages, the redacted .env read and artifact-folder creation at grant time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { commitRefusalWhy, createGrantStore, guardToolCall, REDACTED_ENV_SCRIPT, REDACTED_ENV_SCRIPT_SHA256, redactedEnvRead, validateArtifactDir, readOnlyViolation } from "../safety-core.ts";
import { spawnSync } from "node:child_process";
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
	const pushReason = reason(child, "git push origin feat/x");
	assert.match(pushReason, /git push; grantable: a worker receives only grants requested for its role and its launch folder before it was launched/);
	// Field report: main re-requested a grant for the session folder while the worker ran elsewhere; the message names the folder to request it for.
	assert.ok(pushReason.includes(`ask main to request one with role and cwd ${cwd} and relaunch the worker in that folder`), pushReason);
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
	for (const ok of ["git status", "git diff --stat", "npm test", "npm test 2>&1", `npm test > "${evidence}/test.log"`, `cat > "${evidence}/REPORT.md"`, "sed -n 1,5p a.ts", "git stash list", "git worktree list", "git worktree list --porcelain", "git submodule status", "git notes show"]) assert.equal(call(ok), undefined, ok);
	for (const bad of ["npm test > out.log", "git commit -m x", "git checkout -- a.ts", "sed -i s/a/b/ a.ts", "cp a.ts b.ts", "echo x | tee a.ts", "npm install x", 'bash -c "echo x > a.ts"', "mkdir tmp", "git worktree add ../x", "git worktree remove ../x", "git worktree prune", "git submodule update", "git notes add -m x"]) {
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

// Field report (op c058ffddb7a0f93c): an approved isolated preview (backend 127.0.0.1:9091, frontend localhost:5173, scratch SQLite,
// disposable admin password) could not start: Remove-Item Env:... was DESTRUCTIVE_FS, and the approval then refused the command as
// credential-like although the password was generated at runtime. The first block message also pointed at that refused route.
import { authorizableOp, blockReason, classifyShell, credentialFinding, decideToolCall, deliveryFormWhy, literalCredential, parseDeliveryCommand } from "../safety-core.ts";
test("isolated preview: Env: cleanup is not a filesystem delete; runtime-generated credentials are approvable; literal ones are not, consistently", () => {
	for (const env of ["Remove-Item Env:RFID_CAPTURE -ErrorAction SilentlyContinue", "Remove-Item -Path Env:\\SMS_WORKER", "ri env:PREVIEW_ADMIN_PASSWORD", "Remove-Item Variable:pw"]) {
		assert.deepEqual(classifyShell(env).rules, [], env);
	}
	assert.deepEqual(classifyShell("Remove-Item -Recurse -Force D:/w/_scratch/run").rules, ["DESTRUCTIVE_FS"], "a real delete is still destructive");
	assert.deepEqual(classifyShell("Remove-Item Env:X, D:/w/data.db").rules, ["DESTRUCTIVE_FS"], "a file target among provider targets is still a delete");

	const runtime = '$env:PREVIEW_ADMIN_PASSWORD = [guid]::NewGuid().ToString(); Remove-Item -Recurse -Force D:/w/_scratch/run; Start-Process D:/w/_scratch/run/rfid-attendance.exe';
	for (const value of ["[guid]::NewGuid().ToString()", "$(New-Guid)", "$pw", "-join ((48..57) | Get-Random -Count 16 | % {[char]$_})", "(Get-Random)"]) {
		assert.equal(literalCredential(`$env:ADMIN_PASSWORD = ${value}`), false, value);
	}
	for (const literal of ['$env:ADMIN_PASSWORD = "hunter2"', "ADMIN_PASSWORD=hunter2 ./run", "curl -H 'Authorization: Bearer abc'", "npm publish --token=abc", "export KEY=sk-live123"]) {
		assert.equal(literalCredential(literal), true, literal);
	}
	assert.doesNotThrow(() => authorizableOp("shell", runtime, "/tmp", agentDir), "a runtime-generated password is approvable");
	const decision = decideToolCall("powershell", { command: runtime }, "/tmp", agentDir) as any;
	assert.match(blockReason(decision, "main", false), /grantable: the operator can approve this exact operation with request_authorization/);

	const literalCmd = runtime.replace("[guid]::NewGuid().ToString()", '"hunter2"');
	assert.throws(() => authorizableOp("shell", literalCmd, "/tmp", agentDir), /credential-like literal text is not authorizable \("password=" followed by a literal value at character \d+\): generate the value when the command runs/);
	const refused = blockReason(decideToolCall("powershell", { command: literalCmd }, "/tmp", agentDir) as any, "main", false);
	assert.match(refused, /not approvable as written: the command text carries a credential-like literal \("password=" followed by a literal value at character \d+\), which an approval cannot show or store; generate the value when the command runs/, "the first refusal names the real route");
	assert.doesNotMatch(refused, /hunter2/, "never echoed");
	assert.doesNotMatch(refused, /approve this exact operation with request_authorization/);
});

// Field report (op 5b724340ad2aa44d): an identity-checked cleanup of test backend PID 2508 was refused as credential-like and the worker
// found no credential in it. A credential word with no value after it (a match pattern, a label) is not a literal, and the refusal
// names the part that matched without echoing the value.
test("credential-like refusals name the matching part; match patterns and labels are not literals", () => {
	for (const ok of [
		"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = 2508'; if ($p.CommandLine -like '*--sms-token=*') { Stop-Process -Id 2508 -Force }",
		'Write-Output "Token:"; Stop-Process -Id 2508',
		"Get-Process | Where-Object { $_.Name -match 'secret:' }",
	]) assert.equal(credentialFinding(ok), undefined, ok);
	assert.equal(credentialFinding('$env:ADMIN_PASSWORD = "hunter2"'), '"password=" followed by a literal value at character 12');
	assert.equal(credentialFinding("export KEY=sk-live123"), "a known key prefix (sk-) at character 12");
	assert.equal(credentialFinding("curl -H 'Authorization: Bearer abc'"), "a Bearer token at character 25");
	const cmd = 'Stop-Process -Id 2508; $env:SMS_TOKEN = "abc123"';
	const refused = blockReason(decideToolCall("powershell", { command: cmd }, "/tmp", agentDir) as any, "main", false);
	assert.match(refused, /credential-like literal \("token=" followed by a literal value at character 33\)/);
	assert.doesNotMatch(refused, /abc123/, "never echoed");
	assert.throws(() => authorizableOp("shell", cmd, "/tmp", agentDir), /not authorizable \("token=" followed by a literal value at character 33\)/);
});

// Field report: an approved squash merge with --subject "fix(db): Schedule backups" was refused as a missing approval. The colon is
// accepted in subjects, titles and inline text, and a delivery command in a form the guard does not accept names what is wrong.
test("delivery commands: a conventional-commit colon is accepted; an unaccepted form names the argument, not a missing approval", () => {
	const merge = `gh pr merge 12 --repo o/r --squash --match-head-commit ${"a".repeat(40)}`;
	const ok = parseDeliveryCommand(`${merge} --subject "fix(db): Schedule backups"`);
	assert.equal(ok?.kind === "merge" && ok.subject, "fix(db): Schedule backups");
	assert.equal(deliveryFormWhy(`${merge} --subject "fix(db): Schedule backups"`), undefined);
	assert.equal(parseDeliveryCommand('gh pr create --repo o/r --base master --head feat/x --title "feat(ui): Add page" --body "Why: faster"')?.kind, "create");
	for (const [command, why] of [
		[`${merge} --subject "fix; x"`, /the --subject value contains an unsupported character \(";", character 4 of the value\); allowed: ASCII letters, digits, space and \. , : _ \/ # \( \) \+ -/],
		[`${merge} --subject fix`, /the --subject value must be in double quotes/],
		[`${merge} --subject "${"x".repeat(130)}"`, /the --subject value must be 1 to 120 characters \(it has 130\)/],
		[`${merge} --subject "rotate token: abc123"`, /the --subject value contains credential-like text/],
		[`${merge} --admin`, /option --admin is not supported here; supported: --repo, --squash, --match-head-commit, --subject, --body, --body-file/],
		["gh pr merge 12 --squash", /gh pr merge needs --repo, --squash and --match-head-commit/],
		["gh pr merge 12  --squash", /one line of printable ASCII with single spaces/],
	] as [string, RegExp][]) {
		assert.match(deliveryFormWhy(command) ?? "", why, command);
		const reason = blockReason(decideToolCall("bash", { command }, "/tmp", agentDir) as any, "child", true);
		assert.match(reason, /^Blocked by harness safety guard \[GIT_PUBLISH\] op [0-9a-f]{16}: gh pr; not an accepted command form: /, command);
		assert.match(reason, /this is not a missing approval, and an approval already given for this merge or release still applies\.$/, command);
		assert.doesNotMatch(reason, /abc123|grantable/, command);
	}
	// An accepted form without an approval, and other gh commands, keep the approval message.
	assert.equal(deliveryFormWhy("gh pr close 3"), undefined);
	assert.match(blockReason(decideToolCall("bash", { command: merge }, "/tmp", agentDir) as any, "child", true), /grantable/);
});

// Release notes need the previous release: gh release list and view are read-only and pass; every other gh release command stays gated.
test("gh release list and view pass the guard; create, delete, edit, upload and chained forms stay blocked", () => {
	const store = createGrantStore();
	const run = (command: string) => guardToolCall({ scope: "child", store, agentDir, gateCommits: true }, "bash", { command }, cwd);
	assert.equal(run("gh release list --repo acme/widgets --limit 5"), undefined);
	assert.equal(run("gh release view v1.14.0 --repo acme/widgets"), undefined);
	for (const c of ["gh release create v1.2.3 --repo acme/widgets --target abc --title x --generate-notes", "gh release delete v1.0.0 --repo a/b", "gh release edit v1 --notes x", "gh release upload v1 x.zip", "gh release list && gh release delete v1"]) assert.ok(run(c), c);
});

// Field report: a read-only test-engineer's `cat > _scratch/.../x.mjs <<'EOF'` was refused five times in a row, as SECRET (the script
// mentioned .env) or PROC_KILL (it contained Stop-Process): the risk rules read the body of a file being written. A body this command
// only writes or prints is data; one a shell, an interpreter or a pipe reads still runs, so it stays checked.
test("risk rules: text a command only writes to a file is data; heredocs a shell, interpreter or pipe runs stay checked", () => {
	const cwd = "D:/work/RFID/worktrees/RFIDAttendance-Rust/sms-test-send";
	const scratch = "D:/work/RFID/worktrees/RFIDAttendance-Rust/_scratch/sms-test/iv";
	const run = (command: string, tool = "bash") => guardToolCall({ scope: "child", store: createGrantStore(), agentDir: "D:/profile/.pi/agent", readOnlyRoot: cwd, reads: new Set() } as any, tool, { command }, cwd) as { block?: boolean; reason?: string } | undefined;
	const rule = (command: string, tool = "bash") => /\[([A-Z_]+)\]/.exec(run(command, tool)?.reason ?? "")?.[1];
	for (const body of ["dotenv.config({ path: '.env' });", "Stop-Process -Id 33480 -Force", "rm -rf /tmp/build", "cat ~/.ssh/id_rsa"]) {
		for (const command of [`cat > ${scratch}/start.mjs <<'EOF'\n${body}\nEOF`, `mkdir -p ${scratch} && cat <<EOF > ${scratch}/b.sh\n${body}\nEOF`, `tee ${scratch}/c.txt <<'EOF'\n${body}\nEOF`]) {
			assert.equal(run(command)?.block, undefined, `${command.split("\n")[0]} | ${body}`);
		}
	}
	assert.equal(run(`@'\nStop-Process -Id 1 -Force\n'@ | Set-Content -Path "${scratch}/k.ps1"`, "powershell")?.block, undefined, "a here-string written to a file is data");
	const stillChecked: Array<[string, string, string?]> = [
		[`bash <<'EOF'\nStop-Process -Id 1 -Force\nEOF`, "PROC_KILL"],
		[`cat <<'EOF' | bash\nrm -rf /tmp/build\nEOF`, "DESTRUCTIVE_FS"],
		[`python - <<'E'\nopen('.env').read()\nE`, "SECRET"],
		[`node - <<'EOF'\nrequire('fs').readFileSync('.env')\nEOF`, "SECRET"],
		[`cat > ${scratch}/x.sh <<'EOF' | sh\nrm -rf /tmp/build\nEOF`, "DESTRUCTIVE_FS"],
		[`cat .env > ${scratch}/copy.txt`, "SECRET"],
		[`@'\nnote\n'@ | Set-Content -Path "${scratch}/n.txt"; Stop-Process -Id 1 -Force`, "PROC_KILL", "powershell"],
	];
	for (const [command, expected, tool] of stillChecked) assert.equal(rule(command, tool), expected, command.split("\n")[0]);
});

// Field report: a read-only debugger's `$R='<_scratch path>'` then `cargo check ... *> "$R\check-fixed.log"` was refused as a target
// with a variable the guard cannot resolve. A variable assigned once to a literal, before its use, with nothing able to change it, is
// resolved; anything less certain stays refused.
test("read-only role: a variable assigned once to a literal path in the same command is resolved; uncertain variables stay refused", () => {
	const root = "D:/work/RFID/worktrees/RFIDAttendance-Rust/sms-test-send";
	const scratch = String.raw`D:\work\RFID\worktrees\RFIDAttendance-Rust\_scratch\sms-test\r1-compile-debug`;
	const check = (command: string, tool = "powershell") => readOnlyViolation(tool, { command }, root, root);
	const field = [
		`$R='${scratch}'`,
		String.raw`$env:CARGO_TARGET_DIR="$R\target-full"; $env:CARGO_INCREMENTAL='0'`,
		String.raw`Push-Location "$R\backend-copy"`,
		String.raw`cargo check --all-targets --offline *> "$R\check-fixed.log"; "exit $LASTEXITCODE"`,
		"Pop-Location",
		String.raw`Get-Content "$R\check-fixed.log" -Tail 15`,
	].join("\n");
	assert.equal(check(field), undefined, "the field command writes only to its _scratch folder");
	assert.equal(check(`$Out = "${scratch}"; $L = '${scratch}\\b.log'\ncargo test *> $L; Get-Content "$Out\\a.log"`), undefined, "two variables, double and single quotes");
	assert.equal(check(`R='${scratch.replace(/\\/g, "/")}'\ncargo check > "$R/check.log" 2>&1`, "bash"), undefined, "bash assignment");
	assert.equal(check(`export R=${scratch.replace(/\\/g, "/")}; cargo check > "\${R}/check.log"`, "bash"), undefined, "export and \${R}");
	const refused: Array<[string, RegExp, string?]> = [
		[String.raw`$R='D:\work\RFID\worktrees\RFIDAttendance-Rust\sms-test-send\src'` + "\n" + String.raw`echo x > "$R\a.rs"`, /into the candidate checkout .*resolves to D:\/work\/RFID\/worktrees\/RFIDAttendance-Rust\/sms-test-send\/src\/a\.rs/],
		[`$R='${scratch}'\n$R='D:\\work\\x'\necho x > "$R\\a.log"`, /variable or substitution the guard cannot resolve/],
		[`$R = Get-Location\necho x > "$R\\a.log"`, /variable or substitution/],
		[`$R='${scratch}'\nSet-Variable -Name R -Value 'D:\\elsewhere'\necho x > "$R\\a.log"`, /variable or substitution/],
		[`echo x > "$R\\a.log"\n$R='${scratch}'`, /variable or substitution/],
		[`$R='${scratch}'\nif ($true) { $R = 'D:\\elsewhere' }\necho x > "$R\\a.log"`, /variable or substitution/],
		[`$Root='${scratch}'\necho x > "$R\\a.log"`, /variable or substitution/],
		[`R=$(pwd)\necho x > "$R/a.log"`, /variable or substitution/, "bash"],
		[`R='/tmp/ok'; for R in a b; do :; done\necho x > "$R/a.log"`, /variable or substitution/, "bash"],
	];
	for (const [command, why, tool] of refused) assert.match(check(command, tool) ?? "", why, command.split("\n")[0]);
});

// Field report: a trusted release-engineer concluding a merge was told only "a normal commit is automatic only with cwd = the candidate
// root on its feature branch". Each condition that keeps a normal commit from being automatic now has its own reason.
test("commit refusals name the condition that failed: folder, branch, detached HEAD, merge-like state, message file, no target", () => {
	const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "commit-why-")));
	const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
	try {
		git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@example.test");
		git("commit", "-q", "--allow-empty", "-m", "init"); git("checkout", "-q", "-b", "feat/x");
		fs.mkdirSync(path.join(repo, "sub"));
		const url = "https://github.com/owner/repo.git";
		const target = { candidate: repo.replace(/\\/g, "/"), pushUrl: url, branch: "feat/x" };
		const live = () => url;
		const why = (command: string, cwd = repo, t: typeof target | undefined = target, l = live) => commitRefusalWhy(t, command, cwd, l) ?? "";
		const commit = 'git commit -m "x"';
		assert.equal(commitRefusalWhy(target, commit, repo, live), undefined, "the good case has no refusal reason");
		assert.match(why(commit, path.join(repo, "sub")), /this folder \(.*sub\) is not the candidate root this worker was launched for/);
		assert.match(why(commit, repo, { ...target, branch: "feat/y" }), /the checked-out branch is feat\/x, not the launch's feature branch feat\/y/);
		assert.match(why(commit, repo, target, () => "https://github.com/other/repo.git"), /push URL of feat\/x no longer matches/);
		assert.match(why('git commit -F "/elsewhere/msg.txt"'), /the -F message file \/elsewhere\/msg\.txt is not in this task's _scratch or _evidence folder/);
		assert.match(commitRefusalWhy(undefined, commit, repo, live) ?? "", /launched without a feature-branch push target/);
		fs.writeFileSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"), "x\n");
		assert.match(why(commit), /a cherry-pick is in progress \(CHERRY_PICK_HEAD in .*\): a commit that concludes it records another history/);
		fs.rmSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"));
		const tip = git("rev-parse", "HEAD").stdout.trim();
		fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), `${tip}\n${tip}\n`);
		assert.match(why(commit), /a merge is in progress \(MERGE_HEAD in .*\) and it merges more than one commit: only a merge of the PR's base branch concludes automatically/);
		fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), `${tip}\n`);
		assert.match(why(commit, repo, { ...target, base: "feat/x" } as typeof target), /and the base branch is the feature branch itself/);
		assert.match(why(commit, repo, { ...target, base: "main" } as typeof target), /and origin\/main is not fetched here/, "the base bound at launch is used");
		fs.rmSync(path.join(repo, ".git", "MERGE_HEAD"));
		git("checkout", "-q", "--detach");
		assert.match(why(commit), /HEAD is not on a branch \(detached\)/);
	} finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// Field report (harness-block-triage): planner and test-engineer writes inside the checkout were refused, but a database-specialist's
// report appeared there. Writes that use no redirect or listed command were not checked: .NET file methods, Tee-Object and Export-Csv,
// Rename-Item, cmd /c, inline interpreter code, dd of=, and a move whose source is in the checkout. Each is refused into the checkout and
// still allowed into the sibling evidence folder; reads stay allowed.
test("read-only roles: every write form is refused inside the checkout and allowed into the sibling evidence folder", () => {
	const repo = "D:/work/RFID/RFIDAttendance-Rust";
	const ev = "D:/work/RFID/worktrees/RFIDAttendance-Rust/_evidence/triage";
	const check = (tool: string, command: string) => readOnlyViolation(tool, { command }, repo, repo);
	const forms: [string, (target: string) => string][] = [
		["powershell", (t) => `[IO.File]::WriteAllText("${t}", "report")`],
		["powershell", (t) => `$text = 'r'; [System.IO.File]::WriteAllLines('${t}', @($text))`],
		["powershell", (t) => `[System.IO.File]::AppendAllText("${t}", "x")`],
		["powershell", (t) => `$w = New-Object System.IO.StreamWriter("${t}"); $w.Close()`],
		["powershell", (t) => `"x" | Tee-Object -FilePath "${t}"`],
		["powershell", (t) => `$rows | Export-Csv "${t}"`],
		["powershell", (t) => `cmd /c "echo x > ${t}"`],
		["powershell", (t) => `python -c "open('${t}','w').write('x')"`],
		["bash", (t) => `python3 - <<'EOF'\nimport json\njson.dump({}, open('${t}', 'w'))\nEOF`],
		["bash", (t) => `python3 -c "from pathlib import Path; Path('${t}').write_text('x')"`],
		["bash", (t) => `node -e "require('fs').writeFileSync('${t}', 'x')"`],
		["bash", (t) => `node - <<'EOF'\nconst fs = require('fs');\nfs.appendFileSync("${t}", "x");\nEOF`],
		["bash", (t) => `dd if=/dev/zero of=${t} count=1`],
	];
	for (const [tool, form] of forms) {
		assert.match(check(tool, form("REPORT.md")) ?? "", /into the candidate checkout/, `${tool}: ${form("REPORT.md")}`);
		assert.match(check(tool, form(`${repo}/docs/REPORT.md`)) ?? "", /into the candidate checkout/, `${tool} absolute: ${form("")}`);
		assert.equal(check(tool, form(`${ev}/REPORT.md`)), undefined, `${tool} evidence: ${form(`${ev}/REPORT.md`)}`);
	}
	// A move or rename changes its source too.
	assert.match(check("bash", `mv src/db.rs ${ev}/db.rs`) ?? "", /into the candidate checkout/);
	assert.match(check("powershell", `Move-Item src/db.rs ${ev}/db.rs`) ?? "", /into the candidate checkout/);
	assert.match(check("powershell", "Rename-Item notes.md REPORT.md") ?? "", /into the candidate checkout/);
	assert.equal(check("bash", `mv ${ev}/a.md ${ev}/b.md`), undefined);
	// A path the guard cannot resolve is refused, not assumed safe.
	assert.match(check("bash", `python3 -c "p = 'x'; open(p, 'w')"`) ?? "", /cannot resolve|no target/);
	// Reads, and a script file written as data, stay allowed (code run from a script file is not inspected).
	for (const [tool, command] of [
		["powershell", `python -c "print(open('src/db.rs').read())"`],
		["bash", `node -e "console.log(require('fs').readFileSync('Cargo.toml', 'utf8'))"`],
		["powershell", `[IO.File]::ReadAllText("src/db.rs")`],
		["bash", `python3 - <<'EOF'\nfrom pathlib import Path\nprint(Path('src/db.rs').read_text())\nEOF`],
		["bash", `cat > ${ev}/check.py <<'EOF'\nopen('out.txt', 'w').write('x')\nEOF`],
	] as const) assert.equal(check(tool, command), undefined, command);
});

test("a READ_ONLY_ROLE refusal names the candidate's artifact folder by the worktrees convention", () => {
	const ro = (root: string) => ({ ...child, readOnlyRoot: root });
	const refuse = (root: string) => (guardToolCall(ro(root), "bash", { command: "echo x > REPORT.md" }, root) as { reason: string }).reason;
	assert.match(refuse("D:/work/RFID/RFIDAttendance-Rust"), /for this candidate: D:\/work\/RFID\/worktrees\/RFIDAttendance-Rust\/_evidence\/<task>\/ or _scratch\/<task>\//);
	assert.match(refuse("D:/work/RFID/worktrees/RFIDAttendance-Rust/sms-pacing"), /for this candidate: D:\/work\/RFID\/worktrees\/RFIDAttendance-Rust\/_evidence\/<task>\//);
});

// Field report (sms-live-test): a read-only test-engineer copying the built backend executable from the checkout to its _evidence folder
// was refused as "interpreter code writes into the candidate checkout": the copy's source was checked as a write target. A copy writes
// only its destination; a move or rename changes both paths.
test("read-only roles: copying out of the checkout is allowed, copying into it is refused, in every copy form", () => {
	const repo = "D:/work/RFID/RFIDAttendance-Rust";
	const ev = "D:/work/RFID/worktrees/RFIDAttendance-Rust/_evidence/sms-live-test";
	const exe = "backend/target/debug/rfid-attendance.exe";
	const check = (tool: string, command: string) => readOnlyViolation(tool, { command }, repo, repo);
	const copies: [string, (src: string, dst: string) => string][] = [
		["bash", (a, b) => `python3 - <<'EOF'\nimport shutil\nshutil.copy2(r"${a}", r"${b}")\nEOF`],
		["powershell", (a, b) => `python -c "import shutil; shutil.copy('${a}', '${b}')"`],
		["bash", (a, b) => `python3 - <<'EOF'\nimport shutil\nshutil.copytree("${a}", "${b}")\nEOF`],
		["bash", (a, b) => `node -e "require('fs').copyFileSync('${a}', '${b}')"`],
		["bash", (a, b) => `node - <<'EOF'\nconst fs = require("fs");\nfs.cpSync("${a}", "${b}");\nEOF`],
		["powershell", (a, b) => `[IO.File]::Copy("${a}", "${b}", $true)`],
		["powershell", (a, b) => `Copy-Item "${a}" "${b}"`],
		["bash", (a, b) => `cp "${a}" "${b}"`],
	];
	for (const [tool, form] of copies) {
		assert.equal(check(tool, form(exe, `${ev}/rfid-attendance.exe`)), undefined, `out of the checkout: ${form(exe, `${ev}/rfid-attendance.exe`)}`);
		assert.match(check(tool, form(`${ev}/rfid-attendance.exe`, exe)) ?? "", /into the candidate checkout/, `into the checkout: ${form(`${ev}/x`, exe)}`);
	}
	// Moves and renames change their source, so moving out of the checkout stays refused.
	for (const [tool, command] of [
		["bash", `python3 -c "import shutil; shutil.move('${exe}', '${ev}/x.exe')"`],
		["bash", `node -e "require('fs').renameSync('${exe}', '${ev}/x.exe')"`],
		["powershell", `[IO.File]::Move("${exe}", "${ev}/x.exe")`],
	] as const) assert.match(check(tool, command) ?? "", /into the candidate checkout/, command);
	// One-argument deletes name their own target; Ruby File.open is a write only with a write mode; Replace's null backup is no target.
	assert.equal(check("bash", `python3 -c "import shutil; shutil.rmtree('${ev}/run1')"`), undefined);
	assert.match(check("bash", `python3 -c "import shutil; shutil.rmtree('backend/target')"`) ?? "", /into the candidate checkout/);
	assert.equal(check("bash", `ruby -e "puts File.open('Cargo.toml').read"`), undefined);
	assert.match(check("bash", `ruby -e "File.open('NOTES.md', 'w') { |f| f.write('x') }"`) ?? "", /into the candidate checkout/);
	assert.equal(check("powershell", `[IO.File]::Replace("${ev}/new.db", "${ev}/scratch.db", $null)`), undefined);
	assert.match(check("powershell", `[IO.File]::Replace("${ev}/new.db", "backend/data.db", $null)`) ?? "", /into the candidate checkout/);
	// The copied executable then runs from the evidence folder against a scratch database: nothing there writes into the checkout.
	assert.equal(check("powershell", `& "${ev}/rfid-attendance.exe" --database "${ev}/scratch.db"`), undefined);
});
