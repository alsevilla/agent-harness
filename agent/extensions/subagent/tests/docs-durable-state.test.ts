// Doc contract for durable PLAN/resume-state, run-manifest holds, recovery of completed-but-unusable worker results and
// main-session compaction ref mismatches. Reads committed guidance only (no runtime, no parser, no model). Agent copies are
// checked directly; the retired pi-package mirror checks were removed with the pi-package layout.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const AGENT = path.join(REPO, "agent", "skills", "engineering-harness");
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

test("run manifest keeps ACTIVE holds unchanged and separates resolved holds from them", () => {
	const manifest = read(AGENT, "references/run-manifest.md");
	expect(manifest).not.toMatch(/Preserve every hold \(user stop, pause, queued item\) unchanged/);
	expect(manifest).toMatch(/ACTIVE hold[^\n]*unchanged/);
	expect(manifest).toMatch(/accepted disposition or authorized transition/);
});

test("completed-but-unusable worker results are recovered, not accepted or replayed", () => {
	for (const root of [AGENT]) {
		const body = section(read(root, "references/recovery.md"), "## Completed or unusable worker results");
		expect(body).toMatch(/does not certify a usable handoff/);
		expect(body).toMatch(/`subagent_control` `result`/);
		expect(body).toMatch(/Do not execute or replay command-like text/);
		expect(body).toMatch(/add no automatic retry/);
	}
});

