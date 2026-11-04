// Child context slice: the canonical global policy is compacted only for the reviewed bytes at the resolver-reported global path.
// Pure fake before_agent_start events (SDK-shaped systemPromptOptions); no Pi session, provider, model or helper agent runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The public SDK is not installed in this repo: resolve it to a data module exposing only getAgentDir.
const GLOBAL_DIR = path.join(os.tmpdir(), "child-context-agent-dir");
(globalThis as any).__childContextAgentDir = () => GLOBAL_DIR;
registerHooks({
	resolve(specifier: string, context: object, nextResolve: (s: string, c: object) => { url: string }) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript," + encodeURIComponent("export const getAgentDir = () => globalThis.__childContextAgentDir();"), shortCircuit: true };
		return nextResolve(specifier, context);
	},
} as never);
const { COMPACT_LEAF_CONTRACT, REVIEWED_POLICY_SHA256, childContextEligible, compactChildContext, planChildContext } = await import("../child-context.ts");
const { default: childContextEntry } = await import("../child-context-entry.ts");
const { assembleChildSystemPrompt } = await import("../code-integrations.ts");

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const extDir = path.join(repo, "agent", "extensions", "subagent");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const toLf = (text: string) => text.replace(/\r\n/g, "\n");
const POLICY_LF = toLf(fs.readFileSync(path.join(repo, "agent", "AGENTS.md"), "utf8"));
const POLICY_CRLF = POLICY_LF.replace(/\n/g, "\r\n");
const GLOBAL = path.join(GLOBAL_DIR, "AGENTS.md");
const file = (p: string, content: string) => ({ path: p, content });

// Minimal producer-shaped event: Pi hands every handler the same mutable systemPromptOptions object.
function fire(contextFiles: unknown, handlers = register()) {
	const event: any = { type: "before_agent_start", prompt: "task", systemPrompt: "base", systemPromptOptions: { cwd: "/w", contextFiles, sections: { keep: "x" }, selectedTools: ["read"], appendSystemPrompt: "role" } };
	for (const handler of handlers) handler(event);
	return event;
}
function register(): Array<(event: any) => unknown> {
	const registered: Array<[string, (event: any) => unknown]> = [];
	childContextEntry({ on: (name: string, handler: (event: any) => unknown) => registered.push([name, handler]) } as any);
	assert.deepEqual(registered.map(([name]) => name), ["before_agent_start"]);
	return registered.map(([, handler]) => handler);
}

test("canonical global entry (LF and CRLF) becomes the compact contract; path, order and every other entry are preserved", () => {
	for (const content of [POLICY_LF, POLICY_CRLF]) {
		const ancestor = file("/up/AGENTS.md", "ancestor custom");
		const project = file("/w/CLAUDE.md", "project rules");
		const input = [file(GLOBAL, content), ancestor, project];
		const event = fire(input);
		const out = event.systemPromptOptions.contextFiles;
		assert.equal(out.length, 3);
		assert.deepEqual(out[0], { path: GLOBAL, content: COMPACT_LEAF_CONTRACT });
		assert.equal(out[1], ancestor);
		assert.equal(out[2], project);
		assert.deepEqual(event.systemPromptOptions.sections, { keep: "x" });
		assert.equal(event.systemPrompt, "base");
	}
});

test("a project or ancestor file with identical canonical bytes is never the target", () => {
	const copy = file("/w/AGENTS.md", POLICY_LF);
	const ancestorCopy = file("/up/AGENTS.md", POLICY_CRLF);
	const custom = file(GLOBAL, "my own global rules");
	const input = [custom, ancestorCopy, copy];
	fire(input);
	assert.equal(input[1], ancestorCopy);
	assert.equal(input[2], copy);
	assert.equal(input[0], custom);
	assert.equal(planChildContext([ancestorCopy, copy], GLOBAL), undefined);
	// canonical global + identical project copy: only the global entry changes
	const both = [file(GLOBAL, POLICY_LF), copy];
	fire(both);
	assert.equal(both[0].content, COMPACT_LEAF_CONTRACT);
	assert.equal(both[1], copy);
});

