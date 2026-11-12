// Field report (sms-live-test): a read-only test-engineer's hardware smoke test started the backend from its _evidence folder, waited,
// then stopped it; the stop was refused as PROC_KILL although it ended only the process the same command had started. A stop is allowed
// when every process it targets is owned by the command (Start-Process -PassThru or $! held in a variable assigned once, or a Bash job
// spec); stopping by name, by a literal PID or through any other variable stays PROC_KILL. .Kill() is now classified at all.
import assert from "node:assert/strict";
import test from "node:test";
import { classifyShell } from "../safety-core.ts";

const ev = "D:/work/RFID/worktrees/RFIDAttendance-Rust/_evidence/sms-live-test";
const killRule = (command: string) => classifyShell(command).rules.includes("PROC_KILL");

test("stopping a process the same command started is not PROC_KILL", () => {
	for (const command of [
		`$p = Start-Process -FilePath "${ev}/rfid-attendance.exe" -ArgumentList "--database","${ev}/scratch.db" -PassThru; Start-Sleep 30; Stop-Process -Id $p.Id -Force`,
		`$p = Start-Process "${ev}/rfid-attendance.exe" -PassThru -RedirectStandardOutput "${ev}/out.log"\nStart-Sleep 30\n$p | Stop-Process -Force`,
		`$p = Start-Process "${ev}/rfid-attendance.exe" -PassThru; try { Start-Sleep 30 } finally { $p.Kill() }`,
		`$backend = Start-Process "${ev}/rfid-attendance.exe" -PassThru; Stop-Process -InputObject $backend -ErrorAction SilentlyContinue`,
		`"${ev}/rfid-attendance.exe" --database "${ev}/scratch.db" & pid=$!; sleep 30; kill $pid`,
		`"${ev}/rfid-attendance.exe" & BACKEND=$!; sleep 30; kill -TERM "$BACKEND"; wait "$BACKEND"`,
		`"${ev}/rfid-attendance.exe" & sleep 30; kill %1`,
	]) assert.equal(killRule(command), false, command);
});

test("any stop of a process the command did not start stays PROC_KILL", () => {
	for (const command of [
		"Get-Process rfid* | Stop-Process",
		"Stop-Process -Name rfid-attendance -Force",
		"Stop-Process -Id 4242",
		"$p = Get-Process rfid-attendance; Stop-Process -Id $p.Id",
		`$p = Start-Process "${ev}/rfid-attendance.exe"; Stop-Process -Id $p.Id`, // no -PassThru: $p holds nothing the command owns
		`$p = Start-Process "${ev}/rfid-attendance.exe" -PassThru; $p = Get-Process explorer; Stop-Process -Id $p.Id`, // reassigned
		`$p = Start-Process "${ev}/a.exe" -PassThru; Stop-Process -Id $p.Id; Stop-Process -Name explorer`, // one owned, one not
		"(Get-Process explorer).Kill()",
		"[System.Diagnostics.Process]::GetProcessById(4242).Kill()",
		"kill 4242",
		`"${ev}/a.exe" & pid=$!; kill $pid; kill 1`,
		"pkill rfid-attendance",
		`"${ev}/a.exe" & pid=$!; taskkill /PID $pid /F`,
		"taskkill /IM rfid-attendance.exe /F",
	]) assert.equal(killRule(command), true, command);
});
