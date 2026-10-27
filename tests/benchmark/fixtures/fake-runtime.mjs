// Offline fakes for runner tests: a scripted adapter (no Pi session, no provider), a temp-directory workspace and a gate check.
// Synthetic only; these are never performance evidence.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODES } from "../lib/runner.mjs";
import * as realWorkspace from "../lib/workspace.mjs";
const { snapshot, diffSnapshots } = realWorkspace;

export const u = (input, output, cacheRead = 0, cacheWrite = 0, total = 0.01) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: total / 2, output: total / 4, cacheRead: total / 8, cacheWrite: total / 8, total } });
export const assistant = (usage) => ({ type: "assistant", message: { role: "assistant", usage, provider: "fake", model: "fake-model", content: [{ type: "text", text: "PRIVATE text" }] } });
export const subagent = (cost, agent = "debugger") => ({ type: "subagent", details: { mode: "single", results: [{ agent, exitCode: 0, usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost, turns: 1, contextTokens: 4 } }] } });
// The delegated writer's completed launch (expectedWriter general-worker): a measured child turn.
export const writerLaunch = (cost = 0) => subagent(cost, "general-worker");
const hexOf = (id, fill) => [...id].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(40, fill);
export const task = (id, over = {}) => ({ id, commit: hexOf(id, "c"), parent: hexOf(id, "d"), subject: `subject ${id}`, tier: "T1", category: "feature", riskRationale: "fixture", allowedFiles: ["agent/work.txt"], acceptanceTests: ["tests/gate.txt"], ...over });
export const manifest = (tasks) => ({ schemaVersion: "harness-benchmark-manifest/1", name: "fixture", expectedWriter: "general-worker", tasks });
export const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "bench-run-"));

// Resolved configuration as the CLI builds it (fixture values; the real defaults are read from roles.json in roles.test.mjs).
export const fixtureRoles = () => ({
	main: { model: "fake/main-model", fallbacks: [], thinking: "medium", source: "fixture profile default" },
	reviewer: { role: "reviewer", tier: "economy", model: "fake/review-model", fallbacks: ["fake/review-fallback"], thinking: "high", source: "fixture reviewer tier economy" },
});
export const fixtureRuntime = () => ({ root: "fixture-candidate", extensions: ["fixture-extension.ts"], fingerprint: "fixture-runtime-1" });
// The SDK's AgentSessionRuntime as the adapter uses it: dispose() emits session_shutdown to the extensions, then disposes the session.
export class FakeAgentSessionRuntime {
	constructor(session, services) { this.session = session; this.services = services; }
	async dispose() { await this.session.emitShutdown?.(); this.session.dispose(); }
}
export const fixtureLimits = () => ({ roundSettleTimeoutMs: { value: 600000, source: "fixture roles default" }, shutdownGraceMs: { value: 30000, source: "fixture roles default" }, taskTimeoutMs: { value: 1200000, source: "fixture roles default" } });
export const fixtureConfig = (over = {}) => ({ limits: fixtureLimits(), maxReworkRounds: { value: 2, source: "fixture roles default" }, diagnosticChars: { value: 300, source: "fixture roles default" }, roles: fixtureRoles(), runtime: fixtureRuntime(), ...over });