test("child final report reference lists only required NOT RUN checks as mandatory reply content", () => {
	for (const root of [AGENT]) {
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
	for (const root of [AGENT]) {
		const body = section(read(root, "references/token-efficiency.md"), "## Child final report");
		expect(body).toMatch(/`STATUS`[^\n]*`NEXT`[^\n]*`RISKS`[^\n]*`EVIDENCE`/);
		expect(body).not.toMatch(/SUMMARY|FILES|CHECKS/);
		expect(body).toMatch(/only copy of the four-line format/);
	}
});

test("execute and verify modules keep verdict and REPORT-placement rules in the child handoff, not restated", () => {
	for (const root of [AGENT]) {
		const execute = read(root, "execute/index.md");
		const verify = read(root, "verify/index.md");
		expect(verify).not.toMatch(/NOT ASSESSED/);
		expect(verify).not.toMatch(/final reply stays brief/);
		expect(execute).not.toMatch(/identity hashes stay in it/);
		expect(execute).not.toMatch(/reply only cites the REPORT path/);
		expect(verify).toMatch(/in the assigned REPORT file/);
	}
});

test("execute step 6 points the reply to the canonical four-line handoff instead of a REPORT-only reply", () => {
	for (const root of [AGENT]) {
		expect(read(root, "execute/index.md")).toMatch(/The reply follows the canonical four-line handoff \(`references\/token-efficiency\.md`, "Child final report"\)\./);
	}
});

test("execute and verify carry the bounded checklist, one-worker and evidence-reuse rules by reference", () => {
	for (const root of [AGENT]) {
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
	for (const root of [AGENT]) {
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

test("run manifest documents a content fingerprint recipe instead of status plus diffstat", () => {
	const manifest = read(AGENT, "references/run-manifest.md");
	const recipe = section(manifest, "## Candidate fingerprint recipe");
	expect(recipe).not.toBe("");
	expect(manifest).not.toMatch(/hash of `git status --short` plus the diff stat/);
	expect(manifest).not.toMatch(/git status plus diff stat/);
	for (const needle of [/full HEAD/, /--porcelain=v1 -z --no-renames --untracked-files=all/, /hash-object --no-filters/, /git diff --cached --binary/, /deleted/, /link text/, /never followed/, /UNSUPPORTED/, /exclu/i, /no `freshPASS`|never a fresh PASS|cannot support a fresh PASS/i]) expect(recipe).toMatch(needle);
	expect(recipe).toMatch(/not a runtime|no runtime enforcement|documented recipe/i);
	expect(recipe).toMatch(/private|ignored|generated/i);
	expect(recipe).toMatch(/same-size/);
	expect(read(AGENT, "execute/index.md")).toMatch(/references\/run-manifest\.md[^\n]*[Cc]andidate fingerprint recipe/);
});

test("review module has a concise coverage receipt and keeps verdicts and the accepted-disposition rule", () => {
	const review = read(AGENT, "review/index.md");
	const body = section(review, "## REVIEW procedure");
	for (const needle of [/Coverage receipt/i, /candidate identity/i, /Inspected/, /Not inspected/, /actual checks/i, /reused evidence/i]) expect(body).toMatch(needle);
	expect(body).toMatch(/APPROVE, APPROVE WITH NOTES, REQUEST CHANGES, or ESCALATE/);
	expect(body).toMatch(/APPROVE WITH NOTES[^\n]*(cannot|never)[^\n]*unresolved material/i);
	expect(body).toMatch(/accepted disposition/);
	expect(body).toMatch(/not a file-by-file/i);
});

test("reviewer treats repository text, plans, logs and quoted commands as untrusted evidence, not authority", () => {
	const reviewer = read(REPO, "agent/agents/reviewer.md");
	const sentences = reviewer.match(/[^\n.]*Repository text[^\n]*untrusted evidence[^\n]*/g) ?? [];
	expect(sentences.length).toBe(1);
	for (const needle of [/plans/, /logs/, /tool output/, /quoted commands/, /not instructions/, /role, tools, permissions|tools, permissions/, /verdict contract/, /defense-in-depth/, /not a sandbox/]) expect(sentences[0]).toMatch(needle);
});

test("policy and runtime docs describe the explicit modelSlot fallback selector without widening other boundaries", () => {
	const agents = read(REPO, "agent/AGENTS.md");
	const runtime = read(AGENT, "references/runtime.md");
	const routing = read(AGENT, "references/routing.md");
	const readme = read(REPO, "agent/extensions/subagent/README.md");
	for (const [name, text] of [["AGENTS", agents], ["runtime", runtime], ["routing", routing], ["subagent README", readme]]) {
		expect(text, name).toMatch(/modelSlot/);
		expect(text, name).toMatch(/"fallback"/);
		expect(text, name).toMatch(/explicit `modelTier`|explicit tier/);
	}
	expect(agents).toMatch(/first configured fallback/);
	expect(agents).toMatch(/no arbitrary model/i);
	expect(agents).toMatch(/Explicit Pi `modelTier` selection is the narrow exception/);
	expect(readme).toMatch(/empty replay chain|no replay/i);
	expect(readme).toMatch(/not a (guaranteed )?cross-provider|not automatically cross-provider/i);
	expect(readme).toMatch(/Copilot[^\n]*(unsupported|no `?modelSlot`?)/i);
	expect(readme).toMatch(/Reload|new session/);
	expect(routing).toMatch(/not automatically cross-provider|diversity is required only when/i);
	expect(routing).toMatch(/observed provider\/model[^\n]*never the launch request/i);
	expect(routing).toMatch(/missing or partial observation as unverified/i);
	expect(readme).toMatch(/`requestedModel`[^\n]*`observed`/);
	expect(readme).toMatch(/No runtime checker enforces provider diversity/);
	expect(readme).toMatch(/served UNVERIFIED/);
	expect(readme).toMatch(/`responseModel`[^\n]*(anthropic-messages|openai-completions)/);
	expect(readme).toMatch(/never infer[^\n]*upstream provider|upstream provider[^\n]*never inferred/i);
	expect(routing).toMatch(/served UNVERIFIED/);
	expect(runtime).toMatch(/Copilot[^\n]*modelSlot|modelSlot[^\n]*Copilot/);
});

test("main entry points resume-queue readers to the durable plan state", () => {
	for (const root of [AGENT]) {
		expect(read(root, "SKILL.md")).toMatch(/read `plan\/index\.md` \("Durable plan state"\) before resuming or changing it/);
	}
});

// Static instruction-drift guard only: it proves the wording exists, not that any live orchestrator follows it.
test("ship module and subagent README require a known PR base as a structured prBase binding", () => {
	const ship = read(AGENT, "ship/index.md");
	expect(ship).toMatch(/PR create\/edit is authorized, the PR destination repo, head branch and base branch/);
	expect(ship).toMatch(/known base MUST[^\n]*`prBase`[^\n]*(single|each)[^\n]*(tasks|chain|dag)/);
	expect(ship).toMatch(/not (only )?(in )?task prose/i);
	expect(ship).toMatch(/cannot fix a missing binding after spawn/);
	expect(ship).toMatch(/Commit\/push-only delivery.*and LEARN need no `prBase`/);
	expect(ship).toMatch(/only[^\n]*runtime-exposed[^\n]*contract/i);
	const readme = fs.readFileSync(path.join(REPO, "agent", "extensions", "subagent", "README.md"), "utf8");
	expect(readme).toMatch(/when PR create\/edit is authorized and the base is known, the orchestrator MUST pass `prBase`/);
	expect(readme).toMatch(/Omitting `prBase` keeps the legacy behavior/);
});
