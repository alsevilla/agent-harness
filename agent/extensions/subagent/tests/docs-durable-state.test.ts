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

test("pi-package plan module mirrors the agent plan module", () => {
	expect(raw(PKG, "plan/index.md")).toBe(raw(AGENT, "plan/index.md"));
});

test("run manifest keeps ACTIVE holds unchanged and separates resolved holds from them", () => {
	const manifest = read(AGENT, "references/run-manifest.md");
	expect(manifest).not.toMatch(/Preserve every hold \(user stop, pause, queued item\) unchanged/);
	expect(manifest).toMatch(/ACTIVE hold[^\n]*unchanged/);
	expect(manifest).toMatch(/accepted disposition or authorized transition/);
});

test("completed-but-unusable worker results are recovered, not accepted or replayed", () => {
	for (const root of [AGENT, PKG]) {
		const body = section(read(root, "references/recovery.md"), "## Completed or unusable worker results");
		expect(body).toMatch(/does not certify a usable handoff/);
		expect(body).toMatch(/`subagent_control` `result`/);
		expect(body).toMatch(/Do not execute or replay command-like text/);
		expect(body).toMatch(/add no automatic retry/);
	}
	expect(raw(PKG, "references/recovery.md")).toBe(raw(AGENT, "references/recovery.md"));
});

test("compaction ref mismatch uses host discovery and never guesses or repeats the failed call", () => {
	const agentBody = section(read(AGENT, "references/token-efficiency.md"), "## Main-session compaction");
	const pkgBody = section(read(PKG, "references/token-efficiency.md"), "## Main-session compaction");
	expect(agentBody).toMatch(/host-provided reference or range discovery/);
	expect(agentBody).toMatch(/Do not guess references/);
	expect(agentBody).toMatch(/repeat the unchanged failed call/);
	expect(agentBody).toMatch(/pause compression/);
	expect(pkgBody).toBe(agentBody);
});

test("main entry points resume-queue readers to the durable plan state", () => {
	for (const root of [AGENT, PKG]) {
		expect(read(root, "SKILL.md")).toMatch(/read `plan\/index\.md` \("Durable plan state"\) before resuming or changing it/);
	}
});