test("custom, edited, normalized-away or wrong-path global entries keep full context", () => {
	const variants: Array<[string, string]> = [
		["one-character edit", POLICY_LF.replace("Pi engineering", "Pi engineering!")],
		["appended user line", POLICY_LF + "My extra rule.\n"],
		["BOM prefix", "\uFEFF" + POLICY_LF],
		["trailing whitespace", POLICY_LF + " "],
		["trimmed trailing newline", POLICY_LF.trimEnd()],
		["case folded", POLICY_LF.toLowerCase()],
		["lone CR line ends", POLICY_LF.replace(/\n/g, "\r")],
		["empty", ""],
	];
	for (const [label, content] of variants) {
		const input = [file(GLOBAL, content)];
		const snapshot = structuredClone(input);
		fire(input);
		assert.deepEqual(input, snapshot, label);
	}
	for (const wrong of [path.join(GLOBAL_DIR, "AGENTS.override.md"), path.join(GLOBAL_DIR, "sub", "AGENTS.md"), path.join(GLOBAL_DIR, "CLAUDE.md")]) {
		const input = [file(wrong, POLICY_LF)];
		fire(input);
		assert.equal(input[0].content, POLICY_LF, wrong);
	}
});

test("duplicate global entries, malformed shapes, frozen inputs and a throwing resolver all keep full context without throwing", () => {
	const dup = [file(GLOBAL, POLICY_LF), file(GLOBAL, POLICY_LF)];
	fire(dup);
	assert.equal(dup[0].content, POLICY_LF);
	assert.equal(dup[1].content, POLICY_LF);
	for (const bad of [undefined, null, "text", {}, [null], [file(GLOBAL, POLICY_LF), { path: 1, content: "x" }], [file(GLOBAL, POLICY_LF), { path: "/w/a", content: 5 }], [{ path: GLOBAL }]]) {
		const before = structuredClone(bad);
		assert.doesNotThrow(() => fire(bad));
		assert.deepEqual(bad, before);
		assert.equal(planChildContext(bad, GLOBAL), undefined);
	}
	const frozenArray = Object.freeze([file(GLOBAL, POLICY_LF)]);
	assert.doesNotThrow(() => fire(frozenArray));
	assert.equal(frozenArray[0].content, POLICY_LF);
	assert.equal(compactChildContext(frozenArray, GLOBAL), false);
	// Frozen file objects are replaced, never mutated.
	const frozenEntry = Object.freeze(file(GLOBAL, POLICY_LF));
	const live = [frozenEntry];
	fire(live);
	assert.equal(frozenEntry.content, POLICY_LF);
	assert.equal(live[0].content, COMPACT_LEAF_CONTRACT);
	(globalThis as any).__childContextAgentDir = () => { throw new Error("resolver failed"); };
	try {
		const input = [file(GLOBAL, POLICY_LF)];
		assert.doesNotThrow(() => fire(input));
		assert.equal(input[0].content, POLICY_LF);
	} finally {
		(globalThis as any).__childContextAgentDir = () => GLOBAL_DIR;
	}
});

test("repeated events are idempotent, a fresh event compacts again, and other handlers sections stay untouched", () => {
	const before = (event: any) => { event.systemPromptOptions.sections.early = "e"; };
	const after = (event: any) => { event.systemPromptOptions.sections.late = event.systemPromptOptions.contextFiles[0].content.length; };
	const thrower = () => { throw new Error("another extension failed"); };
	const handlers = [before, ...register(), after];
	const input = [file(GLOBAL, POLICY_LF)];
	const event = fire(input, handlers);
	assert.equal(event.systemPromptOptions.contextFiles[0].content, COMPACT_LEAF_CONTRACT);
	assert.deepEqual(event.systemPromptOptions.sections, { keep: "x", early: "e", late: COMPACT_LEAF_CONTRACT.length });
	assert.equal(handlers[1](event), undefined);
	handlers[1](event); // same event again
	assert.equal(event.systemPromptOptions.contextFiles[0].content, COMPACT_LEAF_CONTRACT);
	assert.equal(event.systemPromptOptions.contextFiles.length, 1);
	const fresh = fire([file(GLOBAL, POLICY_CRLF)], handlers);
	assert.equal(fresh.systemPromptOptions.contextFiles[0].content, COMPACT_LEAF_CONTRACT);
	// the runner isolates a failing sibling handler; ours does not depend on it
	const runnerLike = fire([file(GLOBAL, POLICY_LF)], [thrower, ...register()].map((h) => (e: any) => { try { h(e); } catch { /* runner emits an extension error */ } }));
	assert.equal(runnerLike.systemPromptOptions.contextFiles[0].content, COMPACT_LEAF_CONTRACT);
});

test("eligibility: integration-enabled, non-project, non-release roles only", () => {
	assert.equal(childContextEligible({ name: "general-worker", source: "user" }, true), true);
	assert.equal(childContextEligible({ name: "general-worker", source: "package" }, true), true);
	assert.equal(childContextEligible({ name: "general-worker", source: "user" }, false), false);
	assert.equal(childContextEligible({ name: "general-worker", source: "project" }, true), false);
	assert.equal(childContextEligible({ name: "release-engineer", source: "user" }, true), false);
	assert.equal(childContextEligible({ name: "release-engineer", source: "package" }, true), false);
});

