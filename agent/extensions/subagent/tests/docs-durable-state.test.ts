// Doc contract for durable PLAN/resume-state, run-manifest holds, recovery of completed-but-unusable worker results and
// main-session compaction ref mismatches. Reads committed guidance only (no runtime, no parser, no model). Agent copies are
// checked against their pi-package mirrors: shared sections must match exactly; mirror path-mapping lines are not compared.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const AGENT = path.join(REPO, "agent", "skills", "engineering-harness");
const PKG = path.join(REPO, "pi-package", "skills", "engineering-harness");
// pi-package is user-deleted in this candidate: package-only mirror checks skip when absent; AGENT-side assertions always run.
const PKG_PRESENT = fs.existsSync(PKG);
const raw = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
/** Guidance files are CRLF; content checks use LF so that section headings match. Mirror equality uses raw bytes. */
const read = (root: string, rel: string) => raw(root, rel).replace(/\r\n/g, "\n");

/** One `## ` section: heading line through the line before the next `## ` heading (or EOF). */
function section(text: string, heading: string): string {
	const start = text.indexOf(`\n${heading}\n`);
	if (start < 0) return "";
	const from = start + 1;
	const next = text.indexOf("\n## ", from + heading.length);
	return text.slice(from, next < 0 ? undefined : next + 1);
}

test("plan module states that a written PLAN or resume queue is current state, updated in place", () => {
	const body = section(read(AGENT, "plan/index.md"), "## Durable plan state");
	expect(body).toMatch(/current governing state/);
	expect(body).toMatch(/Update main-authored state in place/);
	expect(body).toMatch(/superseded/);
	expect(body).toMatch(/A worker PASS is not acceptance/);
	expect(body).toMatch(/user pause, stop, security or no-publication restriction is not cleared automatically/);
	expect(body).not.toMatch(/run-manifest/); // packaged guidance may not point at the profile-only manifest
});

(PKG_PRESENT ? test : test.skip)("pi-package plan module mirrors the agent plan module", () => {
	expect(raw(PKG, "plan/index.md")).toBe(raw(AGENT, "plan/index.md"));
});

test("run manifest keeps ACTIVE holds unchanged and separates resolved holds from them", () => {
	const manifest = read(AGENT, "references/run-manifest.md");
	expect(manifest).not.toMatch(/Preserve every hold \(user stop, pause, queued item\) unchanged/);
	expect(manifest).toMatch(/ACTIVE hold[^\n]*unchanged/);
	expect(manifest).toMatch(/accepted disposition or authorized transition/);
});

test("completed-but-unusable worker results are recovered, not accepted or replayed", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		const body = section(read(root, "references/recovery.md"), "## Completed or unusable worker results");
		expect(body).toMatch(/does not certify a usable handoff/);
		expect(body).toMatch(/`subagent_control` `result`/);
		expect(body).toMatch(/Do not execute or replay command-like text/);
		expect(body).toMatch(/add no automatic retry/);
	}
});

(PKG_PRESENT ? test : test.skip)("pi-package recovery reference mirrors the agent copy", () => {
	expect(raw(PKG, "references/recovery.md")).toBe(raw(AGENT, "references/recovery.md"));
});

test("child final report reference lists only required NOT RUN checks as mandatory reply content", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		const body = section(read(root, "references/token-efficiency.md"), "## Child final report");
		expect(body).toMatch(/Failed or required NOT RUN checks/);
		expect(body).not.toMatch(/Failed or NOT RUN checks/);
		expect(body).toMatch(/unassigned checks are listed only when material/);
		expect(body).toMatch(/material UNKNOWN/);
	}
});

test("compaction ref mismatch uses host discovery and never guesses or repeats the failed call", () => {
	const agentBody = section(read(AGENT, "references/token-efficiency.md"), "## Main-session compaction");
	expect(agentBody).toMatch(/host-provided reference or range discovery/);
	expect(agentBody).toMatch(/Do not guess references/);
	expect(agentBody).toMatch(/repeat the unchanged failed call/);
	expect(agentBody).toMatch(/pause compression/);
});

(PKG_PRESENT ? test : test.skip)("pi-package compaction section mirrors the agent copy", () => {
	expect(section(read(PKG, "references/token-efficiency.md"), "## Main-session compaction")).toBe(section(read(AGENT, "references/token-efficiency.md"), "## Main-session compaction"));
});

