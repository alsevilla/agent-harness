#!/usr/bin/env node
// Offline routing-fixture evaluator (Node built-ins only; no model, network or provider calls).
//
// Scores explicitly provided routing predictions (JSONL, one object per case) against examples/routing-cases.json.
// Passing provided predictions does NOT prove runtime skill activation; --self-check only proves fixture/evaluator
// consistency. A prediction may carry `calls`: the recorded argument objects of native `subagent` calls; cases with
// `expect.model_tiers` score the modelTier of every dispatched entry from those calls, and cases with
// `expect.max_dispatches` count the recorded dispatches per role (absent calls = unobserved, never a pass).
// An optional `read_observations` object feeds NON-SCORING read diagnostics (see readDiagnostics): observed
// reads only, never skill activation or use.
// Exit: 0 all matched and no critical failure; 1 mismatch or critical failure; 2 invalid input or usage.
//
// Port of the former evaluate-routing.py. Deliberate runtime differences (strict JSON reader that keeps int/float and
// duplicate keys, Python-compatible whitespace/line splitting/sorting/repr, explicit JSON nesting cap) are listed in
// references/skill-evaluation.md and pinned by tests/evaluate-routing.test.mjs.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA = "engineering-harness/routing-cases/v1";
export const ROUTES = new Set([
	"T0_MAIN", "T1_WORKER", "T2_DEBUG_WORKER", "T3_SPECIALIST_FIRST", "T4_ORACLE_ESCALATION",
	"DISCOVER_SCOUT_FIRST", "LOCAL_DONE", "VERIFY_INDEPENDENT", "REVIEW", "SHIP_AUTHORIZED",
	"BLOCKED_NO_AUTHORITY", "STOP_NO_LAUNCH", "QUEUE_NO_LAUNCH",
]);
// Mirrors agent/agents/*.md; tests/evaluate-routing.test.mjs checks the drift.
export const ROLES = new Set([
	"api-specialist", "architecture-specialist", "backend-worker", "concurrency-specialist",
	"debugger", "devops-specialist", "frontend-worker", "general-worker",
	"observability-specialist", "oracle", "performance-specialist", "planner", "platform-worker", "release-engineer",
	"reviewer", "scout", "security-specialist", "database-specialist", "database-worker",
	"test-engineer", "ui-ux-specialist",
]);
const set = (...items) => new Set(items);
const KINDS = set("positive", "near_miss");
const FIXTURE_KEYS = set("schema", "description", "cases");
const CASE_KEYS = set("id", "kind", "question", "context", "critical", "expect");
const EXPECT_KEYS = set("routes", "roles_required", "roles_allowed", "skills_required", "skills_forbidden");
const EXPECT_OPTIONAL = set("model_tiers", "max_dispatches", "required_reads");
const PRED_KEYS = set("id", "route", "roles", "skills");
const PRED_OPTIONAL = set("calls", "calls_provenance", "read_observations");
const READ_KEYS = set("provenance", "complete", "events");
const EVENT_KEYS = set("path", "status");
const NO_KEYS = new Set();
// full: a successful read of the whole file; partial: offset/limit read; truncated: output cut by a limit;
// failed: attempted but errored; injected / retained: context supplied or kept, not a read call.
export const READ_STATUSES = ["full", "partial", "truncated", "failed", "injected", "retained"];
const READ_STATUS_SET = new Set(READ_STATUSES);
// Native `subagent` tool contract; tests compare these with agent/extensions/subagent/index.ts, dag.ts and safety-core.ts.
export const TIERS = set("economy", "capable");
const TIER_CHOICES = set("economy", "capable", "omitted"); // omitted: modelTier absent, role default runs
export const SLOTS = set("fallback"); // optional per-entry modelSlot; requires an explicit modelTier
const NATIVE_ENTRY_KEYS = set("agent", "task", "cwd", "readOnly", "modelTier", "modelSlot", "prBase");
const NATIVE_DAG_KEYS = new Set([...NATIVE_ENTRY_KEYS, "id", "dependsOn"]);
const NATIVE_ROOT_KEYS = set("background", "modelTier", "modelSlot", "agent", "task", "tasks", "chain", "agentScope", "dag",
	"readOnly", "confirmProjectAgents", "cwd", "prBase", "cleanup", "consultation");
const NATIVE_CLEANUP_KEYS = set("checkout", "branch", "base", "pr", "headSha", "mergeCommit", "quiescent"); // CLEANUP schema / CLEANUP_REQUEST_KEYS
const NATIVE_CLEANUP_ROLE = "release-engineer"; // the only role whose single-mode launch accepts `cleanup` (LEASE_ROLE)
const NATIVE_SHA = /^[0-9a-f]{40}$/; // BARE_SHA; `$` without the m flag matches only at the very end (no trailing-newline slack)
const BATCH_MODES = ["tasks", "chain", "dag"];
export const NATIVE_MAX_TASKS = 8; // MAX_PARALLEL_TASKS in index.ts; the native chain schema has no item limit
export const NATIVE_MAX_DAG_NODES = 8; // DAG_NODE_LIMIT in dag.ts and the dag schema maxItems
const NATIVE_DAG_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/; // dag.ts NODE_ID
const NATIVE_SCOPES = set("user", "project", "both");
/** The native-contract constants, for the parity test (ES module exports are read-only, so the test drifts copies of this object). */
export const NATIVE = Object.freeze({
	ENTRY_KEYS: NATIVE_ENTRY_KEYS, DAG_KEYS: NATIVE_DAG_KEYS, ROOT_KEYS: NATIVE_ROOT_KEYS, CLEANUP_KEYS: NATIVE_CLEANUP_KEYS,
	CLEANUP_ROLE: NATIVE_CLEANUP_ROLE, SHA: NATIVE_SHA, MAX_TASKS: NATIVE_MAX_TASKS, MAX_DAG_NODES: NATIVE_MAX_DAG_NODES,
	DAG_ID: NATIVE_DAG_ID, SCOPES: NATIVE_SCOPES, TIERS, SLOTS,
});
const ID_RE = /^R[0-9]{2,3}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9/-]*$/;
const VIOLATION_KINDS = ["route", "role_missing", "role_order", "role_unexpected", "skill_missing", "skill_forbidden",
	"order_unobserved", "tier_unobserved", "tier_omitted", "tier_wrong", "dispatch_unobserved", "dispatch_over"];