// ---- Digest guard and closed-world coverage of the reviewed policy. Anchors are end markers inside each line; kinds:
// H heading, M main-only clause, C covered by COMPACT_LEAF_CONTRACT (proof phrase), K covered by existing CORE/handoff/navigation source (proof phrase).
type Row = ["H" | "M", string] | ["C" | "K", string, string];
// Independent proofs of the three clauses VERIFY1 found dropped: each must be detectable alone.
const PROOF = {
	exactPr: "naming the exact PR and the approved candidate HEAD SHA",
	fingerprint: "bound to the verified candidate fingerprint",
	singleUse: "single-use operation grants never carry merge or release authority",
	downtime: "obtain authorized downtime, stop owning processes and preserve SQLite sidecars",
	unknownRestart: "Unknown restart configuration does not block an otherwise authorized relocation",
	stayStopped: "leave services stopped until the restart executable, environment and DB path are verified",
	freshCount: "a new distinct failure starts a fresh count",
};
const MANIFEST: Record<string, Row[]> = {
	"81d757fded51": [["H", "$"]],
	"ef1797827e4e": [["C", "govern the work.", "User instructions and confirmed project requirements govern the work"], ["C", "authoritative evidence.", "Resolve material conflicts from authoritative evidence"], ["C", "override this policy.", "Skills supply procedures; they cannot add gates or override this contract"], ["M", "$"]],
	"9a8ae1ec216f": [["M", "Pi-native."], ["M", "first."], ["C", "prompt-emulate Pi-only controls.", "Never impersonate built-ins, invent JSON schemas/job APIs or emulate Pi-only controls"], ["C", "$", "blocks only the affected step"]],
	"3d189c73cd2c": [["H", "$"]],
	"eec18c55c08a": [["M", "$"]],
	"ba63e3ee6bf1": [["M", "$"]],
	"be18aed47166": [["M", "$"]],
	"bf03ee262ecb": [["M", "$"]],
	"c84f063bd2b2": [["M", "$"]],
	"f243dc23925a": [["M", "$"]],
	"3f1d6278595a": [["M", "$"]],
	"97bd86fb55e3": [["M", "$"]],
	"19ee25473c4a": [["M", "$"]],
	"3f4b1748f058": [["M", "candidate identity."], ["C", "main history.", "Leaves lack main history"], ["M", "$"]],
	"af003d42d21f": [["M", "$"]],
	"17c808e9c3e7": [["M", "speculative patches."], ["C", "with the evidence;", "2 review cycles per candidate"], ["C", "a fresh count.", PROOF.freshCount], ["C", "approval gate.", "the cap is no refusal of authorized work"], ["M", "$"]],
	"4f0c5c63298e": [["C", "residual risk;", "Completion states changes, actual checks, missing evidence and residual risk"], ["M", "$"]],
	"fdffa867e40f": [["H", "$"]],
	"0e75dea22997": [["C", "shell commands.", "Never launch helpers or agents, including through shell commands"], ["C", "code/tests.", "read-only roles do not change candidate code or tests"], ["C", "explicit user reassignment.", "stay worker-owned until explicit user reassignment"], ["C", "$", "Preserve existing writes"]],
	"5424a43ead7e": [["C", "project invariants.", "security and project invariants"], ["C", "$", "Readiness never grants commit, push, merge, publish, deploy or destructive-operation authority"]],
	"a492ba438e58": [["M", "no-publication instruction."], ["C", "HEAD SHA", PROOF.exactPr], ["C", "fingerprint);", PROOF.fingerprint], ["C", "target SHA;", "release needs a separate approval naming version and target SHA"], ["C", "the other,", "neither authorizes the other"], ["C", "earlier approval,", "nothing is inferred from commit, push, PR or an earlier approval"], ["C", "$", PROOF.singleUse]],
	"31029c7ed676": [["C", "valid tests.", "Do not weaken valid tests"], ["C", "affected writes;", "block the affected writes"], ["C", "$", "a failed required gate blocks delivery"]],
	"de624fc01704": [["C", "material missing decisions;", "Ask humans only for material missing decisions"], ["C", "reuse task authorization;", "reuse task authorization"], ["C", "no approval.", "is never approval"], ["C", "temporary pauses;", "Honor user stops and temporary pauses"], ["M", "$"]],
	"3d6e6fd81fb2": [["C", "replay after tools/abort;", "never upgrade silently or replay after tools or abort"], ["M", "$"]],
};
const KNOWN_SOURCES = ["code-integrations.ts", "compact-handoff.ts"].map((name) => fs.readFileSync(path.join(extDir, name), "utf8")).join("\n");