// Parent state: work.txt "broken", gate "red". Held-out content (post-task) is "green".
// tracked: extra materialized (tracked) files {path: text} that the parent commit carries; the policy is the real workspace's tool-state policy.
export function fakeWorkspace(base, { tracked = {} } = {}) {
	return {
		toolStatePolicy: realWorkspace.TOOL_STATE_POLICY,
		dirFor: (mode, t) => path.join(base, mode, MODES[mode].sessionPolicy === "shared-fixed-order" ? "shared" : t.id),
		async prepare(t, dir) {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
			fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
			fs.writeFileSync(path.join(dir, "agent/work.txt"), "broken");
			fs.writeFileSync(path.join(dir, "tests/gate.txt"), "red");
			for (const [p, text] of Object.entries(tracked)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
			return { files: 2 + Object.keys(tracked).length, paths: ["agent/work.txt", "tests/gate.txt", ...Object.keys(tracked)] };
		},
		async heldOut(t, dir) { fs.writeFileSync(path.join(dir, "tests/gate.txt"), "green"); },
		snapshot,
		diff: diffSnapshots,
	};
}

// Gate: passes only when the worker's file says "fixed" and the held-out gate is green.
export async function gate({ cwd }) {
	const ok = fs.readFileSync(path.join(cwd, "agent/work.txt"), "utf8") === "fixed" && fs.readFileSync(path.join(cwd, "tests/gate.txt"), "utf8") === "green";
	return { accepted: ok, exitCode: ok ? 0 : 1, pass: ok ? 1 : 0, fail: ok ? 0 : 1, reason: ok ? undefined : "gate red" };
}

// The reviewer contract as the SDK adapter records it (digests of the file and body; the fixture never reads agent/agents/reviewer.md).
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
// Effective reviewer resource identity as the SDK adapter records it (semantic hashes; the raw prompt digest only audits and is never compared).
export const reviewerResourcesFixture = (over = {}) => ({ promptSha256: sha("raw prompt"), effectivePromptSha256: sha("effective prompt"), resourcesSha256: sha("resources"), endResourcesSha256: sha("resources"), stable: true, ...over });
export const reviewerContractFixture = (body = "FIXTURE REVIEWER CONTRACT", resources = reviewerResourcesFixture()) => ({ resources,  role: "reviewer", file: "fixture/agents/reviewer.md", sha256: sha(`---\nname: reviewer\n---\n${body}`), bodySha256: sha(body), execution: "sdk-isolated-session-role-contract", nativeDispatch: false, tools: { declared: ["read", "grep", "find", "ls", "bash", "powershell"], session: ["read", "grep", "find", "ls"], excluded: ["bash", "powershell"] }, moduleReference: { path: "fixture/review/index.md", present: true }, appendLoaded: true });

// Scripted adapter: mainScript(session, text) returns { events, text }; reviewer returns reviewText.
// reviewSelected: the effective (e.g. fallback) reviewer model; contractBody: the reviewer contract body the session carries.
export function fakeAdapter({ mainScript, reviewText = "FINDING low: nit\nNO FINDINGS", compactFails = false, synthetic = true, reviewSelected, contractBody, reviewResources } = {}) {
	const log = []; let n = 0;
	return {
		log,
		describe: () => ({ name: "fake-adapter", synthetic, version: "0" }),
		async openSession(o) {
			const s = { id: ++n, ...o, calls: 0 };
			log.push(["open", s.id, o.role, o.compactionEnabled]);
			const configuredModel = o.roleSpec?.model;
			const model = o.role === "review" && reviewSelected ? reviewSelected : configuredModel;
			s.identity = { configured: o.roleSpec, selected: { model }, attempts: [{ model, status: "selected" }], observed: { model, thinking: o.roleSpec?.thinking ?? null }, servedThinking: "unknown" };
			if (o.role === "review") s.identity.contract = reviewerContractFixture(contractBody, reviewerResourcesFixture(reviewResources));
			return s;
		},
		async startContext(s) { log.push(["context", s.id]); return { contextTokens: 10 * (s.calls + 1), contextWindow: 1000, systemPromptChars: 500, activeTools: ["read"], messageCount: s.calls }; },
		async prompt(s, text) {
			const kind = text.startsWith("REWORK") ? "rework" : s.role === "review" ? "review" : "task";
			log.push(["prompt", s.id, s.role, kind]);
			s.calls++;
			if (s.role === "review") return { events: [assistant(u(5, 5, 50, 0, 0.02))], text: reviewText };
			return mainScript(s, text);
		},
		async compact(s) { log.push(["compact", s.id]); if (compactFails) throw new Error("summary model unavailable"); return { tokensBefore: 900, usage: u(30, 10, 0, 0, 0.05) }; },
		async closeSession(s) { log.push(["close", s.id]); },
	};
}

// Main pass that fixes the allowed file and produces one priced turn.
export function fixMain(s, text, usage = u(100, 20, 1000, 0, 0.1)) {
	fs.writeFileSync(path.join(s.cwd, "agent/work.txt"), "fixed");
	return { events: [writerLaunch(), assistant(usage)], text: "done" };
}
