// Worker decision relay regression.
// registerHooks + native TypeScript transform load the REAL index.ts/background.ts/decision-relay.ts.
// Only the pi package (existing runtime-doubles.mjs), child_process spawn and monitor UI are doubled.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";


await runNodeSuite();

async function runNodeSuite() {
	const { default: test, before, after, beforeEach, afterEach } = await import("node:test");
	const { registerHooks } = await import("node:module");
	const { EventEmitter } = await import("node:events");
	const doublesUrl = new URL("./fixtures/runtime-doubles.mjs", import.meta.url).href;
	const dataModule = (source: string) => "data:text/javascript," + encodeURIComponent(source);
	const childUrl = dataModule("export function spawn(command, args, options) { return globalThis.__piDecisionSpawn(command, args, options); } export function execFileSync() { throw new Error(\"no real process allowed\"); } export function spawnSync() { throw new Error(\"no real process allowed\"); }");
	const monitorUrl = dataModule("export class WorkerMonitor { constructor() { this.store = globalThis.__piDecisionStore; this.control = undefined; } }");
	const indexUrl = new URL("../index.ts", import.meta.url).href;
	const entryUrl = new URL("../provider-cooldown-entry.ts", import.meta.url).href;
	// Offline stub for the cooldown entry's pi-ai/compat delegate factories and stream constructor; never called in these tests.
	const cooldownStubUrl = dataModule("export const anthropicMessagesApi = () => ({ streamSimple: () => { throw new Error(\"offline stub\"); } }); export const openAICodexResponsesApi = anthropicMessagesApi; export function createAssistantMessageEventStream() { throw new Error(\"offline stub\"); }");
	registerHooks({
		resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: object) => { url: string }) {
			if (specifier === "@earendil-works/pi-ai/compat" || (specifier === "@earendil-works/pi-ai" && context.parentURL === entryUrl)) return { url: cooldownStubUrl, shortCircuit: true };
			if (specifier === "@earendil-works/pi-coding-agent" || specifier === "@earendil-works/pi-ai" || specifier === "typebox") return { url: doublesUrl, shortCircuit: true };
			if (specifier === "node:child_process") return { url: childUrl, shortCircuit: true };
			if (specifier === "./monitor.ts" && context.parentURL === indexUrl) return { url: monitorUrl, shortCircuit: true };
			return nextResolve(specifier, context);
		},
	} as never);
	const { default: subagentExtension } = await import(indexUrl);
	const relay: any = await import("../decision-relay-state.ts");
	const childExtension: any = (await import("../decision-relay.ts")).default;
	const { configureCodeIntegrations } = await import("../code-integrations.ts");

	const RECORD = "pi-worker-decision-request ";
	const DIALOG = "pi-decision ";
	const TOOL = "request_decision";
	const ENV = "PI_SUBAGENT_DECISION_RELAY";
	const REQ = "dec-aaaaaaaa1111";
	const REQ2 = "dec-bbbbbbbb2222";
	let root = "";
	let candidate = "";
	let originalAgentDir: string | undefined;
	let children: any[] = [];
	let pis: any[] = [];

	class Store {
		records = new Map<string, any>();
		n = 0;
		begin(name: string, task: string, model: string, thinking: string) {
			const id = "w:" + ++this.n;
			const r = { id, name, task, model, thinking, state: "running", activity: "", events: [] as string[], endedAt: undefined as number | undefined };
			this.records.set(id, r);
			return r;
		}
		started() {}
		event() {}
		finish(id: string, state: string) { const r = this.records.get(id); if (r) { r.state = state; r.endedAt = Date.now(); } }
		changed() {}
		list() { return [...this.records.values()]; }
		summary() { return ""; }
	}

	function makeChild(args: string[], options: any) {
		const child: any = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.exitCode = null;
		child.signalCode = null;
		child.stdin = new EventEmitter();
		child.stdin.writable = true;
		// Only background jobs load the relay extension; foreground runs are RPC-piped too, so stdio no longer marks them.
		const rec: any = {
			args, env: options.env, foreground: !args.some((arg) => arg.endsWith("decision-relay.ts")), lines: [] as any[], closed: false, stdin: child.stdin, fault: undefined as string | undefined, hold: false, held: [] as Array<() => void>, release() { for (const run of rec.held.splice(0)) run(); },
			emit(event: object) { child.stdout.emit("data", JSON.stringify(event) + "\n"); },
			exit(code: number | null = 0) { if (rec.closed) return; rec.closed = true; child.exitCode = code; child.emit("close", code); },
		};
		// Mock Node stdin: callbacks run asynchronously; a fault is a sync throw or an async EPIPE callback plus the stream 'error' event.
		child.stdin.write = (text: string, callback?: (e?: Error | null) => void) => {
			const messages = String(text).split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
			const isResponse = messages.some(message => message.type === "extension_ui_response");
			if (isResponse && rec.fault === "throw") { rec.fault = undefined; throw new Error("write threw synchronously"); }
			const error = isResponse && rec.fault === "epipe" ? Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) : undefined;
			if (error) rec.fault = undefined;
			for (const message of error ? [] : messages) {
				rec.lines.push(message);
				if (message.id && message.type && message.type !== "extension_ui_response") queueMicrotask(() => rec.emit({ type: "response", id: message.id, success: true, data: {} }));
			}
			const complete = () => setImmediate(() => { callback?.(error); if (error) child.stdin.emit("error", error); });
			if (rec.hold && isResponse) rec.held.push(complete); else complete();
			return true;
		};
		child.stdin.end = () => { child.stdin.writable = false; };
		child.kill = (signal = "SIGTERM") => { child.signalCode = signal; queueMicrotask(() => rec.exit(null)); return true; };
		children.push(rec);
		queueMicrotask(() => { child.emit("spawn"); if (rec.foreground) setTimeout(() => rec.exit(0), 5); });
		return child;
	}

	function fakePi() {
		const handlers = new Map<string, Array<(...a: any[]) => unknown>>();
		const tools = new Map<string, any>();
		const messages: Array<{ msg: any; opts: any }> = [];
		const pi = {
			tools, messages,
			on(name: string, fn: (...a: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
			registerTool(def: any) { tools.set(def.name, def); },
			registerProvider() {}, // Phase B: the default export registers the cooldown providers; no-op for this relay suite
			registerCommand() {},
			getCommands() { return []; },
			entries: [] as Array<{ customType: string; data: any }>, sendFault: undefined as undefined | "throw" | "async", appendFault: false, runnerErrors: [] as string[],
			// Pi's real pi.sendMessage returns void: a stale owner throws synchronously (assertActive); an async delivery failure is only reported on the runner's error channel (agent-session.js bindCore), never to the caller.
			sendMessage(msg: any, opts: any): void {
				messages.push({ msg, opts });
				if (pi.sendFault === "throw") throw new Error("This extension ctx is stale after session replacement or reload.");
				if (pi.sendFault === "async") Promise.reject(new Error("SECRET delivery failure text")).catch((e) => { pi.runnerErrors.push(e.message); });
			},
			appendEntry(customType: string, data: any) { if (pi.appendFault) throw new Error("This extension ctx is stale after session replacement or reload."); pi.entries.push({ customType, data }); },
			emit(name: string, ...args: any[]) { for (const fn of handlers.get(name) ?? []) fn(...args); },
			// Pi awaits session handlers: the returned promise settles when every handler of the event has.
			emitAsync(name: string, ...args: any[]) { return Promise.all((handlers.get(name) ?? []).map((fn) => fn(...args))); },
		};
		pis.push(pi);
		return pi;
	}

	async function waitFor(check: () => boolean, label: string, ms = 3000) {
		const end = Date.now() + ms;
		while (!check()) {
			if (Date.now() > end) throw new Error("timed out: " + label);
			await new Promise(resolve => setTimeout(resolve, 5));
		}
	}

	function tool(pi: any, name: string) { return pi.tools.get(name); }
	async function startJob(pi: any, task = "Decide the migration target", readOnly = false) {
		const before = children.length;
		const result = await tool(pi, "subagent").execute("call", { agent: "test-worker", task, readOnly }, undefined, undefined, { cwd: candidate, hasUI: false });
		assert.ok(result.details?.jobId, JSON.stringify(result));
		await waitFor(() => children.length > before, "spawn");
		return result.details.jobId as string;
	}
	async function control(pi: any, params: object) {
		const result = await tool(pi, "subagent_control").execute("ctl", params, undefined, undefined, {});
		return result;
	}
	function record(requestId: string, overrides: object = {}) {
		return { type: "worker_decision_request", requestId, question: "Use staging DB or fixture DB?", options: ["Staging", "Fixture"], context: "Migration step 3", blockedScope: "Writes to schema/ migration files", ...overrides };
	}
	function notifyEnvelope(payload: unknown, id = "n-" + Math.random().toString(36).slice(2)) {
		const message = typeof payload === "string" ? payload : RECORD + JSON.stringify(payload);
		return { type: "extension_ui_request", id, method: "notify", message, notifyType: "info" };
	}
	function dialog(id: string, requestId: string, method = "input", title = DIALOG + requestId) {
		return { type: "extension_ui_request", id, method, title, placeholder: "Main decides" };
	}
	function answersFor(rec: any, dialogId: string) {
		return rec.lines.filter((l: any) => l.type === "extension_ui_response" && l.id === dialogId);
	}
	function decisionMessages(pi: any, state?: string) {
		return pi.messages.filter((m: any) => m.msg.customType === "subagent-decision" && (state === undefined || m.msg.details?.state === state));
	}
	async function openRequest(pi: any, requestId = REQ, dialogId = "dlg-1") {
		const jobId = await startJob(pi, "Decide the migration target", true); // fake decision children never write the candidate
		await waitFor(() => children.length > 0, "spawn");
		const child = children[children.length - 1];
		child.emit(notifyEnvelope(record(requestId)));
		child.emit(dialog(dialogId, requestId));
		await waitFor(() => decisionMessages(pi, "open").length > 0, "main notified open");
		return { jobId, child, workerId: "w:" + children.length };
	}
	async function decisionList(pi: any) {
		const result = await control(pi, { action: "decisions" });
		return JSON.parse(result.content[0].text);
	}

	function mockRoot() {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "decision-relay-"));
		candidate = path.join(root, "candidate");
		fs.mkdirSync(path.join(root, "agent", "agents"), { recursive: true });
		fs.mkdirSync(candidate, { recursive: true });
		fs.writeFileSync(path.join(root, "agent", "agents", "test-worker.md"), "---\nname: test-worker\ndescription: Decision relay regression role\ntools: read, grep, find, ls, edit\n---\nTest worker prompt.\n");
	}

	before(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		mockRoot();
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		(globalThis as any).__piDecisionSpawn = (command: string, args: string[], options: any) => makeChild(args, options);
	});

	beforeEach(() => {
		children = [];
		pis = [];
		(globalThis as any).__piDecisionStore = new Store();
	});

	afterEach(() => {
		for (const pi of pis) pi.emit("session_shutdown");
		for (const child of children) child.exit(0);
	});

	after(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ---- Pure state: schema, limits, transitions (RED until decision-relay-state.ts exists)
	test("S1 strict bounded request schema rejects unknown keys, blank or oversized fields and bad ids", () => {
		assert.equal(relay.parseDecisionRequest(record(REQ)).ok, true);
		for (const bad of [
			record(REQ, { extra: true }),
			record(REQ, { question: "   " }),
			record(REQ, { question: "q".repeat(1001) }),
			record(REQ, { options: ["a", "b", "c", "d", "e", "f", "g"] }),
			record(REQ, { options: [""] }),
			record(REQ, { blockedScope: "" }),
			record("bad id!"),
			record(REQ, { type: "other" }),
			null,
		]) assert.equal(relay.parseDecisionRequest(bad).ok, false, JSON.stringify(bad));
	});

	test("S1b freeform request without options is valid (native ask_user-style text question)", () => {
		const parsed = relay.parseDecisionRequest({ type: "worker_decision_request", requestId: REQ, question: "Which batch size?", blockedScope: "Migration writes" });
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.request.options ?? [], []);
	});

	test("S2 registry: duplicate ids, second open request per worker and session cap of four are rejected", () => {
		const state = new relay.DecisionRelay();
		const ann = (jobId: string, workerId: string, requestId: string) => state.announce({ jobId, workerId, candidate, raw: record(requestId) });
		assert.equal(ann("bg-1", "w:1", REQ).ok, true);
		assert.equal(ann("bg-2", "w:2", REQ).ok, false, "collision");
		assert.equal(ann("bg-1", "w:1", REQ2).ok, false, "second open for same worker");
		assert.equal(ann("bg-2", "w:2", "dec-cccccccc3333").ok, true);
		assert.equal(ann("bg-3", "w:3", "dec-dddddddd4444").ok, true);
		assert.equal(ann("bg-4", "w:4", "dec-eeeeeeee5555").ok, true);
		assert.equal(ann("bg-5", "w:5", "dec-ffffffff6666").ok, false, "fifth open request");
	});

	test("S3 dialog hold requires exact title, input method, announced request and same worker/job", () => {
		const state = new relay.DecisionRelay();
		state.announce({ jobId: "bg-1", workerId: "w:1", candidate, raw: record(REQ) });
		const hold = (overrides: object) => state.holdDialog({ jobId: "bg-1", workerId: "w:1", method: "input", title: DIALOG + REQ, dialogId: "d1", ...overrides });
		assert.equal(hold({ method: "select" }), undefined, "select method not held");
		assert.equal(hold({ title: DIALOG + REQ + "x" }), undefined, "prefix-extended title not held");
		assert.equal(hold({ title: "pi-decision-" + REQ }), undefined, "non-exact title not held");
		assert.equal(hold({ workerId: "w:9" }), undefined, "other worker not held");
		assert.equal(hold({ jobId: "bg-9" }), undefined, "other job not held");
		assert.equal(hold({}).state, "open");
		assert.equal(hold({ dialogId: "d2" }), undefined, "second dialog for same request not held");
	});

	test("S4 answers require open state, validated answer text, basis and reference; late answers rejected", () => {
		const state = new relay.DecisionRelay();
		state.announce({ jobId: "bg-1", workerId: "w:1", candidate, raw: record(REQ) });
		const ok = { answer: "Fixture", basis: "user_answer", reference: "ask_user:m00124" };
		assert.equal(state.answer(REQ, ok).ok, false, "not open yet");
		state.holdDialog({ jobId: "bg-1", workerId: "w:1", method: "input", title: DIALOG + REQ, dialogId: "d1" });
		for (const bad of [{ ...ok, answer: "  " }, { ...ok, basis: "guess" }, { ...ok, reference: "" }, { answer: "x", basis: "existing_authorization" }]) assert.equal(state.answer(REQ, bad).ok, false, JSON.stringify(bad));
		const accepted = state.answer(REQ, ok);
		assert.equal(accepted.ok, true);
		assert.equal(JSON.parse(accepted.value).answer, "Fixture");
		assert.equal(state.answer(REQ, ok).ok, false, "second answer is late");
		assert.equal(state.decline(REQ, "no").ok, false, "decline after answer is late");
	});

	test("S5 settlement is exactly once per request and scoped to worker/job; reasons are inspectable", () => {
		const state = new relay.DecisionRelay();
		state.announce({ jobId: "bg-1", workerId: "w:1", candidate, raw: record(REQ) });
		state.holdDialog({ jobId: "bg-1", workerId: "w:1", method: "input", title: DIALOG + REQ, dialogId: "d1" });
		assert.equal(state.settleWorker("w:9", "worker-exited").length, 0, "other worker untouched");
		const settled = state.settleWorker("w:1", "worker-exited");
		assert.equal(settled.length, 1);
		assert.equal(settled[0].dialogId, "d1");
		assert.equal(settled[0].record.state, "settled");
		assert.equal(settled[0].record.reason, "worker-exited");
		assert.equal(state.settleWorker("w:1", "worker-exited").length, 0, "exactly once");
		assert.equal(state.answer(REQ, { answer: "x", basis: "user_answer", reference: "r" }).ok, false, "late answer rejected");
		assert.equal(state.list().find((r: any) => r.requestId === REQ).reason, "worker-exited");
	});

	// ---- Child relay tool (decision-relay.ts)
	test("C1 child tool is unavailable without the parent relay env or with no UI, emitting nothing", async () => {
		const pi = fakePi();
		childExtension(pi);
		const def = pi.tools.get(TOOL);
		const notes: string[] = [];
		const titles: string[] = [];
		const ui = { notify: (m: string) => notes.push(m), input: (t: string) => { titles.push(t); return new Promise(() => {}); } };
		const saved = process.env[ENV];
		delete process.env[ENV];
		try {
			const direct = await def.execute("c", { question: "Q", blockedScope: "S" }, undefined, undefined, { hasUI: true, ui });
			assert.equal(direct.details.status, "unavailable");
			process.env[ENV] = "1";
			const headless = await def.execute("c", { question: "Q", blockedScope: "S" }, undefined, undefined, { hasUI: false, ui });
			assert.equal(headless.details.status, "unavailable");
		} finally { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; }
		assert.deepEqual(notes, []);
		assert.deepEqual(titles, []);
	});

	test("C2 child emits the request before the exact dialog and returns a freeform answer unchanged", async () => {
		const pi = fakePi();
		childExtension(pi);
		const def = pi.tools.get(TOOL);
		const order: string[] = [];
		let resolveInput!: (v: string | undefined) => void;
		const ui = { notify: (m: string) => order.push("notify:" + m), input: (t: string) => { order.push("input:" + t); return new Promise<string | undefined>(r => { resolveInput = r; }); } };
		process.env[ENV] = "1";
		try {
			const run = def.execute("c", { question: "Which batch size?", options: ["100", "500"], blockedScope: "Migration writes" }, undefined, undefined, { hasUI: true, ui });
			await waitFor(() => order.length === 2, "notify then input");
			assert.ok(order[0].startsWith("notify:" + RECORD));
			const requestId = order[1].slice(("input:" + DIALOG).length);
			const payload = JSON.parse(order[0].slice(("notify:" + RECORD).length));
			assert.equal(payload.type, "worker_decision_request");
			assert.equal(payload.requestId, requestId);
			assert.equal(order[1], "input:" + DIALOG + requestId);
			resolveInput(JSON.stringify({ requestId, decision: "answered", answer: "Something else entirely", basis: "user_answer", reference: "ask_user:m00200" }));
			const result = await run;
			assert.equal(result.details.status, "answered");
			assert.equal(result.details.answer, "Something else entirely");
			assert.equal(result.details.basis, "user_answer");
			assert.equal(result.details.reference, "ask_user:m00200");
			assert.match(result.details.scope, /grants no tool/);
		} finally { delete process.env[ENV]; }
	});

	test("C3 no-options question is valid; cancelled, blank, mismatched or declined answers never approve", async () => {
		const pi = fakePi();
		childExtension(pi);
		const def = pi.tools.get(TOOL);
		process.env[ENV] = "1";
		try {
			for (const value of [undefined, "", "   ", "not json", JSON.stringify({ requestId: "dec-other", decision: "answered", answer: "Yes", basis: "user_answer", reference: "r" }), JSON.stringify({ requestId: "WILL", decision: "answered", answer: "Yes", basis: "existing_authorization" }), JSON.stringify({ requestId: "WILL", decision: "declined", reason: "not needed" })]) {
				let requestId = "";
				let resolveInput!: (v: string | undefined) => void;
				const ui = { notify: () => {}, input: (t: string) => { requestId = t.slice(DIALOG.length); return new Promise<string | undefined>(r => { resolveInput = r; }); } };
				const run = def.execute("c", { question: "Pick?", blockedScope: "Writes" }, undefined, undefined, { hasUI: true, ui });
				await waitFor(() => requestId !== "", "input");
				resolveInput(value?.replace("WILL", requestId));
				const result = await run;
				assert.equal(result.details.status, "cancelled", String(value));
				assert.equal(result.details.answer, undefined);
			}
			let requestId = "";
			let resolveInput!: (v: string | undefined) => void;
			const ui = { notify: () => {}, input: (t: string) => { requestId = t.slice(DIALOG.length); return new Promise<string | undefined>(r => { resolveInput = r; }); } };
			const run = def.execute("c", { question: "Pick?", blockedScope: "Writes" }, undefined, undefined, { hasUI: true, ui });
			await waitFor(() => requestId !== "", "declined input");
			resolveInput(JSON.stringify({ requestId, decision: "declined", reason: "Not needed" }));
			const declined = await run;
			assert.equal(declined.details.status, "cancelled");
			assert.equal(declined.details.reason, "Not needed");
		} finally { delete process.env[ENV]; }
	});

	// ---- Grants and roles (code-integrations.ts), real module
	test("G1 background grant adds only request_decision to the edit-role allowlist; default call unchanged", () => {
		const base: string[] = [];
		const agent = { name: "test-worker", description: "d", source: "user", filePath: "x", tools: ["read", "grep", "find", "ls", "edit"] };
		assert.equal(configureCodeIntegrations(base, agent), false);
		assert.equal(base[base.indexOf("--tools") + 1], "read,grep,find,ls,edit");
		const granted: string[] = [];
		configureCodeIntegrations(granted, agent, [TOOL]);
		assert.equal(granted[granted.indexOf("--tools") + 1], "read,grep,find,ls,edit," + TOOL);
	});

	// ---- Parent dispatch through the REAL index.ts default export, background.ts and fake child process
	test("P1 exact held dialog: request is announced, main notified once, no automatic cancel", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { jobId, child } = await openRequest(pi);
		assert.equal(answersFor(child, "dlg-1").length, 0, "dialog must not be auto-cancelled");
		const note = decisionMessages(pi, "open")[0].msg.content;
		for (const part of [REQ, candidate, "w:1", "Use staging DB or fixture DB?", "Staging", "Fixture", "Migration step 3", "Writes to schema/ migration files"]) assert.ok(note.includes(part), part);
		assert.equal(decisionMessages(pi)[0].msg.details.jobId, jobId);
		assert.equal(decisionMessages(pi)[0].opts.triggerTurn, true);
	});

	test("P2 unmatched dialogs keep the auto-cancel safeguard: other titles, methods and undeclared ids", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await startJob(pi);
		const child = children[0];
		await waitFor(() => children.length === 1, "spawn");
		child.emit(dialog("s1", REQ, "select"));
		child.emit(dialog("i2", REQ, "input", "Enter a value"));
		child.emit(dialog("i3", REQ2, "input"));
		child.emit(dialog("i4", REQ, "input", DIALOG + REQ + " extra"));
		await waitFor(() => answersFor(child, "i4").length === 1, "auto cancel");
		for (const id of ["s1", "i2", "i3", "i4"]) assert.deepEqual(answersFor(child, id)[0], { type: "extension_ui_response", id, cancelled: true });
		assert.equal(decisionMessages(pi).length, 0);
	});

	test("P3 malformed, colliding and excess announcements are rejected, reported and their dialogs cancelled", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const first = await openRequest(pi, REQ, "dlg-1");
		const child = first.child;
		child.emit(notifyEnvelope(record(REQ2, { extra: 1 })));
		child.emit(dialog("dlg-m", REQ2));
		child.emit(notifyEnvelope(record(REQ)));
		child.emit(dialog("dlg-c", REQ));
		child.emit(notifyEnvelope(record("dec-cccccccc3333")));
		child.emit(dialog("dlg-s", "dec-cccccccc3333"));
		await waitFor(() => answersFor(child, "dlg-s").length === 1, "second open cancelled");
		assert.deepEqual(answersFor(child, "dlg-m"), [{ type: "extension_ui_response", id: "dlg-m", cancelled: true }]);
		assert.deepEqual(answersFor(child, "dlg-c"), [{ type: "extension_ui_response", id: "dlg-c", cancelled: true }]);
		assert.equal(answersFor(child, "dlg-1").length, 0, "original held dialog untouched");
		assert.ok(decisionMessages(pi, "rejected").length >= 2, "rejections reported to main");
	});

	test("P4 answer routes only to the exact dialog of its request; unknown, blank, unbasic and late answers error", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		const good = { action: "answer", target: REQ, answer: "Fixture", basis: "user_answer", reference: "ask_user:m00124" };
		assert.equal((await control(pi, { ...good, target: "dec-unknown0000" })).isError, true, "unknown");
		assert.equal((await control(pi, { ...good, answer: "   " })).isError, true, "blank");
		assert.equal((await control(pi, { ...good, basis: "guess" })).isError, true, "basis");
		assert.equal((await control(pi, { ...good, basis: "existing_authorization", reference: undefined })).isError, true, "auth needs reference");
		assert.equal((await control(pi, { ...good, reference: "" })).isError, true, "reference required");
		assert.equal(answersFor(child, "dlg-1").length, 0, "validation errors write nothing");
		const accepted = await control(pi, good);
		assert.equal(accepted.isError, undefined);
		const lines = answersFor(child, "dlg-1");
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0].value), { requestId: REQ, decision: "answered", answer: "Fixture", basis: "user_answer", reference: "ask_user:m00124" });
		assert.equal((await control(pi, good)).isError, true, "late duplicate answer");
		assert.equal(answersFor(child, "dlg-1").length, 1, "exactly once");
		const declined = await openRequest(pi, REQ2, "dlg-2");
		await control(pi, { action: "decline", target: REQ2, reason: "Not needed; the task packet already fixes the target" });
		assert.deepEqual(JSON.parse(answersFor(declined.child, "dlg-2")[0].value).decision, "declined");
		assert.equal(answersFor(child, "dlg-2").length, 0, "decline never reaches another worker");
	});

	test("P5 decisions list exposes required fields and open state; pending is not reported as completed", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { jobId } = await openRequest(pi);
		const list = await decisionList(pi);
		const entry = list.find((d: any) => d.requestId === REQ);
		assert.ok(entry, JSON.stringify(list));
		for (const key of ["requestId", "jobId", "workerId", "candidate", "state", "question", "options", "blockedScope"]) assert.ok(key in entry, key);
		assert.equal(entry.state, "open");
		assert.equal(entry.jobId, jobId);
		const jobs = JSON.parse((await tool(pi, "subagent_control").execute("l", { action: "list" }, undefined, undefined, {})).content[0].text);
		assert.equal(jobs.find((j: any) => j.jobId === jobId).state, "running");
	});

	test("P6 cancel settles the pending request as cancelled and rejects later answers", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { jobId, child } = await openRequest(pi);
		await control(pi, { action: "cancel", target: jobId });
		await waitFor(() => answersFor(child, "dlg-1").length >= 1, "cancel delivered");
		assert.deepEqual(answersFor(child, "dlg-1")[0], { type: "extension_ui_response", id: "dlg-1", cancelled: true });
		assert.equal((await control(pi, { action: "answer", target: REQ, answer: "Fixture", basis: "user_answer", reference: "r" })).isError, true);
		const entry = (await decisionList(pi)).find((d: any) => d.requestId === REQ);
		assert.equal(entry.state, "settled");
		assert.equal(entry.reason, "cancelled");
	});

	test("P7 session reset settles pending requests before aborting, without hanging", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		pi.emit("session_shutdown");
		assert.deepEqual(answersFor(child, "dlg-1")[0], { type: "extension_ui_response", id: "dlg-1", cancelled: true });
		assert.equal((await decisionList(pi)).length, 0, "reset clears session state");
	});

	test("P8 worker exit settles pending as worker-exited; late answer never reaches another worker", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const a = await openRequest(pi, REQ, "dlg-1");
		const b = await openRequest(pi, REQ2, "dlg-2");
		a.child.exit(1);
		await waitFor(() => (decisionMessages(pi, "settled")).length >= 1, "settled notice");
		assert.equal(answersFor(b.child, "dlg-1").length, 0, "other worker untouched by exit");
		const late = await control(pi, { action: "answer", target: REQ, answer: "Fixture", basis: "user_answer", reference: "r" });
		assert.equal(late.isError, true);
		assert.equal(answersFor(b.child, "dlg-1").length, 0, "late answer routed nowhere else");
		assert.equal((await decisionList(pi)).find((d: any) => d.requestId === REQ).reason, "worker-exited");
	});

	test("P9 answer while job is paused records the answer but never resumes or unpauses the job", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { jobId, child } = await openRequest(pi);
		await control(pi, { action: "pause", target: jobId });
		const accepted = await control(pi, { action: "answer", target: REQ, answer: "Fixture", basis: "user_answer", reference: "ask_user:m00124" });
		assert.equal(accepted.isError, undefined);
		assert.equal(answersFor(child, "dlg-1").length, 1);
		const jobs = JSON.parse((await control(pi, { action: "list" })).content[0].text);
		assert.equal(jobs.find((j: any) => j.jobId === jobId).paused, true, "still paused");
		assert.equal(children[0].lines.filter((l: any) => l.type === "extension_ui_response").length, 1);
	});

	test("P10 an unrelated job keeps running while another worker waits on a decision", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await openRequest(pi);
		const otherJob = await startJob(pi, "Unrelated task", true);
		await waitFor(() => children.length === 2, "second spawn");
		const other = children[1];
		other.emit({ type: "agent_settled" });
		other.exit(0);
		await waitFor(() => pi.messages.some((m: any) => m.msg.customType === "subagent-completion" && m.msg.details.jobId === otherJob), "unrelated completion");
		assert.equal(answersFor(children[0], "dlg-1").length, 0, "waiting worker untouched");
	});

	test("P11 background spawn grants only request_decision and the child relay; foreground gets neither", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await startJob(pi, "Decide the migration target", true);
		const bg = children[0];
		const tools = bg.args[bg.args.indexOf("--tools") + 1];
		assert.equal(tools, "read,grep,find,ls,edit," + TOOL);
		assert.ok(bg.args.some((a: string) => a.endsWith("decision-relay.ts")), "relay extension loaded");
		assert.equal(bg.env[ENV], "1");
		await tool(pi, "subagent").execute("fg", { agent: "test-worker", task: "Foreground", background: false, readOnly: true }, undefined, undefined, { cwd: candidate, hasUI: false });
		await waitFor(() => children.length === 2, "foreground spawn");
		const fg = children[1];
		const fgTools = fg.args[fg.args.indexOf("--tools") + 1];
		assert.equal(fgTools.includes(TOOL), false);
		assert.equal(fg.args.some((a: string) => a.endsWith("decision-relay.ts")), false);
		assert.notEqual(fg.env[ENV], "1");
	});

	test("P12 unmatched select/confirm/editor dialogs with the relay title still auto-cancel", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await startJob(pi);
		const child = children[0];
		child.emit(dialog("c1", REQ, "confirm"));
		child.emit(dialog("e1", REQ, "editor"));
		await waitFor(() => answersFor(child, "e1").length === 1, "cancel");
		assert.equal(answersFor(child, "c1").length, 1);
	});

	// ---- Delivery: an answer is recorded only after the native stdin write callback confirms the stream write.
	function answerCall(pi: any, requestId = REQ) {
		return control(pi, { action: "answer", target: requestId, answer: "Fixture", basis: "user_answer", reference: "ask_user:m00124" });
	}
	function entryOf(list: any[], requestId = REQ) { return list.find((d: any) => d.requestId === requestId); }

	test("D1 synchronous stdin write failure: reported failed, nothing written, never recorded as answered", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.fault = "throw";
		const result = await answerCall(pi);
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0].text, /not delivered/);
		assert.equal(answersFor(child, "dlg-1").length, 0, "nothing reached the stream");
		const entry = entryOf(await decisionList(pi));
		assert.equal(entry.state, "settled");
		assert.match(entry.reason, /^delivery-failed: write threw synchronously/);
		assert.ok(decisionMessages(pi, "settled").some((m: any) => /delivery-failed/.test(m.msg.details.reason)), "main told the request failed");
		const notice = decisionMessages(pi, "settled").find((m: any) => /delivery-failed/.test(m.msg.details.reason)).msg.content;
		assert.match(notice, /parent registry is closed for this request/);
		assert.match(notice, /whether worker w:1 in job bg-1 received it or still waits on it is unconfirmed\./i);
		assert.doesNotMatch(notice, /no longer waits/);
		assert.equal((await answerCall(pi)).isError, true, "failed request stays terminal; no automatic retry");
		assert.equal(answersFor(child, "dlg-1").length, 0);
	});

	test("D2 async EPIPE callback with the stream error event: reported failed, not answered, no unhandled error", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.fault = "epipe";
		const result = await answerCall(pi);
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.equal(answersFor(child, "dlg-1").length, 0);
		const entry = entryOf(await decisionList(pi));
		assert.equal(entry.state, "settled");
		assert.match(entry.reason, /^delivery-failed: write EPIPE/);
		assert.equal((await answerCall(pi)).isError, true);
	});

	test("D3 closed stdin is reported unavailable and settles the request as not answered", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.stdin.writable = false;
		const result = await answerCall(pi);
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /unavailable/);
		assert.equal(answersFor(child, "dlg-1").length, 0);
		const entry = entryOf(await decisionList(pi));
		assert.equal(entry.state, "settled");
		assert.match(entry.reason, /^delivery-failed: worker input is closed/);
	});

	test("D4 success is recorded only after the stream write callback: in flight shows delivering, not answered", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.hold = true;
		let resolved = false;
		const pending = answerCall(pi).then(result => { resolved = true; return result; });
		await waitFor(() => answersFor(child, "dlg-1").length === 1, "write issued");
		const inFlight = entryOf(await decisionList(pi));
		assert.equal(inFlight.state, "delivering");
		assert.equal(inFlight.reason, undefined);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(resolved, false, "no success before the write callback");
		child.release();
		const result = await pending;
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.match(result.content[0].text, /stream write confirmed/);
		const done = entryOf(await decisionList(pi));
		assert.equal(done.state, "settled");
		assert.equal(done.reason, "answered");
	});

	test("D5 duplicate answer while the first write is pending is rejected; exactly one response is written", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.hold = true;
		const first = answerCall(pi);
		await waitFor(() => answersFor(child, "dlg-1").length === 1, "first write issued");
		const second = await answerCall(pi);
		assert.equal(second.isError, true);
		assert.match(second.content[0].text, /already being delivered/);
		child.release();
		assert.equal((await first).isError, undefined);
		assert.equal(answersFor(child, "dlg-1").length, 1, "exactly one response written");
	});

	test("D6 cancel during an in-flight write settles once as cancelled; the late callback cannot resurrect answered", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { jobId, child } = await openRequest(pi);
		child.hold = true;
		const first = answerCall(pi);
		await waitFor(() => answersFor(child, "dlg-1").length === 1, "write issued");
		assert.equal((await control(pi, { action: "cancel", target: jobId })).isError, undefined);
		child.release();
		const result = await first;
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0].text, /settled \(cancelled\)/);
		assert.equal(answersFor(child, "dlg-1").length, 1, "cancel adds no second response on the in-flight dialog");
		const entry = entryOf(await decisionList(pi));
		assert.equal(entry.state, "settled");
		assert.equal(entry.reason, "cancelled");
		assert.equal((await answerCall(pi)).isError, true);
	});

	test("D7 session reset during an in-flight write settles once: no second response, no answered record", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.hold = true;
		const first = answerCall(pi);
		await waitFor(() => answersFor(child, "dlg-1").length === 1, "write issued");
		pi.emit("session_shutdown");
		child.release();
		const result = await first;
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0].text, /settled \(session-reset\)/);
		assert.equal(answersFor(child, "dlg-1").length, 1, "reset adds no second response");
		assert.equal((await decisionList(pi)).length, 0, "reset cleared the request");
	});

	test("D8 worker exit during an in-flight write settles as worker-exited; the late callback is never answered", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { child } = await openRequest(pi);
		child.hold = true;
		const first = answerCall(pi);
		await waitFor(() => answersFor(child, "dlg-1").length === 1, "write issued");
		child.exit(1);
		child.release();
		const result = await first;
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0].text, /settled \(worker-exited\)/);
		assert.equal(entryOf(await decisionList(pi)).reason, "worker-exited");
		assert.equal(answersFor(child, "dlg-1").length, 1, "exit adds no second response");
	});

	const finishWith = (child: any, text: string, usage: object) => {
		child.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, model: "fake/model", provider: "fake", stopReason: "stop" } });
		child.emit({ type: "agent_settled" });
		child.exit(0);
	};
	const completionOf = (pi: any, jobId: string) => pi.messages.find((m: any) => m.msg.customType === "subagent-completion" && m.msg.details.jobId === jobId)?.msg;

	test("E1 the completion carries per-worker usage and outcome in its details only; the notice content is the bounded text and states no usage", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const jobId = await startJob(pi, "Measure me", true);
		finishWith(children[0], "WORKER-REPORT", { input: 11, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 19, cost: { total: 0.0234 } });
		await waitFor(() => completionOf(pi, jobId) !== undefined, "completion");
		const msg = completionOf(pi, jobId);
		assert.match(msg.content, /^Subagent job bg-\d+ completed\. Workers: /);
		assert.match(msg.content, /WORKER-REPORT/);
		assert.doesNotMatch(msg.content, /0\.0234|cacheRead|"usage"/, "usage is never model-visible text");
		const [r] = msg.details.results;
		assert.deepEqual([msg.details.jobId, msg.details.state, r.agent, r.exitCode, r.stopReason, r.model], [jobId, "completed", "test-worker", 0, "stop", "fake/model"]);
		assert.deepEqual(r.usage, { input: 11, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.0234, turns: 1, contextTokens: 19 });
	});

	test("E2 an oversized report keeps the 4000 code unit notice bound byte for byte while the metadata still reports usage", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const jobId = await startJob(pi, "Long report", true);
		finishWith(children[0], "L".repeat(9000), { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.5 } });
		await waitFor(() => completionOf(pi, jobId) !== undefined, "completion");
		const msg = completionOf(pi, jobId);
		assert.ok(msg.content.length <= 4000, `notice ${msg.content.length}`);
		assert.equal(msg.details.results[0].usage.cost, 0.5);
		assert.doesNotMatch(msg.content, /"cost"/);
	});

	test("E3 session_shutdown aborts a running background worker and resolves only after that worker closed", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await startJob(pi, "Still running at shutdown", true);
		const child = children[0];
		let closedAt = 0;
		const originalExit = child.exit.bind(child);
		child.exit = (code?: number | null) => { setTimeout(() => { closedAt = Date.now(); originalExit(code); }, 40); }; // a slow close: the handler must wait for it
		const settled = await Promise.race([pi.emitAsync("session_shutdown").then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
		assert.equal(settled, "settled");
		assert.ok(closedAt > 0, "the worker process was closed before the shutdown handlers resolved");
		assert.equal(pi.messages.some((m: any) => m.msg.customType === "subagent-completion"), false, "no completion is delivered into a closed session");
	});

	const sessionCtx = (id: string) => ({ sessionManager: { getSessionId: () => id } });
	const auditsOf = (pi: any, type = "subagent-terminal-audit") => pi.entries.filter((e: any) => e.customType === type).map((e: any) => e.data);
	const USAGE = { input: 11, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 19, cost: { total: 0.0234 } };

	test("B2 native receipts and results carry structured details.roles from the requested agent names, not from displayed text", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const receipt = await tool(pi, "subagent").execute("call", { tasks: [{ agent: "test-worker", task: "a", readOnly: true }, { agent: "test-worker", task: "b", readOnly: true }], background: true }, undefined, undefined, { cwd: candidate, hasUI: false });
		assert.deepEqual(receipt.details.roles, ["test-worker", "test-worker"], "duplicate roles stay distinct entries");
		assert.equal(receipt.details.background, true);
	});

	test("F4 an unregistered secret-shaped role and control target go through the native refusal and control wrapper, the adapter normaliser and serialisation without a trace of the raw name", async () => {
		const { normalise } = await import("../../../../tests/benchmark/lib/sdk-adapter.mjs");
		const SECRET = "sk-reviewsynthetic0123456789";
		const pi = fakePi();
		subagentExtension(pi);
		const refused = await tool(pi, "subagent").execute("call", { tasks: [{ agent: "test-worker", task: "a", readOnly: true }, { agent: SECRET, task: "b", readOnly: true }], background: true }, undefined, undefined, { cwd: candidate, hasUI: false });
		assert.equal(refused.isError, true, "an unknown role launches nothing");
		assert.deepEqual([refused.details.roles, refused.details.rolesInvalid], [["test-worker"], 1], "the registered role is kept, the unknown one only counted");
		assert.equal(JSON.stringify(refused.details).includes(SECRET), false);
		const odd = await control(pi, { action: "cancel", target: SECRET });
		assert.equal(odd.details.control.target, undefined);
		const ctx = { session: "sess-A", roles: new Set(["test-worker"]) };
		const events = [
			normalise({ type: "tool_execution_end", toolName: "subagent", toolCallId: "c1", isError: true, result: { content: [{ type: "text", text: "refused" }], details: refused.details } }, ctx),
			normalise({ type: "tool_execution_end", toolName: "subagent_control", toolCallId: "c2", isError: true, result: { content: [{ type: "text", text: "refused" }], details: { ...odd.details, control: { action: "cancel", target: SECRET } } } }, ctx),
		];
		assert.equal(JSON.stringify(events).includes(SECRET), false, "even a producer that did leak the raw name is stopped by the adapter's grammar");
	});

	test("B4 subagent_control reports only an action enum and a safe id in structured details, never steer, answer or authorization bodies", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const jobId = await startJob(pi, "control me", true);
		const steer = await control(pi, { action: "steer", target: jobId, message: "SECRET-STEER-BODY" });
		assert.deepEqual(steer.details.control, { action: "steer", target: jobId });
		const answer = await control(pi, { action: "answer", target: "dec-0123456789ab", answer: "SECRET-ANSWER", basis: "existing_authorization", reference: "SECRET-TOKEN" });
		assert.deepEqual(answer.details.control, { action: "answer", target: "dec-0123456789ab" }, "an error result keeps the same safe shape");
		const odd = await control(pi, { action: "steer", target: "bad target with spaces SECRET", message: "x" });
		assert.equal(odd.details.control.target, undefined, "an unsafe target is omitted, not echoed");
		assert.equal(JSON.stringify([steer.details, answer.details, odd.details]).includes("SECRET"), false);
	});

	test("B5 a normal completion appends one hidden terminal audit that keeps the owner, stable worker identity and charged usage, and the notice is unchanged", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-A"));
		const jobId = await startJob(pi, "Audit me", true);
		finishWith(children[0], "WORKER-REPORT", USAGE);
		await waitFor(() => completionOf(pi, jobId) !== undefined && auditsOf(pi).length > 0, "completion and audit");
		const [audit] = auditsOf(pi);
		assert.equal(audit.ownerSession, "sess-A");
		assert.equal(audit.jobId, jobId);
		assert.equal(audit.state, "completed");
		assert.equal(audit.completionSuppressed, false);
		assert.equal(audit.results[0].position, 0);
		assert.equal(audit.results[0].agent, "test-worker");
		assert.equal(audit.results[0].usage.cost, 0.0234);
		assert.deepEqual(audit.results[0].usage, completionOf(pi, jobId).details.results[0].usage, "same numbers as the completion, so the adapter counts them once");
		assert.equal(typeof audit.endedAt, "number");
		assert.equal(JSON.stringify(audit).includes("WORKER-REPORT"), false, "no worker output or prompt in the hidden audit");
		assert.equal(pi.messages.filter((m: any) => m.msg.customType === "subagent-completion").length, 1, "the audit adds no model message or turn");
	});

	test("B5 a shutdown generation suppresses the model completion but the hidden audit retains the charged terminal usage before the owner is forgotten", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-S"));
		const jobId = await startJob(pi, "Cancel me", true);
		children[0].emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: USAGE, model: "fake/model", provider: "fake", stopReason: "toolUse" } });
		await pi.emitAsync("session_shutdown", {}, sessionCtx("sess-S"));
		assert.equal(pi.messages.some((m: any) => m.msg.customType === "subagent-completion"), false, "no model completion into a closed session");
		const audits = auditsOf(pi).filter((a: any) => a.jobId === jobId);
		assert.equal(audits.length, 1, "exactly one audit for the cancelled job");
		assert.equal(audits[0].ownerSession, "sess-S");
		assert.equal(audits[0].state, "aborted");
		assert.equal(audits[0].completionSuppressed, true);
		assert.equal(audits[0].results[0].usage.cost, 0.0234, "charged usage of the interrupted worker is kept");
		assert.equal(audits[0].results[0].usage.turns, 1);
	});

	test("B5 a completion that cannot be delivered records a bounded owner diagnostic code, does not retry, and never stores the error text", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-D"));
		pi.sendFault = "throw";
		const jobId = await startJob(pi, "Undeliverable", true);
		finishWith(children[0], "WORKER-REPORT", USAGE);
		await waitFor(() => auditsOf(pi, "subagent-delivery-diagnostic").length > 0, "diagnostic");
		const [diag] = auditsOf(pi, "subagent-delivery-diagnostic");
		assert.deepEqual([diag.code, diag.jobId, diag.ownerSession], ["completion_delivery_failed", jobId, "sess-D"]);
		assert.equal(JSON.stringify(diag).includes("SECRET"), false);
		assert.equal(pi.messages.filter((m: any) => m.msg.customType === "subagent-completion").length, 1, "no retry or second wake-up");
		assert.equal(auditsOf(pi)[0].completion, "submit_failed", "the terminal audit distinguishes a failed submission from a working job");
	});

	test("F3 pi.sendMessage returns void: an async delivery failure is not seen by the caller, so the audit records a submission attempt and never a confirmed delivery or a made-up failure", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-V"));
		pi.sendFault = "async";
		const jobId = await startJob(pi, "Async failure", true);
		finishWith(children[0], "WORKER-REPORT", USAGE);
		await waitFor(() => auditsOf(pi).length > 0 && pi.runnerErrors.length > 0, "audit and runner error");
		const [audit] = auditsOf(pi);
		assert.equal(audit.completion, "submitted");
		assert.equal("completionDelivered" in audit, false, "no delivery claim exists in the audit");
		assert.equal(auditsOf(pi, "subagent-delivery-diagnostic").length, 0, "an uncorrelatable async failure is not attributed to the job");
		assert.equal(JSON.stringify(pi.entries).includes("SECRET"), false);
		assert.equal(pi.messages.filter((m: any) => m.msg.customType === "subagent-completion").length, 1, "no retry or second wake-up");
		assert.equal(audit.jobId, jobId);
	});


	test("B5 the completion notice is byte-identical whether or not a hidden audit could be appended", async () => {
		const contentOf = async (appendFault: boolean) => {
			const pi = fakePi();
			subagentExtension(pi);
			pi.appendFault = appendFault;
			const jobId = await startJob(pi, "Same notice", true);
			finishWith(children.at(-1), "WORKER-REPORT", USAGE);
			await waitFor(() => completionOf(pi, jobId) !== undefined, "completion");
			return (completionOf(pi, jobId).content as string).replace(/w:\d+/g, "w:N"); // the worker counter is process-wide, not part of the notice logic under test
		};
		assert.equal(await contentOf(true), await contentOf(false));
	});

	test("B5 a job keeps the session that launched it as owner after the session is replaced; the new session's id never appears on it", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-A"));
		const jobId = await startJob(pi, "Old owner", true);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-B")); // replacement resets and aborts the old session's job
		await waitFor(() => auditsOf(pi).some((a: any) => a.jobId === jobId), "old-owner audit");
		assert.deepEqual(auditsOf(pi).filter((a: any) => a.jobId === jobId).map((a: any) => [a.ownerSession, a.completionSuppressed]), [["sess-A", true]]);
	});

	test("B3 the real audit and completion of one worker compose into a single ledger entry through the adapter's own normaliser and the usage ledger", async () => {
		const { normalise } = await import("../../../../tests/benchmark/lib/sdk-adapter.mjs");
		const { emptyLedger, addAuditUsage, markUnknown, ledgerTotals } = await import("../../../../tests/benchmark/lib/usage.mjs");
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-C"));
		const done = await startJob(pi, "Completes", true);
		finishWith(children[0], "R", USAGE);
		await waitFor(() => completionOf(pi, done) !== undefined && auditsOf(pi).length === 1, "first job");
		const cancelled = await startJob(pi, "Cancelled", true);
		children[1].emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: { ...USAGE, cost: { total: 0.5 } }, model: "fake/model", provider: "fake", stopReason: "toolUse" } });
		await pi.emitAsync("session_shutdown", {}, sessionCtx("sess-C"));
		const ctx = { at: () => 1, session: "sess-C" };
		const audits = pi.entries.map((e: any) => normalise({ type: "entry_appended", entry: { type: "custom", id: e.customType + e.data.jobId, customType: e.customType, data: e.data } }, ctx)).filter((n: any) => n?.type === "audit");
		const completion = normalise({ type: "message_end", message: { role: "custom", customType: "subagent-completion", content: completionOf(pi, done).content, details: completionOf(pi, done).details } }, ctx);
		assert.deepEqual(audits.map((a: any) => a.jobKey).sort(), [`sess-C/${done}`, `sess-C/${cancelled}`].sort());
		const seen = new Set<string>(); const ledger = emptyLedger("worker");
		for (const ev of [completion, ...audits]) { if (seen.has(ev.jobKey)) continue; seen.add(ev.jobKey); addAuditUsage(ledger, ev); } // the runner's first-wins rule
		const t = ledgerTotals(ledger);
		assert.equal(t.launches, 2);
		assert.ok(Math.abs(t.cost.knownPricedSubtotal - 0.5234) < 1e-9, `subtotal ${t.cost.knownPricedSubtotal}`);
		assert.equal(t.cost.total, null, "the cancelled worker's in-flight stream makes the total unknown");
		assert.deepEqual(t.cost.unresolved.map((u: any) => u.reason), ["aborted_in_flight_usage_unknown"]);
		void markUnknown;
	});

	test("B5 a stale owner context (session replaced) makes appendEntry throw; the job still settles and nothing leaks", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		await pi.emitAsync("session_start", {}, sessionCtx("sess-old"));
		const jobId = await startJob(pi, "Stale owner", true);
		pi.appendFault = true;
		finishWith(children[0], "WORKER-REPORT", USAGE);
		await waitFor(() => completionOf(pi, jobId) !== undefined, "completion still delivered");
		assert.equal(pi.entries.length, 0, "nothing appended through an invalidated owner");
	});

	// Fills the three other global slots, then a two-task parallel call: task 0 runs (slot 4), task 1 waits for a slot. Abort rejects the queued entry at once while the running one closes late.
	async function slotsFullThenParallel(pi: any, background: boolean, signal?: AbortSignal) {
		for (let i = 0; i < 3; i++) await startJob(pi, "Slot holder " + i, true);
		const before = children.length;
		const tasks = [{ agent: "test-worker", task: "Running sibling", readOnly: true }, { agent: "test-worker", task: "Queued sibling", readOnly: true }];
		const call = tool(pi, "subagent").execute("par", { tasks, background }, signal, undefined, { cwd: candidate, hasUI: false });
		await waitFor(() => children.length > before, "running sibling spawn");
		const sibling = children[before];
		const state = { closedAt: 0 };
		const originalExit = sibling.exit.bind(sibling);
		sibling.exit = (code?: number | null) => { setTimeout(() => { state.closedAt = Date.now(); originalExit(code); }, 60); }; // slow close of the running sibling
		return { call, sibling, state };
	}

	test("E4 shutdown with a parallel job whose queued entry rejects on abort still waits for the running sibling to close", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { call, state } = await slotsFullThenParallel(pi, true);
		await call;
		const settled = await Promise.race([pi.emitAsync("session_shutdown").then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 3000))]);
		assert.equal(settled, "settled");
		assert.ok(state.closedAt > 0, "the running sibling was closed before shutdown resolved");
	});

	test("E5 a second shutdown while the first is still draining does not resolve before the outstanding worker closed", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const { call, state } = await slotsFullThenParallel(pi, true);
		await call;
		const first = pi.emitAsync("session_shutdown");
		await pi.emitAsync("session_shutdown"); // tracking survives the first reset
		assert.ok(state.closedAt > 0, "the second shutdown waited for the sibling the first one aborted");
		await first;
	});

	test("E6 a foreground parallel call aborted with a queued entry settles only after the running sibling closed", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const controller = new AbortController();
		const { call, state } = await slotsFullThenParallel(pi, false, controller.signal);
		call.catch(() => undefined);
		controller.abort();
		await call.then(() => undefined, () => undefined);
		assert.ok(state.closedAt > 0, "the foreground call returned only after its started child closed");
	});

	const chargedTurn = { type: "message_end", message: { role: "assistant", api: "fixture", provider: "fixture", model: "fixture", content: [{ type: "text", text: "partial work" }], stopReason: "toolUse", timestamp: 1, usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: .03, output: .02, cacheRead: 0, cacheWrite: 0, total: .05 } } } };

	test("F2a an aborted foreground child keeps its charged turn as a terminal result, never a prelaunch refusal", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		(globalThis as any).__piDecisionSpawn = (_command: string, args: string[], options: any) => { const proc = makeChild(args, options); children.at(-1).foreground = false; return proc; };
		const controller = new AbortController();
		const call = tool(pi, "subagent").execute("charged-fg", { agent: "test-worker", task: "Offline charged child", background: false, readOnly: true }, controller.signal, undefined, { cwd: candidate, hasUI: false });
		const outcome = call.then((result: any) => ({ result }), (error: any) => ({ error: error.message }));
		await waitFor(() => children.length === 1, "mock foreground spawn");
		children[0].emit(chargedTurn);
		controller.abort();
		const native: any = await outcome;
		assert.equal(children[0].closed, true, "the child closed before the call resolved");
		assert.ok(native.result, "the abort is returned as a terminal result, not thrown (Pi turns a throw into empty details)");
		assert.equal(native.result.isError, true, "an abort is never success");
		const [row] = native.result.details.results;
		assert.equal(row.stopReason, "aborted");
		assert.equal(row.usage.turns, 1);
		assert.ok(Math.abs(row.usage.cost - .05) < 1e-9);
		// Composed with the benchmark ledger: the actual details, as Pi delivers them, charge both children exactly once.
		const f = await import("../../../../tests/benchmark/fixtures/fake-runtime.mjs");
		const { runBenchmark } = await import("../../../../tests/benchmark/lib/runner.mjs");
		const event = { type: "subagent", toolCallId: "charged-fg", isError: true, text: "", details: native.result.details };
		const ad = f.fakeAdapter({ mainScript: (session: any) => { fs.writeFileSync(path.join(session.cwd, "agent/work.txt"), "fixed"); return { events: [f.assistant(f.u(1, 1)), { ...f.writerLaunch(.04), toolCallId: "healthy-writer" }, event], text: "main ended" }; } });
		const result = await runBenchmark({ manifest: f.manifest([f.task("H1")]), mode: "fresh", adapter: ad, workspace: f.fakeWorkspace(f.root()), acceptance: f.gate, config: f.fixtureConfig() });
		const t = result.tasks[0];
		assert.equal(t.status, "infrastructure", "an actually aborted charged child is not a recoverable prelaunch refusal");
		assert.ok(Math.abs(t.worker.cost.total - .09) < 1e-9, "both child costs are retained once");
		assert.equal(t.worker.turns, 2);
	});

	test("F2b a cancelled parallel background job keeps the charged sibling and marks the queued entry honestly not started", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		for (let i = 0; i < 3; i++) await startJob(pi, "slot holder " + i, true);
		const receipt = await tool(pi, "subagent").execute("parallel", { tasks: [{ agent: "test-worker", task: "charged sibling", readOnly: true }, { agent: "test-worker", task: "queued sibling", readOnly: true }], background: true }, undefined, undefined, { cwd: candidate, hasUI: false });
		await waitFor(() => children.length === 4, "parallel active sibling");
		children[3].emit(chargedTurn);
		const id = receipt.details.jobId;
		await control(pi, { action: "cancel", target: id });
		await waitFor(() => pi.messages.some((m: any) => m.msg.customType === "subagent-completion" && m.msg.details.jobId === id), "completion");
		assert.equal(children[3].closed, true, "the started sibling closed before the job completed");
		const done = pi.messages.find((m: any) => m.msg.customType === "subagent-completion" && m.msg.details.jobId === id).msg.details;
		assert.equal(done.state, "aborted");
		assert.equal(done.results.length, 2);
		const charged = done.results.filter((r: any) => r.usage?.turns === 1 && Math.abs(r.usage.cost - .05) < 1e-9);
		assert.equal(charged.length, 1, "the charged sibling's usage is retained exactly once");
		assert.equal(charged[0].stopReason, "aborted");
		const queued = done.results.find((r: any) => r !== charged[0]);
		assert.equal(queued.usage.turns, 0, "a never-started entry invents no usage");
		assert.equal(queued.stopReason, "aborted");
	});

	test("D9 ordinary UI auto-cancel with a failing stdin: cleanup runs, no unhandled error, the job still ends", async () => {
		const pi = fakePi();
		subagentExtension(pi);
		const jobId = await startJob(pi);
		await waitFor(() => children.length === 1, "spawn");
		const child = children[0];
		child.fault = "epipe";
		child.emit(dialog("s1", REQ, "select"));
		await waitFor(() => child.fault === undefined, "auto-cancel write attempted");
		child.exit(1);
		await waitFor(() => pi.messages.some((m: any) => m.msg.customType === "subagent-completion" && m.msg.details.jobId === jobId), "job completion after exit");
		assert.equal(answersFor(child, "s1").length, 0, "failed auto-cancel was not written");
	});
}