/** Closed world: every non-empty policy line is keyed by hash, its clauses tile the line exactly, and no manifest key is stale. */
function coverageGaps(policyLf: string): string[] {
	const gaps: string[] = [];
	const seen = new Set<string>();
	for (const line of policyLf.split("\n")) {
		if (!line) continue;
		const key = sha(line).slice(0, 12);
		const rows = MANIFEST[key];
		if (!rows) { gaps.push(`unclassified policy line ${key}: ${line.slice(0, 40)}`); continue; }
		seen.add(key);
		let cursor = 0;
		for (const [, anchor, proof] of rows) {
			void proof;
			if (anchor === "$") { cursor = line.length; break; }
			const at = line.indexOf(anchor, cursor);
			if (at < 0) { gaps.push(`anchor ${anchor} missing in ${key}`); cursor = line.length; break; }
			cursor = at + anchor.length;
			while (line[cursor] === " ") cursor++;
		}
		if (cursor < line.length) gaps.push(`uncovered tail in ${key}`);
	}
	for (const key of Object.keys(MANIFEST)) if (!seen.has(key)) gaps.push(`stale manifest entry ${key}`);
	return gaps;
}

test("reviewed digest: the canonical policy file matches and any policy edit invalidates digest and coverage", () => {
	assert.equal(sha(POLICY_LF), REVIEWED_POLICY_SHA256);
	assert.equal(sha(toLf(POLICY_CRLF)), REVIEWED_POLICY_SHA256);
	assert.deepEqual(coverageGaps(POLICY_LF), []);
	const future = POLICY_LF + "A new policy line nobody classified.\n";
	assert.notEqual(sha(future), REVIEWED_POLICY_SHA256);
	assert.match(coverageGaps(future).join("\n"), /unclassified policy line/);
	assert.equal(planChildContext([file(GLOBAL, future)], GLOBAL), undefined);
	const edited = POLICY_LF.replace("Resolve material conflicts", "Resolve some conflicts");
	assert.notEqual(coverageGaps(edited).length, 0);
});

test("every leaf-relevant clause has proof in the compact contract or existing child guidance; main-only text is excluded", () => {
	for (const rows of Object.values(MANIFEST)) {
		for (const [kind, anchor, proof] of rows) {
			if (kind === "C") assert.ok(COMPACT_LEAF_CONTRACT.includes(proof!), `contract lacks: ${proof} (${anchor})`);
			if (kind === "K") assert.ok(KNOWN_SOURCES.includes(proof!), `existing guidance lacks: ${proof} (${anchor})`);
		}
	}
	for (const marker of ["T0", "T1", "T4", "subagent_control", "subagent-decision", "modelSlot", "modelTier", "Copilot", "INCOMPLETE HANDOFF", "orchestrator only", "LEARN", "SAVED", "PLAN", "request_authorization", "ui-ux-specialist"]) {
		assert.ok(!COMPACT_LEAF_CONTRACT.includes(marker), `main-only marker leaked: ${marker}`);
	}
	const gross = Buffer.byteLength(POLICY_LF);
	const contract = Buffer.byteLength(COMPACT_LEAF_CONTRACT);
	assert.ok(contract < gross, "the contract must be smaller than the policy it replaces");
	console.log(`child-context bytes: policy(LF)=${gross} contract=${contract} net=${gross - contract}`);
});

test("each restored clause is proven independently: removing exactly one clause loses exactly that proof", () => {
	const proofs = Object.values(PROOF);
	for (const proof of proofs) {
		assert.ok(COMPACT_LEAF_CONTRACT.includes(proof), `contract lacks: ${proof}`);
		const mutated = COMPACT_LEAF_CONTRACT.replace(proof, "");
		assert.deepEqual(proofs.filter((p) => !mutated.includes(p)), [proof], `proofs overlap or clause not independent: ${proof}`);
	}
	// Merge and release approvals stay separate from single-use grants; relocation exception keeps its safety prerequisites.
	assert.match(COMPACT_LEAF_CONTRACT, /release needs a separate approval naming version and target SHA/);
	assert.match(COMPACT_LEAF_CONTRACT, /does not block an otherwise authorized relocation; leave services stopped/);
});