/** Explicit nesting cap (Python relied on its recursion limit). Deeper JSON is an input error, never a stack overflow. */
export const JSON_MAX_DEPTH = 1000;

/** Invalid fixture, predictions or usage. The evaluator fails closed. */
export class RoutingEvalError extends Error {
	constructor(message) { super(message); this.name = "RoutingEvalError"; }
}
const fail = (message) => new RoutingEvalError(message);
const has = (o, k) => Object.hasOwn(o, k);

// --- Python-compatible text helpers -------------------------------------------------------------------------------------
/** Python str.isspace characters (not JS trim(): U+001C-U+001F and U+0085 count, U+FEFF does not). */
const PY_BLANK = /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;
export const isBlank = (s) => PY_BLANK.test(s);

/** Python str.splitlines(): line boundaries \n \r \r\n \v \f \x1c-\x1e \x85 \u2028 \u2029; no empty last element. */
export function splitLines(text) {
	const parts = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

/** Code-point order (Python sorted() on str), not JS UTF-16 code-unit order. */
function cpCompare(a, b) {
	const x = Array.from(a, (c) => c.codePointAt(0));
	const y = Array.from(b, (c) => c.codePointAt(0));
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
}

/** JSON float token kept distinct from integers (JS numbers cannot tell 1.0 from 1). */
class JsonFloat {
	constructor(token) { this.token = token; this.value = Number(token); }
}
const isInt = (v) => (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function strRepr(s) {
	const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
	let out = quote;
	for (const ch of s) {
		const c = ch.codePointAt(0);
		if (ch === quote || ch === "\\") out += "\\" + ch;
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) out += `\\x${c.toString(16).padStart(2, "0")}`;
		else out += ch;
	}
	return out + quote;
}

/** Python repr() of a JSON-shaped value, used so error text stays the same as the legacy evaluator's. */
export function pyRepr(v) {
	if (typeof v === "string") return strRepr(v);
	if (v === null || v === undefined) return "None";
	if (v === true) return "True";
	if (v === false) return "False";
	if (typeof v === "number") return String(v);
	if (typeof v === "bigint") return String(v);
	if (v instanceof JsonFloat) return Number.isInteger(v.value) ? `${v.value}.0` : String(v.value);
	if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
	if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${strRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
	return String(v);
}

/** Python f"{x:.4f}": exact binary expansion, ties (representable only) round half to even; toFixed rounds them up. */
export function format4(x) {
	const rounded = x.toFixed(4);
	const full = x.toFixed(100);
	const cut = full.indexOf(".") + 5;
	if (/^50*$/.test(full.slice(cut))) {
		const kept = full.slice(0, cut);
		return Number(kept.at(-1)) % 2 === 0 ? kept : rounded;
	}
	return rounded;
}

// --- strict JSON reader (matches Python json.loads + parse_constant/object_pairs_hook of the legacy evaluator) --------------
class JsonSyntax extends Error {
	constructor(msg, pos) { super(msg); this.pos = pos; }
}
class JsonTooDeep extends Error {}
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function readJson(text) {
	const n = text.length;
	let i = 0;
	const syntax = (msg, at = i) => new JsonSyntax(msg, at);
	const ws = () => { while (i < n && " \t\n\r".includes(text[i])) i++; };
	const constant = (token) => fail(`non-finite or unsupported JSON constant: ${token}`);

	function string() {
		const start = i++;
		let out = "";
		let chunk = i;
		for (;;) {
			if (i >= n) throw syntax("Unterminated string starting at", start);
			const c = text.charCodeAt(i);
			if (c === 34) { out += text.slice(chunk, i++); return out; }
			if (c === 92) {
				out += text.slice(chunk, i++);
				const e = text[i];
				if (e === "u") {
					const hex = text.slice(i + 1, i + 5);
					if (!HEX4.test(hex)) throw syntax("Invalid \\uXXXX escape", i - 1);
					out += String.fromCharCode(parseInt(hex, 16));
					i += 5;
				} else if (e !== undefined && has(ESCAPES, e)) { out += ESCAPES[e]; i++; } else throw syntax("Invalid \\escape", i - 1);
				chunk = i;
			} else if (c < 32) throw syntax("Invalid control character at", i);
			else i++;
		}
	}

	function value(depth) {
		const ch = text[i];
		if (ch === "{") return object(depth + 1);
		if (ch === "[") return array(depth + 1);
		if (ch === '"') return string();
		for (const [word, v] of [["true", true], ["false", false], ["null", null]]) if (text.startsWith(word, i)) { i += word.length; return v; }
		for (const word of ["NaN", "Infinity", "-Infinity"]) if (text.startsWith(word, i)) throw constant(word);
		NUMBER.lastIndex = i;
		const m = NUMBER.exec(text);
		if (!m) throw syntax("Expecting value");
		i += m[0].length;
		if (m[1] !== undefined || m[2] !== undefined) return new JsonFloat(m[0]);
		const num = Number(m[0]);
		return Number.isSafeInteger(num) ? num : BigInt(m[0]);
	}

	function object(depth) {
		if (depth > JSON_MAX_DEPTH) throw new JsonTooDeep();
		i++;
		const pairs = [];
		ws();
		if (text[i] === "}") i++;
		else {
			for (;;) {
				ws();
				if (text[i] !== '"') throw syntax("Expecting property name enclosed in double quotes");
				const key = string();
				ws();
				if (text[i] !== ":") throw syntax("Expecting ':' delimiter");
				i++;
				ws();
				pairs.push([key, value(depth)]);
				ws();
				if (text[i] === "}") { i++; break; }
				if (text[i] !== ",") throw syntax("Expecting ',' delimiter");
				i++;
			}
		}
		const out = Object.create(null); // own data properties only: `__proto__` is an ordinary key
		for (const [key, v] of pairs) {
			if (has(out, key)) throw fail(`duplicate JSON key: ${key}`);
			out[key] = v;
		}
		return out;
	}

	function array(depth) {
		if (depth > JSON_MAX_DEPTH) throw new JsonTooDeep();
		i++;
		const out = [];
		ws();
		if (text[i] === "]") { i++; return out; }
		for (;;) {
			ws();
			out.push(value(depth));
			ws();
			if (text[i] === "]") { i++; return out; }
			if (text[i] !== ",") throw syntax("Expecting ',' delimiter");
			i++;
		}
	}

	ws();
	const result = value(0);
	ws();
	if (i < n) throw syntax("Extra data");
	return result;
}

export function parseJson(text, where) {
	try {
		return readJson(text);
	} catch (e) {
		if (e instanceof JsonSyntax) throw fail(`${where}: malformed JSON (${e.message}, line ${text.slice(0, e.pos).split("\n").length})`);
		if (e instanceof JsonTooDeep) throw fail(`${where}: JSON nesting too deep`);
		throw e;
	}
}

// --- validators -------------------------------------------------------------------------------------------------------
function obj(value, keys, where, optional = NO_KEYS) {
	if (!isObj(value)) throw fail(`${where}: expected object`);
	const given = Object.keys(value);
	const unknown = given.filter((k) => !keys.has(k) && !optional.has(k)).sort(cpCompare);
	if (unknown.length) throw fail(`${where}: unrecognized fields ${pyRepr(unknown)}`);
	const missing = [...keys].filter((k) => !has(value, k)).sort(cpCompare);
	if (missing.length) throw fail(`${where}: missing fields ${pyRepr(missing)}`);
	return value;
}

function text(value, where) {
	if (typeof value !== "string" || isBlank(value)) throw fail(`${where}: expected non-empty string`);
	return value;
}

function choice(value, allowed, where) {
	if (typeof value !== "string" || !allowed.has(value)) throw fail(`${where}: unknown value ${pyRepr(value)}`);
	return value;
}

function names(value, where, { allowed = null, pattern = null, unique = true } = {}) {
	if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) throw fail(`${where}: expected list of strings`);
	if (unique && new Set(value).size !== value.length) throw fail(`${where}: duplicate entries`);
	for (const item of value) {
		if (allowed !== null && !allowed.has(item)) throw fail(`${where}: unknown value ${pyRepr(item)}`);
		if (pattern !== null && !pattern.test(item)) throw fail(`${where}: malformed value ${pyRepr(item)}`);
	}
	return value;
}

/** Path-component boundary: `frontend` covers `frontend/x`, not `frontend-tools`. */
const covers = (router, skill) => skill === router || skill.startsWith(router + "/");

export function parseFixture(source) {
	const data = obj(parseJson(source, "fixture"), FIXTURE_KEYS, "fixture");
	if (data.schema !== SCHEMA) throw fail(`fixture: schema must be ${SCHEMA}`);
	text(data.description, "fixture.description");
	const cases = data.cases;
	if (!Array.isArray(cases) || !cases.length) throw fail("fixture: cases must be a non-empty list");
	const seen = new Set();
	cases.forEach((raw, index) => {
		const c = obj(raw, CASE_KEYS, `case[${index}]`);
		const cid = c.id;
		if (typeof cid !== "string" || !ID_RE.test(cid)) throw fail(`case[${index}]: malformed id ${pyRepr(cid)}`);
		if (seen.has(cid)) throw fail(`fixture: duplicate case id ${cid}`);
		seen.add(cid);
		choice(c.kind, KINDS, `${cid}.kind`);
		text(c.question, `${cid}.question`);
		text(c.context, `${cid}.context`);
		if (typeof c.critical !== "boolean") throw fail(`${cid}.critical: expected boolean`);
		const exp = obj(c.expect, EXPECT_KEYS, `${cid}.expect`, EXPECT_OPTIONAL);
		if (!names(exp.routes, `${cid}.routes`, { allowed: ROUTES }).length) throw fail(`${cid}.routes: must be non-empty`);
		const required = names(exp.roles_required, `${cid}.roles_required`, { allowed: ROLES });
		const allowed = names(exp.roles_allowed, `${cid}.roles_allowed`, { allowed: ROLES });
		if (!required.every((r) => allowed.includes(r))) throw fail(`${cid}: roles_required must be a subset of roles_allowed`);
		const sReq = names(exp.skills_required, `${cid}.skills_required`, { pattern: SKILL_RE });
		const sForb = names(exp.skills_forbidden, `${cid}.skills_forbidden`, { pattern: SKILL_RE });
		if (sForb.some((f) => sReq.some((r) => covers(f, r)))) throw fail(`${cid}: a skill cannot be both required and forbidden`);
		if (has(exp, "model_tiers")) {
			const tiers = exp.model_tiers;
			if (!isObj(tiers) || !Object.keys(tiers).length) throw fail(`${cid}.model_tiers: expected non-empty object`);
			for (const [role, accepted] of Object.entries(tiers)) {
				if (!required.includes(role)) throw fail(`${cid}.model_tiers: ${pyRepr(role)} must be in roles_required`);
				if (!names(accepted, `${cid}.model_tiers.${role}`, { allowed: TIER_CHOICES }).length) throw fail(`${cid}.model_tiers.${role}: must be non-empty`);
			}
		}
		if (has(exp, "max_dispatches")) {
			const limits = exp.max_dispatches;
			if (!isObj(limits) || !Object.keys(limits).length) throw fail(`${cid}.max_dispatches: expected non-empty object`);
			for (const [role, limit] of Object.entries(limits)) {
				if (!allowed.includes(role)) throw fail(`${cid}.max_dispatches: ${pyRepr(role)} must be in roles_allowed`);
				if (!isInt(limit) || limit < 1) throw fail(`${cid}.max_dispatches.${role}: expected an integer >= 1, got ${pyRepr(limit)}`);
			}
		}
		if (has(exp, "required_reads")) {
			const paths = exp.required_reads;
			if (!names(paths, `${cid}.required_reads`).length) throw fail(`${cid}.required_reads: must be non-empty`);
			for (const p of paths) text(p, `${cid}.required_reads`);
		}
	});
	return data;
}

function tier(value, where) {
	// Type before membership; null is refused by the runtime before launch, so it is never a dispatch observation either.
	if (typeof value !== "string" || !TIERS.has(value)) throw fail(`${where}.modelTier: expected economy or capable when present, got ${pyRepr(value)}`);
	return value;
}

/** modelSlot is only the string "fallback" and needs an explicit modelTier beside it (null is refused by the runtime). */
function slot(entry, where) {
	if (!has(entry, "modelSlot")) return;
	const value = entry.modelSlot;
	if (typeof value !== "string" || !SLOTS.has(value)) throw fail(`${where}.modelSlot: expected fallback when present, got ${pyRepr(value)}`);
	if (!has(entry, "modelTier")) throw fail(`${where}.modelSlot: requires an explicit modelTier`);
}

function flag(value, where) {
	if (typeof value !== "boolean") throw fail(`${where}: expected boolean, got ${pyRepr(value)}`);
	return value;
}

/** Shape of the root `cleanup` request as the runtime mints it (offline: no live PR, git or authorization claim is made). */
function cleanup(call, at) {
	const where = `${at}.cleanup`;
	const value = obj(call.cleanup, NATIVE_CLEANUP_KEYS, where);
	for (const key of ["checkout", "branch", "base"]) text(value[key], `${where}.${key}`);
	const pr = value.pr;
	if (!isInt(pr) || !(pr >= 1 && pr <= 999999999)) throw fail(`${where}.pr: expected a positive integer PR number`);
	for (const key of ["headSha", "mergeCommit"]) {
		if (typeof value[key] !== "string" || !NATIVE_SHA.test(value[key])) throw fail(`${where}.${key}: expected a 40-hex lowercase commit id`);
	}
	if (value.quiescent !== true) throw fail(`${where}.quiescent: main must declare the checkout quiescent (true)`);
	if (call.agent !== NATIVE_CLEANUP_ROLE) throw fail(`${at}.cleanup: only a single-mode launch of ${NATIVE_CLEANUP_ROLE} accepts it`);
	if (!has(call, "cwd") || has(call, "prBase") || call.readOnly === true) throw fail(`${at}.cleanup: needs cwd (the primary checkout), no prBase and not readOnly`);
}

/** Validate one tasks/chain/dag entry like the native TypeBox schema and dag validator. */
function entryOf(item, keys, where, dag) {
	const required = dag ? set("agent", "task", "id") : set("agent", "task");
	const e = obj(item, required, where, new Set([...keys].filter((k) => !required.has(k))));
	text(e.task, `${where}.task`);
	if (has(e, "cwd")) text(e.cwd, `${where}.cwd`);
	if (has(e, "readOnly")) flag(e.readOnly, `${where}.readOnly`);
	const t = has(e, "modelTier") ? tier(e.modelTier, where) : null;
	slot(e, where);
	if (has(e, "prBase")) text(e.prBase, `${where}.prBase`); // shape only; branch syntax and live-branch checks stay runtime (checkPrBase)
	return { agent: choice(e.agent, ROLES, `${where}.agent`), tier: t };
}

/** Validate a dag like agent/extensions/subagent/dag.ts validateDag; returns dispatches with ancestry. */
function dagOf(items, where) {
	if (!Array.isArray(items) || !items.length) throw fail(`${where}: expected non-empty list`);
	if (items.length > NATIVE_MAX_DAG_NODES) throw fail(`${where}: ${items.length} nodes; the native limit is ${NATIVE_MAX_DAG_NODES}`);
	const nodes = [];
	const depsOf = [];
	items.forEach((item, i) => {
		const at = `${where}[${i}]`;
		nodes.push(entryOf(item, NATIVE_DAG_KEYS, at, true));
		const nid = item.id;
		if (typeof nid !== "string" || !NATIVE_DAG_ID.test(nid)) throw fail(`${at}.id: invalid dag node id ${pyRepr(nid)}`);
		if (nodes.slice(0, -1).some((n) => n.id === nid)) throw fail(`${at}.id: duplicate dag node id ${pyRepr(nid)}`);
		nodes.at(-1).id = nid;
		const deps = has(item, "dependsOn") ? item.dependsOn : [];
		if (!Array.isArray(deps) || !deps.every((d) => typeof d === "string")) throw fail(`${at}.dependsOn: expected a list of node ids, got ${pyRepr(deps)}`);
		depsOf.push(deps);
	});
	const ids = new Set(nodes.map((n) => n.id));
	nodes.forEach((node, i) => {
		const seen = new Set();
		for (const dep of depsOf[i]) {
			const at = `${where}[${i}].dependsOn`;
			if (dep === node.id) throw fail(`${at}: dag node ${pyRepr(dep)} cannot depend on itself`);
			if (!ids.has(dep)) throw fail(`${at}: depends on missing node ${pyRepr(dep)}`);
			if (seen.has(dep)) throw fail(`${at}: lists parent ${pyRepr(dep)} more than once`);
			seen.add(dep);
		}
	});
	// Kahn: nodes never reached sit on a cycle. Ancestry is built in topological order.
	const ancestors = new Map();
	const pending = new Map(nodes.map((n, i) => [n.id, depsOf[i].length]));
	const ready = nodes.filter((_, i) => !depsOf[i].length).map((n) => n.id);
	for (const nid of ready) ancestors.set(nid, new Set());
	while (ready.length) {
		const done = ready.shift();
		nodes.forEach((node, i) => {
			if (!depsOf[i].includes(done)) return;
			pending.set(node.id, pending.get(node.id) - 1);
			if (pending.get(node.id) === 0) {
				const anc = new Set();
				for (const d of depsOf[i]) { anc.add(d); for (const a of ancestors.get(d)) anc.add(a); }
				ancestors.set(node.id, anc);
				ready.push(node.id);
			}
		});
	}
	if (ancestors.size !== nodes.length) throw fail(`${where}: dag contains a dependency cycle`);
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	return nodes.map((node) => ({ agent: node.agent, tier: node.tier, beforeLocal: new Set([...ancestors.get(node.id)].map((a) => index.get(a))) }));
}

/**
 * Validate recorded native `subagent` call arguments; return dispatches {agent, tier, before}.
 * `before` holds indexes of dispatches in the same call guaranteed to complete first: earlier chain steps and
 * transitive dag dependencies. Array position of tasks/dag entries and call order are never precedence.
 */
export function parseCalls(value, where) {
	// Top-level empty list = complete observation of zero dispatches; nested batch lists stay non-empty.
	if (!Array.isArray(value)) throw fail(`${where}: expected list of call objects`);
	const dispatches = [];
	value.forEach((call, n) => {
		const at = `${where}[${n}]`;
		if (!isObj(call)) throw fail(`${at}: expected object`);
		const unknown = Object.keys(call).filter((k) => !NATIVE_ROOT_KEYS.has(k)).sort(cpCompare);
		if (unknown.length) throw fail(`${at}: unrecognized fields ${pyRepr(unknown)}`);
		const batch = BATCH_MODES.filter((m) => has(call, m));
		const single = has(call, "agent") || has(call, "task");
		if (batch.length + (single ? 1 : 0) !== 1) throw fail(`${at}: expected exactly one of agent+task, tasks, chain or dag`);
		if (has(call, "background")) flag(call.background, `${at}.background`);
		if (has(call, "agentScope")) choice(call.agentScope, NATIVE_SCOPES, `${at}.agentScope`);
		if (has(call, "confirmProjectAgents")) flag(call.confirmProjectAgents, `${at}.confirmProjectAgents`);
		const base = dispatches.length;
		if (batch.length) {
			const mode = batch[0];
			for (const key of ["modelTier", "modelSlot", "agent", "task", "prBase", "cleanup"]) {
				if (has(call, key)) throw fail(`${at}.${key}: single-mode field; batch modes set it per entry`);
			}
			for (const key of ["cwd", "readOnly"]) {
				if (has(call, key)) throw fail(`${at}.${key}: applies to single mode only; batch modes ignore it`);
			}
			const items = call[mode];
			let found;
			if (mode === "dag") {
				found = dagOf(items, `${at}.dag`).map(({ beforeLocal, ...d }) => ({ ...d, before: new Set([...beforeLocal].map((i) => base + i)) }));
			} else {
				if (!Array.isArray(items) || !items.length) throw fail(`${at}.${mode}: expected non-empty list`);
				if (mode === "tasks" && items.length > NATIVE_MAX_TASKS) throw fail(`${at}.tasks: ${items.length} entries; the native limit is ${NATIVE_MAX_TASKS}`);
				found = items.map((item, i) => entryOf(item, NATIVE_ENTRY_KEYS, `${at}.${mode}[${i}]`, false));
				found.forEach((d, i) => { d.before = new Set(mode === "chain" ? Array.from({ length: i }, (_, k) => base + k) : []); });
			}
			dispatches.push(...found);
		} else {
			if (!has(call, "agent") || !has(call, "task")) throw fail(`${at}: single mode needs agent and task`);
			if (has(call, "cwd")) text(call.cwd, `${at}.cwd`);
			if (has(call, "readOnly")) flag(call.readOnly, `${at}.readOnly`);
			text(call.task, `${at}.task`);
			const t = has(call, "modelTier") ? tier(call.modelTier, at) : null;
			slot(call, at);
			if (has(call, "prBase")) text(call.prBase, `${at}.prBase`);
			if (has(call, "cleanup")) cleanup(call, at);
			dispatches.push({ agent: choice(call.agent, ROLES, `${at}.agent`), tier: t, before: new Set() });
		}
		if (call.agentScope === "project" && dispatches.slice(base).some((d) => d.tier !== null)) {
			throw fail(`${at}.agentScope: project scope cannot take an explicit modelTier; canonical package roles are not in project-only discovery`);
		}
	});
	return dispatches;
}

/**
 * Validate one optional read-observation record (diagnostics only; nothing here is a claim of use).
 * `complete` is the operator's statement that `events` lists every read attempt of the observed session scope;
 * the evaluator cannot verify it. Paths are matched later by exact string equality.
 */
export function parseReadObservations(value, where) {
	const o = obj(value, READ_KEYS, where);
	text(o.provenance, `${where}.provenance`);
	flag(o.complete, `${where}.complete`);
	if (!Array.isArray(o.events)) throw fail(`${where}.events: expected list`);
	const events = o.events.map((raw, i) => {
		const e = obj(raw, EVENT_KEYS, `${where}.events[${i}]`);
		return { path: text(e.path, `${where}.events[${i}].path`), status: choice(e.status, READ_STATUS_SET, `${where}.events[${i}].status`) };
	});
	return { complete: o.complete, events };
}

export function parsePredictions(source, caseIds) {
	const lines = splitLines(source);
	if (!lines.length) throw fail("predictions: empty dataset");
	const preds = new Map();
	lines.forEach((line, k) => {
		const where = `predictions line ${k + 1}`;
		if (isBlank(line)) throw fail(`${where}: blank line`);
		const rec = obj(parseJson(line, where), PRED_KEYS, where, PRED_OPTIONAL);
		const pid = rec.id;
		if (typeof pid !== "string" || !caseIds.has(pid)) throw fail(`${where}: unknown case id ${pyRepr(pid)}`);
		if (preds.has(pid)) throw fail(`${where}: duplicate case id ${pid}`);
		const pred = {
			route: choice(rec.route, ROUTES, `${where}.route`),
			roles: names(rec.roles, `${where}.roles`, { allowed: ROLES, unique: false }),
			skills: names(rec.skills, `${where}.skills`, { pattern: SKILL_RE }),
			dispatches: null,
			reads: has(rec, "read_observations") ? parseReadObservations(rec.read_observations, `${where}.read_observations`) : null,
		};
		preds.set(pid, pred);
		if (has(rec, "calls") !== has(rec, "calls_provenance")) throw fail(`${where}: calls and calls_provenance must be given together`);
		if (has(rec, "calls")) {
			text(rec.calls_provenance, `${where}.calls_provenance`);
			pred.dispatches = parseCalls(rec.calls, `${where}.calls`);
			// Roles must be the calls' agents; as a multiset, because list order is not runtime order.
			const a = pred.dispatches.map((d) => d.agent).sort(cpCompare);
			const b = [...pred.roles].sort(cpCompare);
			if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw fail(`${where}: roles do not match the agents in calls`);
		}
	});
	const missing = [...caseIds].filter((id) => !preds.has(id)).sort(cpCompare);
	if (missing.length) throw fail(`predictions: missing case ids ${pyRepr(missing)}`);
	return Object.fromEntries(preds);
}

/** Ordered-subsequence test (legacy role-only predictions: list order). */
function inOrder(needed, actual) {
	let pos = 0;
	for (const item of needed) {
		const found = actual.indexOf(item, pos);
		if (found < 0) return false;
		pos = found + 1;
	}
	return true;
}

/**
 * First unmet precedence between consecutive required roles, from chain/dependency ancestry only.
 * Returns null when every dispatch of the later role has an earlier-role ancestor in its call, else
 * ["role_order", ...] when ancestry proves the reverse, else ["order_unobserved", ...].
 */
function callOrder(needed, dispatches) {
	for (let k = 0; k + 1 < needed.length; k++) {
		const [earlier, later] = [needed[k], needed[k + 1]];
		const first = dispatches.flatMap((d, i) => (d.agent === earlier ? [i] : []));
		const second = dispatches.flatMap((d, i) => (d.agent === later ? [i] : []));
		if (second.every((j) => first.some((i) => dispatches[j].before.has(i)))) continue;
		if (first.some((i) => second.some((j) => dispatches[i].before.has(j)))) return ["role_order", `${later} is a prerequisite of ${earlier}; required order ${pyRepr(needed)}`];
		return ["order_unobserved", `recorded calls do not establish ${earlier} completing before ${later} `
			+ "(only chain order or dependsOn does; parallel entries, array position and separate calls do not)"];
	}
	return null;
}

/**
 * Optional, NON-SCORING diagnostics over provided read observations; never part of accuracy, ok or critical.
 * Only observed reads: a full read of a required path is not use or activation. A case with a required-path map is
 * measured only when its observation is declared complete; a missing or incomplete observation is UNKNOWN, never zero.
 * Injected and retained events are context, not reads, and never count as full reads.
 */
export function readDiagnostics(fixture, predictions) {
	const statuses = Object.fromEntries(READ_STATUSES.map((s) => [s, 0]));
	let observed = 0, mapped = 0, measured = 0, full = 0, total = 0, zero = 0;
	const unknown = [];
	for (const c of fixture.cases) {
		const reads = predictions[c.id].reads;
		const required = has(c.expect, "required_reads") ? c.expect.required_reads : null;
		if (reads !== null) {
			observed++;
			for (const e of reads.events) statuses[e.status]++;
		}
		if (required === null) continue;
		mapped++;
		if (reads === null || !reads.complete) { unknown.push(c.id); continue; }
		const got = required.filter((p) => reads.events.some((e) => e.path === p && e.status === "full")).length;
		measured++; full += got; total += required.length;
		if (got === 0) zero++;
	}
	return { observations: observed, statuses, mapped_cases: mapped, measured_cases: measured, unknown_cases: unknown, required_full: full,
		required_total: total, recall: measured ? full / total : null, zero_observed_cases: zero, zero_rate: measured ? zero / measured : null };
}

export function evaluate(fixture, predictions) {
	const results = [];
	const counts = Object.fromEntries(VIOLATION_KINDS.map((k) => [k, 0]));
	let criticalTotal = 0;
	for (const c of fixture.cases) {
		const exp = c.expect;
		const pred = predictions[c.id];
		const found = [];
		if (!exp.routes.includes(pred.route)) found.push(["route", `route ${pred.route} not in ${pyRepr(exp.routes)}`]);
		const missing = exp.roles_required.filter((r) => !pred.roles.includes(r));
		if (missing.length) found.push(["role_missing", `missing roles ${pyRepr(missing)}`]);
		else if (pred.dispatches === null) {
			if (!inOrder(exp.roles_required, pred.roles)) found.push(["role_order", `roles out of order, required ${pyRepr(exp.roles_required)}`]); // legacy role-only prediction: list order
		} else {
			const unmet = callOrder(exp.roles_required, pred.dispatches);
			if (unmet) found.push(unmet);
		}
		const extra = pred.roles.filter((r) => !exp.roles_allowed.includes(r));
		if (extra.length) found.push(["role_unexpected", `roles not allowed ${pyRepr(extra)}`]);
		const missingSkills = exp.skills_required.filter((s) => !pred.skills.includes(s));
		if (missingSkills.length) found.push(["skill_missing", `missing skills ${pyRepr(missingSkills)}`]);
		const forbidden = exp.skills_forbidden.filter((s) => pred.skills.some((p) => covers(s, p)));
		if (forbidden.length) found.push(["skill_forbidden", `forbidden skills selected ${pyRepr(forbidden)}`]);
		for (const [role, accepted] of has(exp, "model_tiers") ? Object.entries(exp.model_tiers) : []) {
			if (pred.dispatches === null) { found.push(["tier_unobserved", `no recorded native calls to observe modelTier for ${role}`]); continue; }
			for (const d of pred.dispatches.filter((x) => x.agent === role)) {
				const t = d.tier ?? "omitted";
				if (!accepted.includes(t)) {
					found.push([t === "omitted" ? "tier_omitted" : "tier_wrong", `${role} dispatched with modelTier ${t}, expected one of ${pyRepr(accepted)}`]);
					break;
				}
			}
		}
		for (const [role, limit] of has(exp, "max_dispatches") ? Object.entries(exp.max_dispatches) : []) {
			if (pred.dispatches === null) { found.push(["dispatch_unobserved", `no recorded native calls to count dispatches of ${role}`]); continue; }
			const made = pred.dispatches.filter((d) => d.agent === role).length;
			if (made > limit) found.push(["dispatch_over", `${role} dispatched ${made} times in recorded calls, at most ${limit} expected`]);
		}
		// Critical: any miss in a critical case, or any forbidden skill (always critical).
		const critical = found.length > 0 && (c.critical || found.some(([k]) => k === "skill_forbidden"));
		for (const [kind] of found) counts[kind]++;
		if (critical) criticalTotal++;
		results.push({ id: c.id, matched: !found.length, critical_failure: critical, details: found.map(([, detail]) => detail) });
	}
	const total = results.length;
	const matched = results.filter((r) => r.matched).length;
	const cases = fixture.cases;
	const withCalls = (key) => cases.filter((c) => has(c.expect, key) && predictions[c.id].dispatches !== null).length;
	return {
		total, matched, mismatched: total - matched, accuracy: matched / total,
		positive: cases.filter((c) => c.kind === "positive").length,
		near_miss: cases.filter((c) => c.kind === "near_miss").length,
		critical_cases: cases.filter((c) => c.critical).length,
		tier_cases: cases.filter((c) => has(c.expect, "model_tiers")).length,
		tier_observed: withCalls("model_tiers"),
		dispatch_cases: cases.filter((c) => has(c.expect, "max_dispatches")).length,
		dispatch_observed: withCalls("max_dispatches"),
		read_diagnostics: readDiagnostics(fixture, predictions),
		violations: counts, critical_failures: criticalTotal,
		mismatches: results.filter((r) => !r.matched),
		ok: matched === total && criticalTotal === 0,
	};
}

export function formatReadDiagnostics(d) {
	const head = "read_diagnostics (non-scoring; observed reads only, NOT skill use or activation): ";
	if (!d.observations && !d.mapped_cases) return head + "none provided";
	const pct = (v) => (v === null ? "UNKNOWN" : format4(v));
	return head + `observations=${d.observations} required_read_cases=${d.mapped_cases} measured=${d.measured_cases} `
		+ `unknown=${d.unknown_cases.length} required_full_read_recall=${pct(d.recall)} `
		+ `(${d.required_full}/${d.required_total}) zero_observed_read_rate=${pct(d.zero_rate)} `
		+ Object.entries(d.statuses).map(([k, v]) => `${k}=${v}`).join(" ");
}

export function formatReport(rep, provenance) {
	const lines = [
		`provenance: ${provenance}`,
		`cases: ${rep.total} (positive ${rep.positive}, near_miss ${rep.near_miss}, critical ${rep.critical_cases})`,
		`matched: ${rep.matched}/${rep.total} accuracy: ${format4(rep.accuracy)}`,
		"violations: " + Object.entries(rep.violations).map(([k, v]) => `${k}=${v}`).join(" "),
		`critical_failures: ${rep.critical_failures}`,
		`tier_cases: ${rep.tier_cases} (with calls provided: ${rep.tier_observed})`,
		`dispatch_cases: ${rep.dispatch_cases} (with calls provided: ${rep.dispatch_observed})`,
		formatReadDiagnostics(rep.read_diagnostics),
	];
	for (const m of rep.mismatches) lines.push(`MISMATCH ${m.id}${m.critical_failure ? " [CRITICAL]" : ""}: ` + m.details.join("; "));
	lines.push("RESULT: " + (rep.ok ? "PASS" : "FAIL"));
	return lines.join("\n");
}

export function selfCheckPredictions(fixture) {
	const preds = {};
	for (const c of fixture.cases) {
		const exp = c.expect;
		let calls = null;
		if (has(exp, "model_tiers") || has(exp, "max_dispatches")) { // synthetic call mirroring the expectation; a chain when order matters
			const steps = exp.roles_required.map((r) => {
				const step = { agent: r, task: "synthetic self-check" };
				const t = exp.model_tiers?.[r]?.[0] ?? "omitted";
				if (t !== "omitted") step.modelTier = t;
				return step;
			});
			calls = steps.length ? parseCalls([steps.length > 1 ? { chain: steps } : steps[0]], "self-check") : [];
		}
		preds[c.id] = { route: exp.routes[0], roles: [...exp.roles_required], skills: [...exp.skills_required], dispatches: calls, reads: null };
	}
	return preds;
}

// --- CLI ------------------------------------------------------------------------------------------------------------------
const PROG = "evaluate-routing.mjs";
const USAGE = `usage: ${PROG} [-h] --cases CASES (--predictions PREDICTIONS | --self-check)`;
const HELP = `${USAGE}

Score recorded routing predictions against the routing fixture (offline).

options:
  -h, --help            show this help message and exit
  --cases CASES         routing fixture JSON
  --predictions PREDICTIONS
                        JSONL: one prediction object per case id
  --self-check          mirror the fixture expectations (consistency only)
`;

class UsageError extends Error {}

/** argparse-compatible subset: --opt value, --opt=value, unique-prefix abbreviations, mutually exclusive group, exit 2 on misuse. */
function parseArgs(argv) {
	const opts = ["--cases", "--predictions", "--self-check", "--help"];
	const args = { cases: null, predictions: null, selfCheck: false, help: false };
	const stray = [];
	for (let k = 0; k < argv.length; k++) {
		const token = argv[k];
		if (token === "-h") { args.help = true; continue; }
		if (!token.startsWith("--") || token === "--") { stray.push(token); continue; }
		const eq = token.indexOf("=");
		const name = eq < 0 ? token : token.slice(0, eq);
		const explicit = eq < 0 ? null : token.slice(eq + 1);
		const matches = opts.includes(name) ? [name] : opts.filter((o) => o.startsWith(name));
		if (matches.length > 1) throw new UsageError(`ambiguous option: ${name} could match ${matches.join(", ")}`);
		if (!matches.length) { stray.push(token); continue; }
		const opt = matches[0];
		if (opt === "--help" || opt === "--self-check") {
			if (explicit !== null) throw new UsageError(`argument ${opt}: ignored explicit argument ${pyRepr(explicit)}`);
			if (opt === "--help") args.help = true;
			else {
				if (args.predictions !== null) throw new UsageError("argument --self-check: not allowed with argument --predictions");
				args.selfCheck = true;
			}
			continue;
		}
		let val = explicit;
		if (val === null) {
			val = argv[k + 1];
			if (val === undefined || (val.startsWith("-") && val !== "-")) throw new UsageError(`argument ${opt}: expected one argument`);
			k++;
		}
		if (opt === "--cases") args.cases = val;
		else {
			if (args.selfCheck) throw new UsageError("argument --predictions: not allowed with argument --self-check");
			args.predictions = val;
		}
	}
	if (args.help) return args;
	if (args.cases === null) throw new UsageError("the following arguments are required: --cases");
	if (args.predictions === null && !args.selfCheck) throw new UsageError("one of the arguments --predictions --self-check is required");
	if (stray.length) throw new UsageError(`unrecognized arguments: ${stray.join(" ")}`);
	return args;
}

/** Read a whole file; a system error (missing path, directory, permissions) is an input error (exit 2), like Python's OSError. */
function readBytes(file) {
	try {
		return fs.readFileSync(file);
	} catch (e) {
		if (typeof e?.code === "string") throw fail(`${e.message}`);
		throw e;
	}
}

/** Strict UTF-8 (invalid bytes are an input error); a BOM stays in the text so the JSON reader rejects it. */
function decodeUtf8(raw, what) {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
	} catch (e) {
		if (e instanceof TypeError && e.code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw fail(`${what} is not valid UTF-8`);
		throw e;
	}
}

/** CLI entry. Returns the exit code (0 pass, 1 mismatch/critical, 2 invalid input or usage); `out`/`err` take `.write(string)`. */
export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		err.write(`${USAGE}\n${PROG}: error: ${e.message}\n`);
		return 2;
	}
	if (args.help) { out.write(HELP); return 0; }
	let fixture, preds, provenance;
	try {
		// Python read_text() applies universal newlines to the fixture; predictions are read as raw bytes.
		fixture = parseFixture(decodeUtf8(readBytes(args.cases), `${args.cases}`).replace(/\r\n?/g, "\n"));
		if (args.selfCheck) {
			preds = selfCheckPredictions(fixture);
			provenance = "self-check: fixture expectations mirrored as predictions; fixture consistency only, "
				+ "NOT measured model accuracy; tier checks use synthetic calls";
		} else {
			const raw = readBytes(args.predictions);
			preds = parsePredictions(decodeUtf8(raw, `${args.predictions}`), new Set(fixture.cases.map((c) => c.id)));
			provenance = `recorded predictions ${args.predictions} sha256=${createHash("sha256").update(raw).digest("hex")}; scores provided labels only, `
				+ "does NOT prove runtime skill activation; tier checks read recorded native call arguments as "
				+ "provided and do not verify the capture";
		}
	} catch (e) {
		if (!(e instanceof RoutingEvalError)) throw e;
		err.write(`error: ${e.message}\n`);
		return 2;
	}
	const report = evaluate(fixture, preds);
	out.write(formatReport(report, provenance) + "\n");
	return report.ok ? 0 : 1;
}

// Run only when executed as a script, never on import (tests import the pure functions).
const invokedDirectly = (() => {
	try {
		return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
})();
if (invokedDirectly) process.exitCode = main();
