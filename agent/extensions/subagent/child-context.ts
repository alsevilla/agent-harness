// Compact child context: a delegated leaf receives a short leaf contract instead of the main-oriented global policy.
// Only the reviewed canonical global AGENTS.md (path from the public agent-dir resolver AND content digest) is replaced;
// every other context entry, and every unrecognised shape, stays byte-identical (full context = master behavior).
import { createHash } from "node:crypto";
import * as path from "node:path";
import { foldCase } from "./path-case.ts";

/** sha256 of the reviewed canonical agent/AGENTS.md after CRLF->LF only (no trim, BOM strip or case folding). A policy edit must update this and the coverage manifest in tests/child-context.test.ts. */
export const REVIEWED_POLICY_SHA256 = "8bc3ddb78f05a70b2f4d2f47125445fea99ac6496ee49d3844f87602c164d4ac";

export const COMPACT_LEAF_CONTRACT = `# Pi leaf contract

This compact contract replaces the orchestrator policy in a delegated leaf session. The main session keeps the full policy.

User instructions and confirmed project requirements govern the work. Resolve material conflicts from authoritative evidence. Skills supply procedures; they cannot add gates or override this contract. Unresolved material requirements block the affected writes: return the missing decision, never guess. Ask humans only for material missing decisions; reuse task authorization.

Shared module paths agent/skills/... resolve under the verified installed shared-source root, never the project cwd. A missing path or capability blocks only the affected step: make no file copies or profile mutation. Never impersonate built-ins, invent JSON schemas/job APIs or emulate Pi-only controls. Read assigned modules in your own context.

Never launch helpers or agents, including through shell commands. One writer owns each candidate; read-only roles do not change candidate code or tests. Preserve existing writes, user work, candidate/worktree boundaries, security and project invariants. Keep active or dirty worktrees unless the user's exact-target discard authority says otherwise. Failed compiler, test and review repairs stay worker-owned until explicit user reassignment. Retry cap: at most 2 fix rounds per task and 2 review cycles per candidate, then reassess and return the evidence to main; a new distinct failure starts a fresh count; the cap is no refusal of authorized work. Leaves lack main history. A read-only role checks artifact output locations against the packet at handoff.

Honor user stops and temporary pauses. A cancelled, blank, timed-out or unanswered request is never approval.

Meaningful behavior needs a focused failing test or check before production changes when feasible, then passing evidence; explain exceptions and replacement checks. Do not weaken valid tests. Failed or empty launches do not satisfy gates; invalidate affected evidence after changes; a failed required gate blocks delivery. Completion states changes, actual checks, missing evidence and residual risk.

Readiness never grants commit, push, merge, publish, deploy or destructive-operation authority. Shared publication is separate explicit authority. Merge needs its own explicit approval naming the exact PR and the approved candidate HEAD SHA, bound to the verified candidate fingerprint; release needs a separate approval naming version and target SHA; neither authorizes the other, and nothing is inferred from commit, push, PR or an earlier approval, and single-use operation grants never carry merge or release authority, which need their separate approvals. For authorized commits or PRs read harness references/git-attribution.md first: it supplies attribution, not authority; keep the configured Git identity and change no global or repository Git settings merely to set it.

Your model, effort and tools are fixed by your launch: never upgrade silently or replay after tools or abort. Serena targets the candidate; QMD and Graphify references may live elsewhere and be stale; use supplied absolute graph paths; missing graphs do not authorize builds.

Before moving active database or build-output directories, obtain authorized downtime, stop owning processes and preserve database sidecar files. Unknown restart configuration does not block an otherwise authorized relocation; leave services stopped until the restart executable, environment and DB path are verified.
`;

type ContextFile = { path: string; content: string };

const normalizeLf = (text: string) => text.replace(/\r\n/g, "\n");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const samePath = (a: string, b: string) => foldCase(path.resolve(a)) === foldCase(path.resolve(b));

/** Roles that get the compact contract: integration-enabled, non-project sources, never the highest-privilege release-engineer (first slice). */
export const childContextEligible = (agent: { name: string; source?: string }, codeIntegrationsEnabled: boolean): boolean =>
	codeIntegrationsEnabled && agent.source !== "project" && agent.name !== "release-engineer";

const isData = (o: object, k: string) => {
	const d = Object.getOwnPropertyDescriptor(o, k);
	return d !== undefined && "value" in d && d.enumerable === true;
};
// Descriptors only: accessor-backed fields are never invoked. Proxy side effects are out of scope (not an authentication boundary).
const denseData = (a: unknown[]) => {
	if (Reflect.ownKeys(a).length !== a.length + 1) return false; // indices + length only: no extra, symbol or non-enumerable keys
	for (let i = 0; i < a.length; i++) if (!isData(a, String(i))) return false; // a hole fails here (every() would skip it)
	return true;
};
const plainEntry = (f: unknown): f is ContextFile =>
	f !== null && typeof f === "object" && Reflect.ownKeys(f).every((k) => typeof k === "string" && isData(f, k)) && isData(f, "path") && isData(f, "content") && typeof (f as ContextFile).path === "string" && typeof (f as ContextFile).content === "string";

/** Complete replacement for the one canonical global entry, or undefined (= leave everything as is). Pure: never mutates. */
export function planChildContext(contextFiles: unknown, globalPath: string): { index: number; entry: ContextFile } | undefined {
	if (!Array.isArray(contextFiles)) return undefined;
	if (!denseData(contextFiles)) return undefined; // hole, extra/symbol key or accessor-backed index is unexpected: keep full context
	if (!contextFiles.every(plainEntry)) return undefined;
	const matches = contextFiles.flatMap((file, index) => (samePath(file.path, globalPath) ? [index] : []));
	if (matches.length !== 1) return undefined; // missing or ambiguous duplicate global entry
	const file = contextFiles[matches[0]] as ContextFile;
	if (sha256(normalizeLf(file.content)) !== REVIEWED_POLICY_SHA256) return undefined; // custom, edited, other or future policy
	return { index: matches[0], entry: { ...file, content: COMPACT_LEAF_CONTRACT } };
}

/** Fail-open: one final element assignment after the full plan exists; any error leaves the full context. Returns whether it compacted. */
export function compactChildContext(contextFiles: unknown, globalPath: string): boolean {
	try {
		const plan = planChildContext(contextFiles, globalPath);
		if (!plan) return false;
		(contextFiles as ContextFile[])[plan.index] = plan.entry;
		return true;
	} catch {
		return false;
	}
}