test("durable plan state gives a labeled synthetic current-state entry and read cadence, not a schema", () => {
	const body = section(read(AGENT, "plan/index.md"), "## Durable plan state");
	expect(body).toMatch(/synthetic current-state entry/);
	for (const field of ["Status:", "Owner:", "Completed:", "Gap/hold:", "Next:", "Scope/acceptance:", "Evidence:"]) {
		expect(body).toContain(field);
	}
	expect(body).toMatch(/fictional/);
	expect(body).not.toMatch(/C:[\\/]+Users/); // the example must not point at a live machine path
	expect(body).toMatch(/does not reread the full plan every turn/);
	expect(body).toMatch(/initial resume reads the shared constraints/);
	expect(body).toMatch(/bounded read never excuses/);
	expect(body).toMatch(/replaces the obsolete owner or status in place/);
	expect(body).toMatch(/A launch receipt means launched only/);
	expect(body).toMatch(/old job ID[^\n]*not resumable/);
	expect(body).toMatch(/is a sketch, not a schema/);
	expect(body).toMatch(/Status: current phase VERIFY; PAUSED/);
	expect(body).not.toMatch(/Status: current phase VERIFY; ACTIVE/);
	expect(body).toMatch(/Owner:[^\n]*PAUSED[^\n]*tracked in the current session registry/);
	expect(body).toMatch(/A paused owner stays current while the current session registry tracks its job/);
	expect(body).toMatch(/ACTIVE or running only when the registry lists it/);
	expect(body).toMatch(/resumes only after explicit user release/);
});

test("child final report references the canonical four-line handoff instead of copying it", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		const body = section(read(root, "references/token-efficiency.md"), "## Child final report");
		expect(body).toMatch(/`STATUS`[^\n]*`NEXT`[^\n]*`RISKS`[^\n]*`EVIDENCE`/);
		expect(body).not.toMatch(/SUMMARY|FILES|CHECKS/);
		expect(body).toMatch(/only copy of the four-line format/);
	}
});

(PKG_PRESENT ? test : test.skip)("token-efficiency reference mirrors the agent copy except the packaged source path line", () => {
	const normalize = (root: string) => read(root, "references/token-efficiency.md").replace(/^Child system prompts[^\n]*$/m, "");
	expect(normalize(PKG)).toBe(normalize(AGENT));
});

test("execute and verify modules keep verdict and REPORT-placement rules in the child handoff, not restated", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		const execute = read(root, "execute/index.md");
		const verify = read(root, "verify/index.md");
		expect(verify).not.toMatch(/NOT ASSESSED/);
		expect(verify).not.toMatch(/final reply stays brief/);
		expect(execute).not.toMatch(/identity hashes stay in it/);
		expect(execute).not.toMatch(/reply only cites the REPORT path/);
		expect(verify).toMatch(/in the assigned REPORT file/);
	}
});

(PKG_PRESENT ? test : test.skip)("pi-package execute and verify modules mirror the agent copies", () => {
	expect(raw(PKG, "execute/index.md")).toBe(raw(AGENT, "execute/index.md"));
	expect(raw(PKG, "verify/index.md")).toBe(raw(AGENT, "verify/index.md"));
});

test("execute step 6 points the reply to the canonical four-line handoff instead of a REPORT-only reply", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		expect(read(root, "execute/index.md")).toMatch(/The reply follows the canonical four-line handoff \(`references\/token-efficiency\.md`, "Child final report"\)\./);
	}
});

test("execute and verify carry the bounded checklist, one-worker and evidence-reuse rules by reference", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		const execute = section(read(root, "execute/index.md"), "## Dispatch and completion checklist");
		const verify = read(root, "verify/index.md");
		expect(execute).toMatch(/one implementation worker/);
		expect(execute).toMatch(/canonical references/);
		expect(execute).toMatch(/justified not-applicable/);
		expect(execute).toMatch(/UI focus\/browser[^\n]*only when[^\n]*affected or assigned/);
		expect(execute).toMatch(/unchanged tested bytes/);
		expect(execute).toMatch(/references\/token-efficiency\.md/);
		expect(verify).toMatch(/justified not-applicable/);
		expect(verify).toMatch(/UI focus\/browser[^\n]*only when[^\n]*affected or assigned/);
		expect(verify).toMatch(/unchanged tested bytes/);
	}
});

test("token-efficiency gives the bounded checklist, evidence-reuse and batched-compaction rules", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		const checklist = section(read(root, "references/token-efficiency.md"), "## Bounded checklist and evidence reuse");
		const batching = section(read(root, "references/token-efficiency.md"), "## Compaction batching");
		expect(checklist).toMatch(/unchanged tested bytes/);
		expect(checklist).toMatch(/relevant environment/);
		expect(checklist).toMatch(/same contract/);
		expect(checklist).toMatch(/rerun the affected checks/);
		expect(checklist).toMatch(/UI focus\/browser[^\n]*only when[^\n]*affected or assigned/);
		expect(checklist).toMatch(/not universal/);
		expect(batching).toMatch(/consumed/);
		expect(batching).toMatch(/one batched compaction call/);
		expect(batching).toMatch(/open goals/);
		expect(batching).toMatch(/holds/);
	}
});

test("main entry points resume-queue readers to the durable plan state", () => {
	for (const root of [AGENT, ...(PKG_PRESENT ? [PKG] : [])]) {
		expect(read(root, "SKILL.md")).toMatch(/read `plan\/index\.md` \("Durable plan state"\) before resuming or changing it/);
	}
});