test("sparse or hole-containing context arrays are unexpected and stay unchanged full context", () => {
	for (const build of [() => { const a: any[] = new Array(2); a[1] = file(GLOBAL, POLICY_LF); return a; }, () => { const a: any[] = [file(GLOBAL, POLICY_LF), file("/w/x", "x")]; a.length = 3; return a; }, () => { const a: any[] = [file(GLOBAL, POLICY_LF), file("/w/x", "x")]; delete a[1]; return a; }]) {
		const sparse = build();
		const keys = Object.keys(sparse);
		assert.doesNotThrow(() => fire(sparse));
		assert.equal(planChildContext(sparse, GLOBAL), undefined);
		assert.equal(compactChildContext(sparse, GLOBAL), false);
		assert.deepEqual(Object.keys(sparse), keys);
		assert.equal(sparse.find((f) => f?.path === GLOBAL).content, POLICY_LF);
	}
});

test("hole plus extra named key, accessor-backed fields, non-enumerable and symbol keys are unexpected shapes and stay full context without being read", () => {
	const canon = () => file(GLOBAL, POLICY_LF);
	let reads = 0;
	const getter = (value: string) => ({ get() { reads++; return value; }, enumerable: true, configurable: true });
	const cases: Record<string, () => any[]> = {
		"hole and extra key cancel in the key count": () => { const a: any[] = new Array(2); a[0] = canon(); (a as any).publicExtra = 1; return a; },
		"accessor content": () => [Object.defineProperty({ path: GLOBAL }, "content", getter(POLICY_LF))],
		"accessor path": () => [Object.defineProperty({ content: POLICY_LF }, "path", getter(GLOBAL))],
		"accessor array index": () => { const a: any[] = [canon()]; Object.defineProperty(a, 0, { get() { reads++; return canon(); }, enumerable: true, configurable: true }); return a; },
		"inherited index": () => { const a: any[] = new Array(1); Object.setPrototypeOf(a, Object.assign([], { 0: canon() })); return a; },
		"non-enumerable entry field": () => [Object.defineProperty({ path: GLOBAL }, "content", { value: POLICY_LF, enumerable: false })],
		"symbol key on entry": () => [Object.assign(canon(), { [Symbol("x")]: 1 })],
		"symbol key on array": () => Object.assign([canon()], { [Symbol("x")]: 1 }),
	};
	for (const [label, build] of Object.entries(cases)) {
		const input = build();
		reads = 0;
		assert.doesNotThrow(() => fire(input), label);
		assert.equal(planChildContext(input, GLOBAL), undefined, label);
		assert.equal(compactChildContext(input, GLOBAL), false, label);
		assert.equal(reads, 0, `${label}: accessor consumed`);
		assert.ok(!input.some((f: any) => f?.content === COMPACT_LEAF_CONTRACT), label);
	}
	// canonical plain SDK-shaped arrays and entries still compact
	const plain = [canon()];
	assert.equal(compactChildContext(plain, GLOBAL), true);
});

test("assembled child prompts keep the existing shared guidance and gain the contract once per eligible role", () => {
	const agentsDir = path.join(repo, "agent", "agents");
	const roles = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".md") && name !== "release-engineer.md");
	assert.ok(roles.length >= 10);
	for (const name of roles) {
		const body = toLf(fs.readFileSync(path.join(agentsDir, name), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
		const prompt = assembleChildSystemPrompt({ name: name.replace(/\.md$/, ""), systemPrompt: body }, { codeIntegrationsEnabled: false, cwd: os.tmpdir(), packageRoot: null });
		const effective = prompt + "\n" + COMPACT_LEAF_CONTRACT;
		for (const phrase of ["## Shell syntax", "## Artifact placement", "Do not move live SQLite", "## Final handoff to main", "Never launch helpers or agents", "Readiness never grants commit", "an earlier approval", "references/git-attribution.md", "Keep active or dirty worktrees"]) {
			assert.ok(effective.includes(phrase), `${name}: ${phrase}`);
		}
		assert.equal(effective.split("# Pi leaf contract").length - 1, 1);
		if (name === "general-worker.md" || name === "backend-worker.md" || name === "reviewer.md" || name === "test-engineer.md" || name === "architecture-specialist.md") {
			const before = Buffer.byteLength(prompt) + Buffer.byteLength(POLICY_LF);
			const after = Buffer.byteLength(effective) - 1;
			console.log(`child-context static subset ${name}: before=${before} after=${after} net=${before - after} (role+CORE+handoff+global; LF bytes; excludes base prompt, tool defs, integrations)`);
		}
	}
});
