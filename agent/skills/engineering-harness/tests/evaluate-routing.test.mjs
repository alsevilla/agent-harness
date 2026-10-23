// Deterministic checks for the offline routing evaluator and its fixture (node:test port of the legacy Python unittest suite).
// These prove evaluator behavior and fixture policy consistency only; they do not measure model or runtime skill-activation accuracy.
// Test names keep the legacy Python names (without the `test_` prefix) inside a describe named after the legacy class.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as ev from "../scripts/evaluate-routing.mjs";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const hasSkillEntry = (folder) => isFile(path.join(folder, "SKILL.md")) || isFile(path.join(folder, "index.md"));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "evaluate-routing.mjs");
const CASES = path.join(ROOT, "examples", "routing-cases.json");
const AGENTS_DIR = path.resolve(ROOT, "..", "..", "agents");
const SKILLS_DIR = path.resolve(ROOT, "..");
const REPO_ROOT = path.resolve(SKILLS_DIR, "..", "..");
const SUBAGENT_DIR = path.resolve(AGENTS_DIR, "..", "extensions", "subagent");

// Windows checkouts may carry CRLF; the sources are compared as LF text.
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
const rawFixture = () => JSON.parse(readText(CASES));
const loadFixture = () => ev.parseFixture(readText(CASES));
const byId = (fixture) => Object.fromEntries(fixture.cases.map((c) => [c.id, c]));
const has = (o, k) => Object.hasOwn(o, k);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Native call(s) for the roles: one single call, or one chain (guaranteed order) for several. First accepted tier is used; `omitted` leaves modelTier absent. */
function callsFor(roles, tiers) {
	const entries = roles.map((role) => {
		const entry = { agent: role, task: "t" };
		const accepted = tiers[role];
		if (accepted && accepted[0] !== "omitted") entry.modelTier = accepted[0];
		return entry;
	});
	return entries.length > 1 ? [{ chain: entries }] : entries;
}

function perfectPredictions(fixture) {
	return fixture.cases.map((c) => {
		const e = c.expect;
		const row = { id: c.id, route: e.routes[0], roles: [...e.roles_required], skills: [...e.skills_required] };
		if (has(e, "model_tiers") || has(e, "max_dispatches")) {
			row.calls = callsFor(e.roles_required, e.model_tiers ?? {});
			row.calls_provenance = "unit-test synthetic capture";
		}
		return row;
	});
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const idsOf = (fixture) => new Set(fixture.cases.map((c) => c.id));

function evaluateRows(rows, fixture = loadFixture()) {
	return ev.evaluate(fixture, ev.parsePredictions(toJsonl(rows), idsOf(fixture)));
}

function setRow(rows, cid, changes) {
	const row = rows.find((r) => r.id === cid);
	if (!row) throw new Error(`no row ${cid}`);
	Object.assign(row, changes);
	if (has(changes, "roles") && has(row, "calls") && !has(changes, "calls")) row.calls = callsFor(row.roles, byId(loadFixture())[cid].expect.model_tiers ?? {});
	return rows;
}

const caseRow = (rows, cid) => rows.find((r) => r.id === cid);
const runCli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const isEvalError = (re) => (e) => e instanceof ev.RoutingEvalError && (!re || re.test(e.message));
const rejects = (fn, label, re) => assert.throws(fn, isEvalError(re), label);
const noTrace = (stderr) => !/Traceback|\n\s+at /.test(stderr);

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-routing-")); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
let tmpCounter = 0;
function writeTmp(name, content) {
	const p = path.join(TMP, `${tmpCounter++}-${name}`);
	fs.writeFileSync(p, content);
	return p;
}

describe("FixtureSpecimenTests", () => {
	it("thirty_six_unique_cases_with_positive_and_near_miss", () => {
		const ids = loadFixture().cases.map((c) => c.id);
		assert.equal(ids.length, 36);
		assert.equal(new Set(ids).size, 36);
		const kinds = loadFixture().cases.map((c) => c.kind);
		assert.ok(kinds.filter((k) => k === "near_miss").length >= 3);
		assert.ok(kinds.filter((k) => k === "positive").length >= 3);
	});

	it("main_edits_directly_only_in_labelled_no_usable_dispatch_fallback", () => {
		const t0 = loadFixture().cases.filter((c) => c.expect.routes.includes("T0_MAIN"));
		assert.deepEqual(t0.map((c) => c.id), ["R36"]);
		assert.deepEqual(t0[0].expect.routes, ["T0_MAIN"]);
		assert.match(t0[0].context, /no usable dispatch/);
		assert.deepEqual(t0[0].expect.roles_allowed, []);
		assert.deepEqual(byId(loadFixture()).R07.expect.routes, ["T1_WORKER"]);
	});

	it("current_policy_expectations", () => {
		const c = byId(loadFixture());
		const x = (id) => c[id].expect;
		assert.deepEqual(x("R01").roles_allowed, ["backend-worker"]);
		assert.ok(x("R01").skills_forbidden.includes("backend/rust-axum-engineering"));
		assert.deepEqual(x("R03").roles_allowed, ["frontend-worker"]);
		assert.deepEqual(x("R04").roles_required, ["ui-ux-specialist"]);
		assert.deepEqual(x("R04").roles_allowed, ["ui-ux-specialist", "frontend-worker"]);
		assert.deepEqual(x("R02").roles_required, ["database-specialist"]);
		assert.deepEqual(x("R02").roles_allowed, ["database-specialist", "database-worker"]);
		assert.deepEqual(x("R05").roles_required, ["debugger", "backend-worker"]);
		assert.deepEqual(x("R07").routes, ["T1_WORKER"]);
		assert.deepEqual(x("R07").roles_required, ["general-worker"]);
		assert.deepEqual(x("R08").roles_required, ["general-worker"]);
		assert.deepEqual(x("R09").roles_required, ["test-engineer"]);
		assert.deepEqual(x("R10").roles_required, ["reviewer"]);
		assert.deepEqual(x("R20").routes, ["BLOCKED_NO_AUTHORITY"]);
		assert.deepEqual(x("R20").roles_allowed, []);
		assert.deepEqual(x("R21").roles_required, ["release-engineer"]);
		assert.deepEqual(x("R16").roles_required, ["architecture-specialist"]);
		assert.deepEqual(x("R17").roles_required, ["concurrency-specialist"]);
		assert.deepEqual(x("R18").roles_required, ["security-specialist"]);
		assert.ok(!x("R15").roles_allowed.includes("architecture-specialist"));
		assert.deepEqual(x("R13").roles_required, ["scout"]);
		assert.ok(!x("R14").roles_allowed.includes("scout"));
		assert.deepEqual(x("R12").roles_required, ["oracle"]);
		assert.deepEqual(x("R11").roles_allowed, []);
		assert.deepEqual(x("R22").roles_allowed, []);
		assert.deepEqual(x("R23").roles_allowed, []);
		assert.ok(x("R19").skills_forbidden.includes("frontend"));
	});

	it("platform_routing_examples_separate_platform_devops_and_release", () => {
		const c = byId(loadFixture());
		for (const cid of ["R24", "R25", "R26", "R27", "R28"]) assert.ok(cid in c, `missing platform routing example ${cid}`);
		for (const cid of ["R24", "R25", "R26"]) {
			assert.deepEqual(c[cid].expect.roles_required, ["platform-worker"], cid);
			assert.deepEqual(c[cid].expect.roles_allowed, ["platform-worker"], cid);
		}
		assert.deepEqual(c.R27.expect.roles_required, ["devops-specialist"]);
		assert.ok(!c.R27.expect.roles_allowed.includes("platform-worker"));
		assert.deepEqual(c.R28.expect.roles_required, ["release-engineer"]);
		assert.ok(!c.R28.expect.roles_allowed.includes("platform-worker"));
	});

	it("automatic_pr_delivery_routing_cases", () => {
		const c = byId(loadFixture());
		let r = c.R29.expect;
		assert.deepEqual(r.routes, ["SHIP_AUTHORIZED"]);
		assert.deepEqual(r.roles_required, ["release-engineer"]);
		assert.deepEqual(r.skills_required, ["engineering-harness/ship"]);
		r = c.R30.expect;
		assert.deepEqual(r.routes, ["LOCAL_DONE"]);
		assert.deepEqual(r.roles_allowed, []);
		r = c.R31.expect;
		assert.deepEqual(r.routes, ["T2_DEBUG_WORKER"]);
		assert.deepEqual(r.roles_required, ["debugger"]);
		assert.ok(!r.roles_allowed.includes("release-engineer"));
		r = c.R32.expect;
		assert.deepEqual(r.routes, ["BLOCKED_NO_AUTHORITY"]);
		assert.deepEqual(r.roles_allowed, []);
		for (const cid of ["R29", "R30", "R31", "R32"]) assert.equal(c[cid].critical, true, cid);
	});

	it("r20_requests_code_preparation_only_and_keeps_publication_blocked", () => {
		const r20 = byId(loadFixture()).R20;
		const question = r20.question.toLowerCase();
		assert.ok(!question.includes("push"));
		assert.ok(!question.includes("pull request"));
		assert.ok(r20.context.toLowerCase().includes("authority"));
		assert.deepEqual(r20.expect.routes, ["BLOCKED_NO_AUTHORITY"]);
	});

	it("roles_match_current_agent_directory", () => {
		assert.ok(fs.statSync(AGENTS_DIR).isDirectory(), `role registry missing: ${AGENTS_DIR}`);
		const stems = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
		assert.deepEqual(stems, [...ev.ROLES].sort());
	});

	it("skill_entry_must_be_a_regular_file", () => {
		const d = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), "skillentry-"));
		try {
			fs.mkdirSync(path.join(d, "SKILL.md")); fs.mkdirSync(path.join(d, "index.md"));
			assert.equal(hasSkillEntry(d), false);
			fs.rmSync(path.join(d, "index.md"), { recursive: true }); fs.writeFileSync(path.join(d, "index.md"), "x");
			assert.equal(hasSkillEntry(d), true);
			assert.equal(hasSkillEntry(path.join(d, "missing")), false);
		} finally { fs.rmSync(d, { recursive: true, force: true }); }
	});

	it("fixture_skill_names_resolve_to_installed_skills", () => {
		const names = new Set();
		for (const c of loadFixture().cases) for (const n of [...c.expect.skills_required, ...c.expect.skills_forbidden]) names.add(n);
		assert.ok(names.size > 0);
		for (const name of [...names].sort()) {
			const folder = path.join(SKILLS_DIR, name);
			assert.ok(hasSkillEntry(folder), `fixture skill not installed: ${name}`);
		}
	});
});

describe("EvaluatorTests", () => {
	it("perfect_predictions_pass", () => {
		const rep = evaluateRows(perfectPredictions(loadFixture()));
		assert.equal(rep.ok, true);
		assert.equal(rep.matched, 36);
		assert.equal(rep.accuracy, 1.0);
		assert.equal(rep.critical_failures, 0);
	});

	it("wrong_role_on_critical_case_fails", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R05", { roles: ["backend-worker"] }), fx);
		assert.equal(rep.ok, false);
		assert.equal(rep.violations.role_missing, 1);
		assert.equal(rep.critical_failures, 1);
	});

	it("unexpected_role_on_noncritical_case_is_mismatch_not_critical", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R14", { roles: ["scout", "backend-worker"] }), fx);
		assert.equal(rep.violations.role_unexpected, 1);
		assert.equal(rep.mismatched, 1);
		assert.equal(rep.critical_failures, 0);
		assert.equal(rep.ok, false);
	});

	it("forbidden_skill_is_critical_even_on_noncritical_case", () => {
		const fx = loadFixture();
		assert.equal(byId(fx).R01.critical, false);
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R01", { skills: ["backend", "backend/rust-axum-engineering"] }), fx);
		assert.equal(rep.violations.skill_forbidden, 1);
		assert.equal(rep.critical_failures, 1);
		assert.equal(rep.ok, false);
	});

	it("single_critical_miss_not_hidden_by_high_aggregate", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R05", { route: "T1_WORKER", roles: ["backend-worker"] }), fx);
		assert.equal(rep.matched, 35);
		assert.ok(rep.accuracy > 0.95);
		assert.equal(rep.critical_failures, 1);
		assert.equal(rep.ok, false);
	});

	it("swapped_critical_case_labels_both_flagged", () => {
		const fx = loadFixture();
		const rows = perfectPredictions(fx);
		const a = caseRow(rows, "R05");
		const b = caseRow(rows, "R13");
		[a.route, b.route] = [b.route, a.route];
		[a.roles, b.roles] = [b.roles, a.roles];
		delete a.calls;
		delete a.calls_provenance; // captured calls would contradict the swapped roles
		const rep = evaluateRows(rows, fx);
		assert.deepEqual(new Set(rep.mismatches.map((m) => m.id)), new Set(["R05", "R13"]));
		assert.equal(rep.critical_failures, 1);
		assert.equal(rep.ok, false);
	});

	it("role_order_violation_detected", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R05", { roles: ["backend-worker", "debugger"] }), fx);
		assert.equal(rep.violations.role_order, 1);
		assert.equal(rep.violations.role_missing, 0);
	});

	it("policy_valid_alternative_route_accepted", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R06", { route: "T2_DEBUG_WORKER", roles: ["debugger", "backend-worker"] }), fx);
		assert.equal(rep.ok, true);
	});

	it("wrong_route_detected", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R13", { route: "T1_WORKER", roles: [] }), fx);
		assert.equal(rep.violations.route, 1);
		assert.equal(rep.ok, false);
	});

	it("specialist_only_hold_passes_unresolved_cases", () => {
		const fx = loadFixture();
		let rows = setRow(perfectPredictions(fx), "R02", { roles: ["database-specialist"] });
		rows = setRow(rows, "R04", { roles: ["ui-ux-specialist"] });
		const rep = evaluateRows(rows, fx);
		assert.equal(rep.ok, true, JSON.stringify(rep.mismatches));
	});

	it("worker_without_specialist_on_unresolved_case_is_critical", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R02", { roles: ["backend-worker"] }), fx);
		assert.equal(rep.violations.role_missing, 1);
		assert.equal(rep.critical_failures, 1);
	});

	it("forbidden_router_rejects_child_skill", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R19", { skills: ["backend", "frontend/solidjs-engineering"] }), fx);
		assert.equal(rep.violations.skill_forbidden, 1);
		assert.equal(rep.critical_failures, 1);
		assert.equal(rep.ok, false);
	});

	it("sibling_skill_name_not_forbidden_by_router_prefix", () => {
		const fx = loadFixture();
		const rep = evaluateRows(setRow(perfectPredictions(fx), "R19", { skills: ["backend", "frontend-tools"] }), fx);
		assert.equal(rep.violations.skill_forbidden, 0);
		assert.equal(rep.ok, true);
	});

	it("unregistered_but_syntax_valid_predicted_skill_not_rejected", () => {
		const fx = loadFixture();
		assert.equal(evaluateRows(setRow(perfectPredictions(fx), "R19", { skills: ["backend", "generic/vocabulary-path"] }), fx).ok, true);
	});
});

describe("InputValidationTests", () => {
	const fx = loadFixture();
	const ids = idsOf(fx);
	const good = toJsonl(perfectPredictions(fx));
	const goodLines = good.split("\n").filter(Boolean);
	const assertInvalid = (text, label) => rejects(() => ev.parsePredictions(text, ids), label);
	const textWith = (cid, changes) => { const rows = perfectPredictions(fx); setRow(rows, cid, changes); return toJsonl(rows); };

	it("good_text_parses", () => { assert.equal(Object.keys(ev.parsePredictions(good, ids)).length, 36); });
	it("malformed_json_line", () => assertInvalid(good.slice(0, -2) + "\n"));
	it("missing_case", () => assertInvalid(goodLines.slice(0, -1).join("\n") + "\n"));
	it("duplicate_case", () => assertInvalid([...goodLines, goodLines[0]].join("\n") + "\n"));
	it("unknown_case_id", () => assertInvalid(good + JSON.stringify({ id: "R99", route: "T0_MAIN", roles: [], skills: [] }) + "\n"));
	it("empty_predictions", () => assertInvalid(""));
	it("blank_interior_line", () => assertInvalid([...goodLines.slice(0, 3), "", ...goodLines.slice(3)].join("\n") + "\n"));

	it("unrecognized_field", () => {
		const rec = JSON.parse(goodLines[0]);
		rec.confidence = 0.9;
		assertInvalid(JSON.stringify(rec) + "\n" + goodLines.slice(1).join("\n") + "\n");
	});

	it("wrong_types_fail_closed", () => {
		const base = JSON.parse(goodLines[0]);
		for (const patch of [{ roles: "backend-worker" }, { route: true }, { id: 1 }, { skills: ["ok", 2] }, { route: "T9_UNKNOWN" }, { roles: ["not-a-role"] }]) {
			assertInvalid(JSON.stringify({ ...base, ...patch }) + "\n" + goodLines.slice(1).join("\n") + "\n", JSON.stringify(patch));
		}
	});

	it("non_finite_constants_rejected", () => {
		assert.ok(good.includes('"skills":[]'));
		for (const token of ["NaN", "Infinity", "-Infinity"]) assertInvalid(good.replace('"skills":[]', `"skills":[${token}]`), token);
	});

	it("duplicate_json_key_rejected", () => {
		const dup = goodLines[0].slice(0, -1) + ', "route": "T0_MAIN"}';
		assertInvalid(dup + "\n" + goodLines.slice(1).join("\n") + "\n");
	});

	it("skill_with_trailing_newline_cr_or_noncanonical_is_malformed", () => {
		for (const skill of ["frontend\n", "frontend\r", "frontend\r\n", " frontend", "Frontend"]) assertInvalid(textWith("R19", { skills: [skill] }), JSON.stringify(skill));
	});

	it("id_with_trailing_newline_or_cr_is_unknown", () => {
		for (const cid of ["R19\n", "R19\r", " R19"]) assertInvalid(textWith("R19", { id: cid }), JSON.stringify(cid));
	});

	it("deeply_nested_json_is_routing_eval_error", () => assertInvalid("[".repeat(100000) + "]".repeat(100000) + "\n"));
});

describe("FixtureValidationTests", () => {
	const assertBadFixture = (data, label) => rejects(() => ev.parseFixture(JSON.stringify(data)), label);
	it("empty_cases", () => { const d = rawFixture(); d.cases = []; assertBadFixture(d); });
	it("duplicate_case_id", () => { const d = rawFixture(); d.cases[1].id = d.cases[0].id; assertBadFixture(d); });
	it("critical_must_be_boolean", () => { const d = rawFixture(); d.cases[0].critical = 1; assertBadFixture(d); });
	it("required_role_must_be_allowed", () => { const d = rawFixture(); d.cases[0].expect.roles_allowed = []; assertBadFixture(d); });
	it("skill_cannot_be_required_and_forbidden", () => { const d = rawFixture(); d.cases[0].expect.skills_forbidden = ["backend"]; assertBadFixture(d); });
	it("unknown_role_in_fixture", () => {
		const d = rawFixture();
		d.cases[0].expect.roles_allowed = ["backend-worker", "backend-wrker"];
		d.cases[0].expect.roles_required = ["backend-wrker"];
		assertBadFixture(d);
	});
	it("unrecognized_top_level_field", () => { const d = rawFixture(); d.extra = 1; assertBadFixture(d); });
	it("case_id_with_trailing_newline_is_malformed", () => { const d = rawFixture(); d.cases[0].id = "R01\n"; assertBadFixture(d); });
	it("skill_name_with_trailing_newline_is_malformed", () => { const d = rawFixture(); d.cases[0].expect.skills_required = ["backend\n"]; assertBadFixture(d); });
	it("required_skill_under_forbidden_router_rejected", () => {
		const d = rawFixture();
		d.cases.find((c) => c.id === "R19").expect.skills_required = ["frontend/solidjs-engineering"];
		assertBadFixture(d);
	});
	it("deeply_nested_fixture_is_routing_eval_error", () => rejects(() => ev.parseFixture("[".repeat(100000) + "]".repeat(100000))));
});

// --- native contract parity: evaluator constants vs the subagent TypeBox/DAG source ---
function tsBlock(src, name) {
	const m = new RegExp(`const ${name} = Type\\.Object\\(\\{\\n(.*?)^\\}([^\\n]*)`, "ms").exec(src);
	return { keys: new Set([...m[1].matchAll(/^(?:\t| {4})(\w+):/gm)].map((x) => x[1])), tail: m[2], body: m[1] };
}
const same = (a, b) => (a instanceof Set && b instanceof Set ? a.size === b.size && [...a].every((x) => b.has(x)) : a === b);
const show = (v) => (v instanceof Set ? `{${[...v].sort().join(",")}}` : String(v));

/** Differences between a native-contract constant set (default: the evaluator's) and the subagent TypeBox/DAG source. */
function nativeDrift(contract = ev.NATIVE) {
	const src = readText(path.join(SUBAGENT_DIR, "index.ts"));
	const dagSrc = readText(path.join(SUBAGENT_DIR, "dag.ts"));
	const safety = readText(path.join(SUBAGENT_DIR, "safety-core.ts"));
	const found = [];
	const check = (label, native, local) => { if (!same(native, local)) found.push(`${label}: native ${show(native)} != evaluator ${show(local)}`); };
	const task = tsBlock(src, "TaskItem");
	const chain = tsBlock(src, "ChainItem");
	const dag = tsBlock(src, "DagNode");
	const root = tsBlock(src, "SubagentParams");
	check("TaskItem keys", task.keys, new Set(contract.ENTRY_KEYS));
	check("ChainItem keys", chain.keys, new Set(contract.ENTRY_KEYS));
	check("DagNode keys", dag.keys, new Set(contract.DAG_KEYS));
	check("SubagentParams keys", root.keys, new Set(contract.ROOT_KEYS));
	const cleanupBlock = /const CLEANUP = .*?Type\.Null\(\)\]\)\);/s.exec(src);
	check("CLEANUP schema keys", new Set([...cleanupBlock[0].matchAll(/\b(checkout|branch|base|pr|headSha|mergeCommit|quiescent): Type\./g)].map((x) => x[1])), new Set(contract.CLEANUP_KEYS));
	check("CLEANUP_REQUEST_KEYS", new Set(/const CLEANUP_REQUEST_KEYS = "([^"]+)"/.exec(safety)[1].split(",")), new Set(contract.CLEANUP_KEYS));
	check("cleanup role", /LEASE_ROLE = "([^"]+)"/.exec(safety)[1], contract.CLEANUP_ROLE);
	check("BARE_SHA", /const BARE_SHA = \/(.+)\/;/.exec(safety)[1], contract.SHA.source);
	check("DagNode additionalProperties false", dag.tail.includes("additionalProperties: false"), true);
	const literals = (text) => new Set([...text.matchAll(/Type\.Literal\("(\w+)"\)/g)].map((x) => x[1]));
	check("modelTier literals", literals(/^\s*modelTier:.*$/m.exec(task.body)[0]), new Set(contract.TIERS));
	check("modelSlot literals", literals(/^const MODEL_SLOT = .*$/m.exec(src)[0]), new Set(contract.SLOTS));
	check("root modelSlot literals", literals(/^\s*modelSlot: Type\.Optional\(Type\.Union.*$/m.exec(src)[0]), new Set(contract.SLOTS));
	for (const [name, body] of [["TaskItem", task.body], ["ChainItem", chain.body], ["DagNode", dag.body]]) check(`${name} modelSlot schema`, /^\s*modelSlot:.*$/m.exec(body)[0].trim(), "modelSlot: Type.Optional(MODEL_SLOT),");
	check("dag.ts NODE_KEYS", new Set([.../const NODE_KEYS = new Set\(\[(.*?)\]\)/s.exec(dagSrc)[1].matchAll(/"(\w+)"/g)].map((x) => x[1])), new Set(contract.DAG_KEYS));
	check("MAX_PARALLEL_TASKS", Number(/const MAX_PARALLEL_TASKS = (\d+);/.exec(src)[1]), contract.MAX_TASKS);
	check("DAG_NODE_LIMIT", Number(/DAG_NODE_LIMIT = (\d+)/.exec(dagSrc)[1]), contract.MAX_DAG_NODES);
	check("dag maxItems", Number(/dag: Type\.Optional\(Type\.Array\(DagNode, \{[^}]*maxItems: (\d+)/.exec(src)[1]), contract.MAX_DAG_NODES);
	check("DagNode id pattern", /id: Type\.String\(\{ pattern: "([^"]+)"/.exec(src)[1], contract.DAG_ID.source);
	check("dag.ts NODE_ID", /const NODE_ID = \/(.+)\/;/.exec(dagSrc)[1], contract.DAG_ID.source);
	const scopes = /const AgentScopeSchema = StringEnum\(\[(.*?)\] as const/s.exec(src)[1];
	check("agentScope values", new Set([...scopes.matchAll(/"(\w+)"/g)].map((x) => x[1])), new Set(contract.SCOPES));
	return found;
}

describe("ModelTierTests", () => {
	const fx = loadFixture();
	const runRows = (rows) => evaluateRows(rows, fx);

	it("six_difficult_roles_require_explicit_capable_and_controls_allow_economy", () => {
		const c = byId(fx);
		for (const [cid, role] of [["R18", "security-specialist"], ["R17", "concurrency-specialist"], ["R05", "debugger"], ["R10", "reviewer"], ["R02", "database-specialist"], ["R09", "test-engineer"]]) {
			assert.deepEqual(c[cid].expect.model_tiers[role], ["capable"], cid);
			assert.equal(c[cid].critical, true, cid);
		}
		assert.equal(Object.values(c).filter((x) => has(x.expect, "model_tiers")).length, 10);
		const controls = Object.entries(c).filter(([, x]) => Object.values(x.expect.model_tiers ?? {}).some((v) => !v.includes("capable"))).map(([cid]) => cid);
		assert.deepEqual(controls.sort(), ["R01", "R03", "R08", "R15"]);
		for (const cid of controls) for (const allowed of Object.values(c[cid].expect.model_tiers)) assert.deepEqual([...allowed].sort(), ["economy", "omitted"]);
	});

	it("omitted_capable_is_critical_failure", () => {
		const rows = perfectPredictions(fx);
		caseRow(rows, "R18").calls = [{ agent: "security-specialist", task: "t" }];
		const rep = runRows(rows);
		assert.equal(rep.violations.tier_omitted, 1);
		assert.equal(rep.critical_failures, 1);
		assert.equal(rep.ok, false);
	});

	it("wrong_tier_economy_for_difficult_role_is_critical", () => {
		const rows = perfectPredictions(fx);
		caseRow(rows, "R10").calls = [{ agent: "reviewer", task: "t", modelTier: "economy" }];
		const rep = runRows(rows);
		assert.equal(rep.violations.tier_wrong, 1);
		assert.equal(rep.critical_failures, 1);
	});

	it("universal_capable_bias_fails_economy_controls", () => {
		const rows = perfectPredictions(fx);
		caseRow(rows, "R01").calls = [{ agent: "backend-worker", task: "t", modelTier: "capable" }];
		const rep = runRows(rows);
		assert.equal(rep.violations.tier_wrong, 1);
		assert.equal(rep.critical_failures, 0);
		assert.equal(rep.mismatched, 1);
	});

	it("control_accepts_omission_and_explicit_economy", () => {
		for (const call of [{ agent: "backend-worker", task: "t" }, { agent: "backend-worker", task: "t", modelTier: "economy" }]) {
			const rows = perfectPredictions(fx);
			caseRow(rows, "R01").calls = [call];
			assert.equal(runRows(rows).ok, true, JSON.stringify(call));
		}
	});

	it("missing_calls_is_unobserved_not_a_pass", () => {
		const rows = perfectPredictions(fx);
		const row = caseRow(rows, "R17");
		delete row.calls;
		delete row.calls_provenance;
		const rep = runRows(rows);
		assert.equal(rep.violations.tier_unobserved, 1);
		assert.equal(rep.critical_failures, 1);
	});

	it("old_four_field_predictions_still_score_untiered_fixture", () => {
		const raw = rawFixture();
		for (const c of raw.cases) { delete c.expect.model_tiers; delete c.expect.max_dispatches; }
		const fixture = ev.parseFixture(JSON.stringify(raw));
		const rows = perfectPredictions(fx).map((r) => ({ id: r.id, route: r.route, roles: r.roles, skills: r.skills }));
		assert.equal(evaluateRows(rows, fixture).ok, true);
	});

	it("every_batch_entry_is_scored", () => {
		const okEntries = [{ agent: "debugger", task: "t", modelTier: "capable" }, { agent: "backend-worker", task: "t" }];
		const badEntries = [{ agent: "debugger", task: "t", modelTier: "capable" }, { agent: "debugger", task: "t" }, { agent: "backend-worker", task: "t" }];
		for (const key of ["chain", "tasks"]) {
			const rows = perfectPredictions(fx);
			const row = caseRow(rows, "R05");
			row.calls = [{ [key]: okEntries }];
			const rep = runRows(rows);
			assert.equal(rep.violations.tier_omitted + rep.violations.tier_wrong, 0, key);
			assert.equal(rep.ok, key === "chain", key); // parallel tasks prove no precedence
			row.calls = [{ [key]: badEntries }];
			row.roles = ["debugger", "debugger", "backend-worker"];
			assert.equal(runRows(rows).violations.tier_omitted, 1, key);
		}
		const dag = [{ id: "a", agent: "debugger", task: "t", modelTier: "capable" }, { id: "b", agent: "backend-worker", task: "t", dependsOn: ["a"] }];
		const rows = perfectPredictions(fx);
		caseRow(rows, "R05").calls = [{ dag }];
		assert.equal(runRows(rows).ok, true);
		delete dag[0].modelTier;
		assert.equal(runRows(rows).violations.tier_omitted, 1);
	});

	it("separate_calls_do_not_prove_order_or_completion", () => {
		const rows = perfectPredictions(fx);
		caseRow(rows, "R05").calls = [{ agent: "debugger", task: "t", modelTier: "capable" }, { agent: "backend-worker", task: "t" }];
		const rep = runRows(rows);
		assert.equal(rep.violations.order_unobserved, 1);
		assert.equal(rep.critical_failures, 1);
		assert.equal(rep.ok, false);
	});

	it("unexpected_role_in_calls_still_fails", () => {
		const rows = perfectPredictions(fx);
		const row = caseRow(rows, "R18");
		row.roles = ["security-specialist", "scout"];
		row.calls = [{ agent: "security-specialist", task: "t", modelTier: "capable" }, { agent: "scout", task: "t" }];
		assert.equal(runRows(rows).violations.role_unexpected, 1);
	});

	const assertBadRow = (changes, label) => {
		const rows = perfectPredictions(fx);
		Object.assign(caseRow(rows, "R18"), changes);
		rejects(() => ev.parsePredictions(toJsonl(rows), idsOf(fx)), label);
	};

	it("malformed_calls_fail_closed", () => {
		const sec = { agent: "security-specialist", task: "t", modelTier: "capable" };
		const bad = [
			[], "x", [{ ...sec, model: "gpt" }], [{ ...sec, modelTier: "premium" }],
			[{ ...sec, modelTier: null }], // runtime refuses null; the call never launched
			[{ agent: "security-specialist" }], // single mode needs task
			[{ tasks: [sec], agent: "security-specialist" }], [{ tasks: [sec], chain: [sec] }],
			[{ tasks: [sec], modelTier: "capable" }], // root tier is single-mode only
			[{ tasks: [] }], [{ dag: [{ agent: "security-specialist", task: "t" }] }], // dag node needs id
			[{ tasks: [{ ...sec, id: "a" }] }], // id is dag-only
		];
		for (const calls of bad) assertBadRow({ calls }, JSON.stringify(calls));
		assertBadRow({ calls: [{ tasks: [{ agent: "nobody", task: "t" }] }], roles: ["security-specialist"] });
	});

	it("roles_must_match_calls_and_provenance_is_required", () => {
		assertBadRow({ roles: ["security-specialist", "scout"] });
		assertBadRow({ calls_provenance: " " });
		for (const field of ["calls_provenance", "calls"]) { // each requires the other
			const rows = perfectPredictions(fx);
			delete caseRow(rows, "R18")[field];
			rejects(() => ev.parsePredictions(toJsonl(rows), idsOf(fx)), field);
		}
	});

	it("fixture_tier_expectations_validated", () => {
		for (const bad of [{ scout: ["capable"] }, { "security-specialist": ["premium"] }, { "security-specialist": [] }, { "security-specialist": ["capable", "capable"] }, {}, ["capable"]]) {
			const d = rawFixture();
			d.cases.find((c) => c.id === "R18").expect.model_tiers = bad;
			rejects(() => ev.parseFixture(JSON.stringify(d)), JSON.stringify(bad));
		}
	});

	it("native_contract_constants_match_subagent_source", () => { assert.deepEqual(nativeDrift(), []); });

	it("native_parity_check_detects_in_memory_drift", () => {
		// The comparison must be able to fail: drift each evaluator constant on a copy (ES module exports are read-only, so the contract object is passed in).
		const drifted = [
			["ENTRY_KEYS", new Set(["not_a_native_field"])], ["DAG_KEYS", new Set(["id"])], ["ROOT_KEYS", new Set(["agent"])],
			["CLEANUP_KEYS", new Set(["checkout"])], ["CLEANUP_ROLE", "general-worker"], ["SHA", /x/], ["MAX_TASKS", 9],
			["MAX_DAG_NODES", 9], ["DAG_ID", /x/], ["SCOPES", new Set(["user"])], ["TIERS", new Set(["economy"])], ["SLOTS", new Set()],
		];
		for (const [name, bad] of drifted) assert.ok(nativeDrift({ ...ev.NATIVE, [name]: bad }).length > 0, name);
		assert.deepEqual(Object.keys(ev.NATIVE).sort(), drifted.map(([n]) => n).sort());
		assert.deepEqual(nativeDrift(), []); // restored
	});
});

const node = (nid, agent = "security-specialist", extra = {}) => ({ id: nid, agent, task: "t", ...extra });
const entry = (agent = "security-specialist", extra = {}) => ({ agent, task: "t", ...extra });
/** Entry factory for a batch mode: dag nodes need an id. */
const maker = (mode) => (mode === "dag" ? (extra = {}) => node("a", "security-specialist", extra) : (extra = {}) => entry("security-specialist", extra));

describe("NativeCallValidationTests", () => {
	const rejected = (call, label = "") => rejects(() => ev.parseCalls([call], "calls"), `${label} ${JSON.stringify(call)}`, /calls\[0\]/);

	it("dag_graph_rules_match_native_validator", () => {
		const sec = node("s", "security-specialist", { modelTier: "capable" });
		const cases = [
			["self edge", [{ ...sec, dependsOn: ["s"] }]],
			["missing parent", [{ ...sec, dependsOn: ["missing"] }]],
			["string dependsOn", [{ ...sec, dependsOn: "s" }]],
			["null dependsOn", [{ ...sec, dependsOn: null }]],
			["non-string parent", [node("a"), { ...sec, dependsOn: [1] }]],
			["duplicate parent", [node("a"), { ...sec, dependsOn: ["a", "a"] }]],
			["duplicate id", [node("d", "debugger"), node("d", "backend-worker")]],
			["two-node cycle", [node("d", "debugger", { dependsOn: ["w"] }), node("w", "backend-worker", { dependsOn: ["d"] })]],
			["three-node cycle", [node("a", "security-specialist", { dependsOn: ["c"] }), node("b", "security-specialist", { dependsOn: ["a"] }), node("c", "security-specialist", { dependsOn: ["b"] })]],
			["unknown key", [{ ...sec, dependson: ["a"] }]],
			["missing id", [entry()]],
			["unknown agent", [node("a", "nobody")]],
			["blank task", [{ ...sec, task: "  " }]],
			["node not object", ["s"]],
			["nine nodes", Array.from({ length: 9 }, (_, i) => node(`n${i}`))],
			["no nodes", []],
		];
		for (const [label, nodes] of cases) rejected({ dag: nodes }, label);
		rejected({ dag: { s: sec } }, "dag not array");
	});

	it("dag_node_id_syntax_matches_native_pattern", () => {
		for (const bad of ["1a", "a b", "a\n", "", "_a", "x".repeat(33), 5, null, ["a"]]) rejected({ dag: [node(bad)] }, `id ${JSON.stringify(bad)}`);
		for (const g of ["a", "A1", "a_b-c", "x".repeat(32)]) assert.equal(ev.parseCalls([{ dag: [node(g)] }], "calls").length, 1, g);
	});

	it("optional_entry_values_are_typed_in_every_mode", () => {
		for (const mode of ["tasks", "chain", "dag"]) {
			const make = maker(mode);
			for (const [field, bad] of [["cwd", 123], ["cwd", ""], ["cwd", "  "], ["cwd", null], ["readOnly", "yes"], ["readOnly", 1], ["readOnly", 0], ["readOnly", null], ["task", 5], ["agent", 5]]) rejected({ [mode]: [make({ [field]: bad })] }, `${mode}.${field}`);
			assert.equal(ev.parseCalls([{ [mode]: [make({ cwd: "C:/work", readOnly: true })] }], "calls").length, 1, mode);
		}
	});

	it("entry_count_limits", () => {
		rejected({ tasks: Array.from({ length: ev.NATIVE_MAX_TASKS + 1 }, () => entry()) });
		assert.equal(ev.parseCalls([{ tasks: Array.from({ length: ev.NATIVE_MAX_TASKS }, () => entry()) }], "c").length, 8);
		assert.equal(ev.parseCalls([{ dag: Array.from({ length: ev.NATIVE_MAX_DAG_NODES }, (_, i) => node(`n${i}`)) }], "c").length, 8);
		// the native chain schema has no item limit, so the evaluator invents none
		assert.equal(ev.parseCalls([{ chain: Array.from({ length: 9 }, () => entry()) }], "c").length, 9);
	});

	it("batch_entries_must_be_objects_with_known_keys", () => {
		for (const mode of ["tasks", "chain"]) {
			rejected({ [mode]: ["x"] }, mode);
			rejected({ [mode]: [entry("security-specialist", { dependsOn: ["a"] })] }, mode);
			rejected({ [mode]: [entry("security-specialist", { id: "a" })] }, mode);
			rejected({ [mode]: { a: entry() } }, mode);
		}
	});

	it("model_slot_matches_native_contract", () => {
		// Optional per-entry string "fallback" that requires an explicit modelTier; root slot is single-mode only.
		const slotted = { modelTier: "capable", modelSlot: "fallback" };
		assert.equal(ev.parseCalls([entry("security-specialist", slotted)], "calls")[0].tier, "capable");
		for (const mode of ["tasks", "chain", "dag"]) {
			const make = maker(mode);
			assert.equal(ev.parseCalls([{ [mode]: [make(slotted)] }], "calls").length, 1, mode);
			for (const [label, extra] of [["no tier", { modelSlot: "fallback" }], ["primary", { ...slotted, modelSlot: "primary" }], ["null", { ...slotted, modelSlot: null }],
				["number", { ...slotted, modelSlot: 1 }], ["list", { ...slotted, modelSlot: ["fallback"] }], ["case", { ...slotted, modelSlot: "Fallback" }]]) rejected({ [mode]: [make(extra)] }, `${mode} ${label}`);
			rejected({ [mode]: [make(slotted)], modelSlot: "fallback" }, `${mode} root slot`);
		}
		for (const bad of ["primary", null, 1, "anthropic/claude-sonnet-5-5"]) rejected(entry("security-specialist", { ...slotted, modelSlot: bad }), `single ${bad}`);
		rejected(entry("security-specialist", { modelSlot: "fallback" }), "single without tier");
		rejected({ ...entry("security-specialist", slotted), agentScope: "project" }, "project scope");
	});

	it("root_option_types", () => {
		const base = entry("security-specialist", { modelTier: "capable" });
		for (const [field, bad] of [["background", "yes"], ["background", 1], ["background", null], ["agentScope", "nobody"], ["agentScope", ["user"]], ["agentScope", null],
			["confirmProjectAgents", []], ["confirmProjectAgents", 0], ["readOnly", "yes"], ["readOnly", 1], ["cwd", 123], ["cwd", ""], ["cwd", null], ["surprise", true]]) rejected({ ...base, [field]: bad }, field);
		const ok = ev.parseCalls([{ ...base, background: false, agentScope: "both", confirmProjectAgents: false, readOnly: false, cwd: "C:/work" }], "calls");
		assert.equal(ok[0].agent, "security-specialist");
	});

	it("root_background_and_scope_types_checked_in_batch_modes", () => {
		for (const call of [{ tasks: [entry()] }, { chain: [entry()] }, { dag: [node("a")] }]) {
			rejected({ ...call, background: "no" });
			rejected({ ...call, agentScope: "x" });
			rejected({ ...call, confirmProjectAgents: "no" });
			assert.equal(ev.parseCalls([{ ...call, background: false, agentScope: "user" }], "c").length, 1);
		}
	});

	it("root_cwd_and_readonly_are_single_mode_only", () => {
		// Batch modes ignore them natively; accepting them would credit an option that never applied.
		for (const call of [{ tasks: [entry()] }, { chain: [entry()] }, { dag: [node("a")] }]) {
			rejected({ ...call, cwd: "C:/work" });
			rejected({ ...call, readOnly: true });
		}
	});

	it("single_mode_needs_nonblank_agent_and_task", () => {
		for (const call of [{ agent: "reviewer" }, { task: "t" }, { agent: "reviewer", task: "" }, { agent: "reviewer", task: 5 }, { agent: "", task: "t" }, { agent: null, task: "t" }]) rejected(call);
	});

	it("pr_base_accepted_per_entry_and_at_single_root", () => {
		for (const mode of ["tasks", "chain", "dag"]) {
			const make = maker(mode);
			assert.equal(ev.parseCalls([{ [mode]: [make({ prBase: "main" })] }], "calls").length, 1, mode);
			assert.equal(ev.parseCalls([{ [mode]: [make({ prBase: "release/1.x" })] }], "calls").length, 1, mode);
		}
		assert.equal(ev.parseCalls([entry("security-specialist", { prBase: "main" })], "calls")[0].agent, "security-specialist");
		assert.equal(ev.parseCalls([{ agent: "release-engineer", task: "t", prBase: "main" }], "calls").length, 1);
	});

	it("pr_base_refuses_null_blank_and_non_string_in_every_mode", () => {
		for (const [label, bad] of [["null", null], ["blank", ""], ["spaces", "  "], ["number", 5], ["list", ["main"]], ["object", {}]]) {
			rejected(entry("security-specialist", { prBase: bad }), `single ${label}`);
			rejected({ agent: "release-engineer", task: "t", prBase: bad }, `single root ${label}`);
			for (const mode of ["tasks", "chain", "dag"]) rejected({ [mode]: [maker(mode)({ prBase: bad })] }, `${mode} ${label}`);
		}
	});

	it("pr_base_refused_at_batch_root_even_when_null", () => {
		for (const call of [{ tasks: [entry()] }, { chain: [entry()] }, { dag: [node("a")] }]) {
			rejected({ ...call, prBase: "main" }, "batch root prBase");
			rejected({ ...call, prBase: null }, "batch root null prBase");
		}
	});

	const CLEANUP = { checkout: "C:/p/worktrees/pi/t", branch: "feat/t", base: "main", pr: 12, headSha: "a".repeat(40), mergeCommit: "b".repeat(40), quiescent: true };
	const cleanupCall = (extra = {}) => ({ agent: "release-engineer", task: "t", cwd: "C:/p/pi", cleanup: { ...CLEANUP }, ...extra });

	it("cleanup_accepted_only_in_the_shape_and_launch_the_runtime_mints", () => {
		assert.equal(ev.parseCalls([cleanupCall()], "calls")[0].agent, "release-engineer");
		assert.equal(ev.parseCalls([cleanupCall({ background: false, readOnly: false })], "calls").length, 1);
	});

	it("cleanup_refused_for_wrong_shape_mode_role_or_companions", () => {
		const { quiescent: _q, ...noQuiescent } = CLEANUP;
		const badShapes = [
			["null", null], ["list", []], ["empty", {}], ["missing quiescent", noQuiescent],
			["extra key", { ...CLEANUP, force: true }], ["quiescent false", { ...CLEANUP, quiescent: false }], ["quiescent string", { ...CLEANUP, quiescent: "true" }],
			["blank checkout", { ...CLEANUP, checkout: " " }], ["pr string", { ...CLEANUP, pr: "12" }], ["pr bool", { ...CLEANUP, pr: true }],
			["pr zero", { ...CLEANUP, pr: 0 }], ["pr float", { ...CLEANUP, pr: 1.5 }], ["short sha", { ...CLEANUP, headSha: "abc" }],
			["upper sha", { ...CLEANUP, mergeCommit: "A".repeat(40) }],
		];
		for (const [label, bad] of badShapes) rejected({ ...cleanupCall(), cleanup: bad }, label);
		const { cwd: _cwd, ...noCwd } = cleanupCall();
		for (const [label, call] of [["other role", cleanupCall({ agent: "general-worker" })], ["no cwd", noCwd], ["with prBase", cleanupCall({ prBase: "main" })], ["readOnly", cleanupCall({ readOnly: true })]]) rejected(call, label);
		for (const mode of ["tasks", "chain", "dag"]) {
			const make = maker(mode);
			rejected({ [mode]: [make({ agent: "release-engineer" })], cleanup: { ...CLEANUP } }, `batch root ${mode}`);
			rejected({ [mode]: [make({ agent: "release-engineer", cleanup: { ...CLEANUP } })] }, `per-entry ${mode}`);
		}
	});

	it("invalid_graph_never_scores_pass_for_a_difficult_role", () => {
		const rows = perfectPredictions(loadFixture());
		caseRow(rows, "R18").calls = [{ dag: [node("s", "security-specialist", { modelTier: "capable", dependsOn: ["s"] })] }];
		rejects(() => evaluateRows(rows));
	});

	it("cli_exits_two_without_result_for_invalid_native_call", () => {
		const rows = perfectPredictions(loadFixture());
		caseRow(rows, "R18").calls = [{ dag: [node("s", "security-specialist", { modelTier: "capable", dependsOn: ["s"] })] }];
		const r = runCli("--cases", CASES, "--predictions", writeTmp("bad.jsonl", toJsonl(rows)));
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stderr, /calls\[0\]/);
		assert.match(r.stderr, /cannot depend on itself/);
		assert.ok(!r.stdout.includes("RESULT:"));
		assert.ok(noTrace(r.stderr));
	});
});

function scoped(mode, tiers, scope = "project") {
	const item = (i, tier) => {
		const extra = tier !== null ? { modelTier: tier } : {};
		return mode === "dag" ? node(`n${i}`, "security-specialist", extra) : entry("security-specialist", extra);
	};
	const call = mode === "single" ? { agent: "security-specialist", task: "t", ...(tiers[0] ? { modelTier: tiers[0] } : {}) } : { [mode]: tiers.map((t, i) => item(i, t)) };
	return { ...call, agentScope: scope };
}

describe("ProjectScopeTierTests", () => {
	const assertRefused = (call, label = "") => rejects(() => ev.parseCalls([call], "calls"), `${label} ${JSON.stringify(call)}`, /calls\[0\]\.agentScope/);

	it("project_scope_refuses_explicit_tier_in_every_mode", () => {
		for (const mode of ["single", "tasks", "chain", "dag"]) for (const tier of ["economy", "capable"]) assertRefused(scoped(mode, [tier]), `${mode} ${tier}`);
	});
	it("project_scope_refuses_tier_on_any_later_batch_entry", () => {
		for (const mode of ["tasks", "chain", "dag"]) {
			assertRefused(scoped(mode, [null, "capable"]), `${mode} second`);
			assertRefused(scoped(mode, [null, null, "economy"]), `${mode} third`);
		}
	});
	it("refusal_applies_to_each_call_in_a_list", () => {
		rejects(() => ev.parseCalls([scoped("single", [null]), scoped("chain", [null, "capable"])], "calls"), "", /calls\[1\]\.agentScope/);
	});
	it("project_scope_without_explicit_tier_still_parses", () => {
		for (const mode of ["single", "tasks", "chain", "dag"]) assert.deepEqual(ev.parseCalls([scoped(mode, [null])], "calls").map((d) => d.tier), [null], mode);
	});
	it("user_and_both_scope_with_explicit_tier_unchanged", () => {
		for (const scope of ["user", "both"]) assert.deepEqual(ev.parseCalls([scoped("chain", ["economy", "capable"], scope)], "calls").map((d) => d.tier), ["economy", "capable"], scope);
	});
	it("default_scope_with_explicit_tier_unchanged", () => {
		assert.deepEqual(ev.parseCalls([entry("security-specialist", { modelTier: "capable" })], "calls").map((d) => d.tier), ["capable"]);
	});
	it("evaluate_scores_nothing_for_project_tier", () => {
		const rows = perfectPredictions(loadFixture());
		caseRow(rows, "R18").calls = [scoped("single", ["capable"])];
		rejects(() => evaluateRows(rows));
	});
	it("cli_refuses_project_tier_without_result", () => {
		for (const [mode, tiers] of [["single", ["capable"]], ["chain", [null, "economy"]], ["dag", ["capable"]]]) {
			const rows = perfectPredictions(loadFixture());
			caseRow(rows, "R18").calls = [scoped(mode, tiers)];
			const r = runCli("--cases", CASES, "--predictions", writeTmp("p.jsonl", toJsonl(rows)));
			assert.equal(r.status, 2, `${mode}: ${r.stdout}${r.stderr}`);
			assert.match(r.stderr, /calls\[0\]\.agentScope/, mode);
			assert.ok(!r.stdout.includes("RESULT:"), mode);
			assert.ok(!r.stdout.includes("matched:"), mode);
			assert.ok(noTrace(r.stderr), mode);
		}
	});
});

describe("CallOrderTests", () => {
	const fx = loadFixture();
	const DBG = node("d", "debugger", { modelTier: "capable" });
	const WRK = node("w", "backend-worker");
	const r05 = (calls, roles = ["debugger", "backend-worker"]) => {
		const rows = perfectPredictions(fx);
		const row = caseRow(rows, "R05");
		row.calls = calls;
		row.roles = [...roles];
		return evaluateRows(rows, fx);
	};

	it("dependency_ancestry_decides_not_declaration_order", () => {
		const dbgFirst = [DBG, { ...WRK, dependsOn: ["d"] }];
		for (const [label, nodes] of [["debugger declared first", dbgFirst], ["worker declared first", [...dbgFirst].reverse()]]) {
			const rep = r05([{ dag: nodes }]);
			assert.equal(rep.ok, true, label);
			assert.equal(rep.critical_failures, 0, label);
		}
	});

	it("reversed_dependency_is_critical_whatever_the_declaration_order", () => {
		const reversedEdge = [{ ...DBG, dependsOn: ["w"] }, WRK];
		for (const [label, nodes] of [["debugger declared first", reversedEdge], ["worker declared first", [...reversedEdge].reverse()]]) {
			const rep = r05([{ dag: nodes }]);
			assert.equal(rep.violations.role_order, 1, label);
			assert.equal(rep.critical_failures, 1, label);
			assert.equal(rep.ok, false, label);
		}
	});

	it("roles_list_order_is_not_runtime_order", () => {
		assert.equal(r05([{ dag: [DBG, { ...WRK, dependsOn: ["d"] }] }], ["backend-worker", "debugger"]).ok, true);
	});

	it("parallel_and_unrelated_nodes_prove_no_precedence", () => {
		const entries = [entry("debugger", { modelTier: "capable" }), entry("backend-worker")];
		for (const [label, call] of [["tasks", { tasks: entries }], ["dag without edge", { dag: [DBG, WRK] }]]) {
			const rep = r05([call]);
			assert.equal(rep.violations.order_unobserved, 1, label);
			assert.equal(rep.violations.role_order, 0, label);
			assert.equal(rep.critical_failures, 1, label);
			assert.equal(rep.ok, false, label);
		}
	});

	it("chain_order_is_guaranteed_within_the_call", () => {
		const good = [entry("debugger", { modelTier: "capable" }), entry("backend-worker")];
		assert.equal(r05([{ chain: good }]).ok, true);
		const rep = r05([{ chain: [...good].reverse() }]);
		assert.equal(rep.violations.role_order, 1);
		assert.equal(rep.critical_failures, 1);
	});

	it("separate_calls_do_not_prove_order", () => {
		const rep = r05([entry("debugger", { modelTier: "capable" }), entry("backend-worker")]);
		assert.equal(rep.violations.order_unobserved, 1);
		assert.equal(rep.ok, false);
	});

	it("every_dispatch_of_the_later_role_needs_an_earlier_ancestor", () => {
		const rep = r05([{ dag: [DBG, { ...WRK, dependsOn: ["d"] }, node("x", "backend-worker")] }], ["debugger", "backend-worker", "backend-worker"]);
		assert.equal(rep.violations.order_unobserved, 1);
	});

	it("transitive_ancestry_counts", () => {
		const nodes = [DBG, { ...WRK, dependsOn: ["d"] }, node("w2", "backend-worker", { dependsOn: ["w"] })];
		assert.equal(r05([{ dag: nodes }], ["debugger", "backend-worker", "backend-worker"]).ok, true);
	});

	it("roles_must_match_calls_as_a_multiset", () => {
		const rows = perfectPredictions(fx);
		const row = caseRow(rows, "R05");
		row.calls = [{ dag: [DBG, { ...WRK, dependsOn: ["d"] }] }];
		row.roles = ["debugger", "debugger", "backend-worker"];
		rejects(() => evaluateRows(rows, fx));
	});

	it("legacy_role_only_predictions_keep_list_order_semantics", () => {
		const raw = rawFixture();
		for (const c of raw.cases) { delete c.expect.model_tiers; delete c.expect.max_dispatches; }
		const fixture = ev.parseFixture(JSON.stringify(raw));
		const base = perfectPredictions(fx).map((r) => ({ id: r.id, route: r.route, roles: r.roles, skills: r.skills }));
		assert.equal(evaluateRows(base, fixture).ok, true);
		caseRow(base, "R05").roles = ["backend-worker", "debugger"];
		const rep = evaluateRows(base, fixture);
		assert.equal(rep.violations.role_order, 1);
		assert.equal(rep.critical_failures, 1);
	});
});

describe("MalformedTierTests", () => {
	const VALUES = [[], {}, [1], { a: 1 }, 0, 1, 1.5, true, false, null, "premium", "", "Capable", "omitted"];

	it("every_mode_rejects_every_unsupported_tier_type", () => {
		const shapes = [
			["single", (t) => entry("security-specialist", { modelTier: t })],
			["tasks", (t) => ({ tasks: [entry("security-specialist", { modelTier: t })] })],
			["chain", (t) => ({ chain: [entry("security-specialist", { modelTier: t })] })],
			["dag", (t) => ({ dag: [node("a", "security-specialist", { modelTier: t })] })],
		];
		for (const [label, make] of shapes) for (const bad of VALUES) rejects(() => ev.parseCalls([make(bad)], "calls"), `${label} ${JSON.stringify(bad)}`, /modelTier/);
	});

	it("cli_malformed_tier_container_exits_two_without_traceback", () => {
		for (const bad of [[], {}]) {
			const rows = perfectPredictions(loadFixture());
			caseRow(rows, "R18").calls = [entry("security-specialist", { modelTier: bad })];
			const r = runCli("--cases", CASES, "--predictions", writeTmp("t.jsonl", toJsonl(rows)));
			assert.equal(r.status, 2, r.stderr);
			assert.match(r.stderr, /modelTier/);
			assert.ok(noTrace(r.stderr));
			assert.ok(!r.stdout.includes("RESULT:"));
		}
	});

	it("internal_type_errors_are_not_masked", () => {
		// ES module exports cannot be monkey-patched, so a getter throwing a genuine TypeError stands in for the legacy mock.patch of `_text`.
		const boom = { agent: "security-specialist", get task() { throw new TypeError("internal bug"); } };
		assert.throws(() => ev.parseCalls([boom], "calls"), (e) => e instanceof TypeError && !(e instanceof ev.RoutingEvalError) && e.message === "internal bug");
	});
});

describe("DispatchLimitTests", () => {
	const fx = loadFixture();
	const runCase = (cid, roles, calls) => {
		const rows = perfectPredictions(fx);
		Object.assign(caseRow(rows, cid), { roles, calls, calls_provenance: "unit-test synthetic capture" });
		return evaluateRows(rows, fx);
	};

	it("near_miss_cases_carry_dispatch_limits", () => {
		const c = byId(fx);
		for (const [cid, role] of [["R33", "debugger"], ["R34", "general-worker"], ["R35", "backend-worker"]]) {
			assert.equal(c[cid].kind, "near_miss", cid);
			assert.deepEqual({ ...c[cid].expect.max_dispatches }, { [role]: 1 }, cid); // parsed objects have a null prototype
		}
		assert.deepEqual(c.R33.expect.roles_required, ["debugger", "backend-worker"]);
	});

	it("within_limit_passes_in_every_call_mode", () => {
		const w = { agent: "general-worker", task: "t" };
		for (const call of [w, { tasks: [w] }, { chain: [w] }, { dag: [{ ...w, id: "a" }] }]) {
			const rep = runCase("R34", ["general-worker"], [call]);
			assert.equal(rep.ok, true, JSON.stringify(call));
			assert.equal(rep.violations.dispatch_over, 0);
		}
	});

	it("over_fanout_counts_every_mode_and_separate_calls", () => {
		const w = { agent: "general-worker", task: "t" };
		for (const [label, calls] of [["tasks", [{ tasks: [w, w] }]], ["chain", [{ chain: [w, w] }]], ["dag", [{ dag: [{ ...w, id: "a" }, { ...w, id: "b" }] }]], ["separate", [w, w]]]) {
			const rep = runCase("R34", ["general-worker", "general-worker"], calls);
			assert.equal(rep.violations.dispatch_over, 1, label);
			assert.equal(rep.ok, false, label);
			assert.ok(rep.mismatches[0].details.at(-1).includes("dispatched 2 times"), label);
		}
	});

	it("limit_applies_per_role_not_to_other_allowed_roles", () => {
		const dbg = { agent: "debugger", task: "t" };
		const wrk = { agent: "backend-worker", task: "t" };
		assert.equal(runCase("R33", ["debugger", "backend-worker", "backend-worker"], [{ chain: [dbg, wrk, wrk] }]).violations.dispatch_over, 0);
		assert.equal(runCase("R33", ["debugger", "debugger", "backend-worker"], [{ chain: [dbg, dbg, wrk] }]).violations.dispatch_over, 1);
	});

	it("counts_do_not_prove_order", () => {
		const rep = runCase("R33", ["debugger", "backend-worker"], [{ tasks: [{ agent: "debugger", task: "t" }, { agent: "backend-worker", task: "t" }] }]);
		assert.equal(rep.violations.dispatch_over, 0);
		assert.equal(rep.violations.order_unobserved, 1);
	});

	it("missing_calls_is_unobserved_not_a_pass", () => {
		const rows = perfectPredictions(fx);
		const row = caseRow(rows, "R35");
		delete row.calls;
		delete row.calls_provenance;
		const rep = evaluateRows(rows, fx);
		assert.equal(rep.violations.dispatch_unobserved, 1);
		assert.equal(rep.violations.dispatch_over, 0);
		assert.equal(rep.ok, false);
		assert.deepEqual([rep.dispatch_cases, rep.dispatch_observed], [3, 2]);
	});

	it("fixture_validation", () => {
		const raw = rawFixture();
		for (const bad of [{}, { "backend-worker": 0 }, { "backend-worker": true }, { "backend-worker": "1" }, { "backend-worker": 1.5 }, { debugger: 1 }, { nonsense: 1 }]) {
			const mutated = clone(raw);
			mutated.cases.find((c) => c.id === "R35").expect.max_dispatches = bad;
			rejects(() => ev.parseFixture(JSON.stringify(mutated)), JSON.stringify(bad));
		}
		assert.deepEqual(raw.cases.find((c) => c.id === "R35").expect.max_dispatches, { "backend-worker": 1 });
	});

	it("old_fixtures_without_limits_are_unchanged", () => {
		const raw = rawFixture();
		for (const c of raw.cases) delete c.expect.max_dispatches;
		const rep = evaluateRows(perfectPredictions(fx), ev.parseFixture(JSON.stringify(raw)));
		assert.deepEqual([rep.dispatch_cases, rep.ok], [0, true]);
	});
});

describe("ReadDiagnosticsTests", () => {
	const R01 = "agent/skills/backend/SKILL.md";
	const R21 = "agent/skills/engineering-harness/ship/index.md";
	const fx = loadFixture();
	const obs = (events, complete = true) => ({ provenance: "unit-test synthetic trace", complete, events: events.map(([p, s]) => ({ path: p, status: s })) });
	const runReads = (byCase) => {
		const rows = perfectPredictions(fx);
		for (const [cid, value] of Object.entries(byCase)) caseRow(rows, cid).read_observations = value;
		return evaluateRows(rows, fx);
	};

	it("fixture_declares_two_required_read_maps_pointing_at_existing_files", () => {
		const c = byId(fx);
		assert.deepEqual(c.R01.expect.required_reads, [R01]);
		assert.deepEqual(c.R21.expect.required_reads, [R21]);
		for (const p of [R01, R21]) assert.ok(fs.statSync(path.join(REPO_ROOT, p)).isFile(), p);
	});

	it("no_observation_is_unknown_not_zero", () => {
		const d = evaluateRows(perfectPredictions(fx), fx).read_diagnostics;
		assert.deepEqual([d.mapped_cases, d.measured_cases, d.unknown_cases], [2, 0, ["R01", "R21"]]);
		assert.equal(d.recall, null);
		assert.equal(d.zero_rate, null);
		assert.equal(d.zero_observed_cases, 0);
	});

	it("incomplete_observation_is_unknown_not_zero", () => {
		const d = runReads({ R01: obs([], false), R21: obs([[R21, "full"]], false) }).read_diagnostics;
		assert.deepEqual(d.unknown_cases, ["R01", "R21"]);
		assert.equal(d.zero_rate, null);
		assert.equal(d.statuses.full, 1); // events are still tallied, never turned into a rate
	});

	it("complete_observations_report_recall_and_zero_rate", () => {
		const d = runReads({ R01: obs([[R01, "full"]]), R21: obs([]) }).read_diagnostics;
		assert.deepEqual([d.measured_cases, d.required_full, d.required_total], [2, 1, 2]);
		assert.equal(d.recall, 0.5);
		assert.deepEqual([d.zero_observed_cases, d.zero_rate], [1, 0.5]);
		assert.deepEqual(d.unknown_cases, []);
	});

	it("only_a_full_successful_read_counts_other_statuses_are_distinct", () => {
		const events = ["partial", "truncated", "failed", "injected", "retained"].map((s) => [R01, s]);
		const d = runReads({ R01: obs(events), R21: obs([[R21, "full"]]) }).read_diagnostics;
		assert.deepEqual([d.required_full, d.required_total, d.zero_observed_cases], [1, 2, 1]);
		for (const s of ["partial", "truncated", "failed", "injected", "retained"]) assert.equal(d.statuses[s], 1, s);
		assert.equal(d.statuses.full, 1);
	});

	it("paths_match_exactly", () => {
		const d = runReads({ R01: obs([["./" + R01, "full"], [R01.toUpperCase(), "full"]]), R21: obs([[R21.replaceAll("/", "\\"), "full"]]) }).read_diagnostics;
		assert.equal(d.required_full, 0);
	});

	it("diagnostics_never_change_score_ok_or_critical", () => {
		const base = evaluateRows(perfectPredictions(fx), fx);
		const zero = runReads({ R01: obs([]), R21: obs([]) });
		const full = runReads({ R01: obs([[R01, "full"]]), R21: obs([[R21, "full"]]) });
		const strip = (rep) => Object.fromEntries(Object.entries(rep).filter(([k]) => k !== "read_diagnostics"));
		assert.deepEqual(strip(base), strip(zero));
		assert.deepEqual(strip(base), strip(full));
		assert.ok(zero.ok && full.ok);
	});

	it("observation_without_a_required_map_is_tallied_only", () => {
		const d = runReads({ R03: obs([["agent/skills/frontend/SKILL.md", "full"]]) }).read_diagnostics;
		assert.deepEqual([d.observations, d.mapped_cases, d.statuses.full], [1, 2, 1]);
		assert.equal(d.measured_cases, 0);
	});

	it("malformed_observations_fail_closed", () => {
		const good = obs([[R01, "full"]]);
		const bad = [null, [], {}, { ...good, extra: 1 }, { ...good, provenance: " " }, { ...good, complete: "yes" }, { ...good, complete: 1 }, { ...good, events: {} },
			{ ...good, events: [{ path: R01 }] }, { ...good, events: [{ path: R01, status: "read" }] }, { ...good, events: [{ path: "", status: "full" }] },
			{ ...good, events: [{ path: R01, status: "full", n: 1 }] }];
		for (const value of bad) {
			const rows = perfectPredictions(fx);
			caseRow(rows, "R01").read_observations = value;
			rejects(() => ev.parsePredictions(toJsonl(rows), idsOf(fx)), JSON.stringify(value));
		}
	});

	it("required_reads_fixture_validation", () => {
		const raw = rawFixture();
		for (const bad of [[], "x", [""], [1], ["a", "a"]]) {
			const mutated = clone(raw);
			mutated.cases.find((c) => c.id === "R01").expect.required_reads = bad;
			rejects(() => ev.parseFixture(JSON.stringify(mutated)), JSON.stringify(bad));
		}
	});

	it("cli_labels_diagnostics_non_scoring_and_self_check_synthesizes_no_reads", () => {
		const sc = runCli("--cases", CASES, "--self-check");
		assert.match(sc.stdout, /required_full_read_recall=UNKNOWN/);
		assert.match(sc.stdout, /NOT skill use or activation/);
		assert.match(sc.stdout, /observations=0/);
		const rows = perfectPredictions(fx);
		caseRow(rows, "R01").read_observations = obs([[R01, "full"]]);
		const r = runCli("--cases", CASES, "--predictions", writeTmp("pred.jsonl", toJsonl(rows)));
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.stdout.includes("required_full_read_recall=1.0000 (1/1)"));
		assert.ok(r.stdout.includes("read_diagnostics (non-scoring"));
		assert.ok(r.stdout.includes("RESULT: PASS"));
	});
});

describe("CliTests", () => {
	const fx = loadFixture();

	it("perfect_predictions_exit_zero", () => {
		const r = runCli("--cases", CASES, "--predictions", writeTmp("pred.jsonl", toJsonl(perfectPredictions(fx))));
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.stdout.includes("matched: 36/36"));
		assert.ok(r.stdout.includes("RESULT: PASS"));
		assert.ok(r.stdout.includes("does NOT prove runtime skill activation"));
	});

	it("mismatch_exit_one_with_report", () => {
		const r = runCli("--cases", CASES, "--predictions", writeTmp("pred.jsonl", toJsonl(setRow(perfectPredictions(fx), "R05", { roles: ["backend-worker"] }))));
		assert.equal(r.status, 1, r.stderr);
		assert.ok(r.stdout.includes("MISMATCH R05 [CRITICAL]"));
		assert.ok(r.stdout.includes("RESULT: FAIL"));
	});

	it("invalid_input_exit_two", () => {
		const r = runCli("--cases", CASES, "--predictions", writeTmp("bad.jsonl", "{not json}\n"));
		assert.equal(r.status, 2);
		assert.ok(r.stderr.includes("error:"));
	});

	it("missing_file_exit_two", () => {
		const r = runCli("--cases", path.join(TMP, "absent.json"), "--self-check");
		assert.equal(r.status, 2);
		assert.ok(r.stderr.includes("error:"));
	});

	it("self_check_is_labelled_not_measured", () => {
		const r = runCli("--cases", CASES, "--self-check");
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.stdout.includes("NOT measured model accuracy"));
	});

	it("requires_one_input_source", () => { assert.equal(runCli("--cases", CASES).status, 2); });

	it("forbidden_child_skill_exit_one_critical", () => {
		const rows = setRow(perfectPredictions(fx), "R19", { skills: ["backend", "frontend/solidjs-engineering"] });
		const r = runCli("--cases", CASES, "--predictions", writeTmp("child.jsonl", toJsonl(rows)));
		assert.equal(r.status, 1, r.stderr);
		assert.ok(r.stdout.includes("MISMATCH R19 [CRITICAL]"));
	});

	it("trailing_newline_skill_exit_two", () => {
		const rows = setRow(perfectPredictions(fx), "R19", { skills: ["backend", "frontend\n"] });
		const r = runCli("--cases", CASES, "--predictions", writeTmp("nl.jsonl", toJsonl(rows)));
		assert.equal(r.status, 2, r.stdout);
		assert.ok(r.stderr.includes("error:"));
	});

	it("crlf_predictions_hash_raw_bytes", () => {
		const raw = Buffer.from(toJsonl(perfectPredictions(fx)).replaceAll("\n", "\r\n"), "utf8");
		const r = runCli("--cases", CASES, "--predictions", writeTmp("crlf.jsonl", raw));
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.stdout.includes("sha256=" + crypto.createHash("sha256").update(raw).digest("hex")));
		assert.ok(r.stdout.includes("matched: 36/36"));
	});

	it("utf8_bom_and_invalid_utf8_predictions_exit_two", () => {
		const body = Buffer.from(toJsonl(perfectPredictions(fx)), "utf8");
		for (const [name, raw] of [["bom.jsonl", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])], ["bad.jsonl", Buffer.concat([Buffer.from([0xff]), body])]]) {
			const r = runCli("--cases", CASES, "--predictions", writeTmp(name, raw));
			assert.equal(r.status, 2, name);
			assert.ok(r.stderr.includes("error:"), name);
		}
	});

	it("deeply_nested_predictions_exit_two_without_traceback", () => {
		const r = runCli("--cases", CASES, "--predictions", writeTmp("deep.jsonl", "[".repeat(100000) + "]".repeat(100000) + "\n"));
		assert.equal(r.status, 2, r.stderr);
		assert.ok(r.stderr.includes("error:"));
		assert.ok(noTrace(r.stderr));
		assert.ok(!r.stdout.includes("RESULT:"));
	});

	it("deeply_nested_fixture_exit_two_without_traceback", () => {
		const r = runCli("--cases", writeTmp("deep.json", '{"schema": ' + "[".repeat(100000) + "]".repeat(100000) + "}\n"), "--self-check");
		assert.equal(r.status, 2, r.stderr);
		assert.ok(r.stderr.includes("error:"));
		assert.ok(noTrace(r.stderr));
		assert.ok(!r.stdout.includes("RESULT:"));
	});

	const optionalRoleFixture = (cap) => {
		// Accepted optional-role shape: general-worker allowed and capped, but not required.
		const raw = rawFixture();
		const expect = raw.cases.find((c) => c.id === "R34").expect;
		expect.roles_required = [];
		expect.max_dispatches = { "general-worker": cap };
		return writeTmp(`optional-cap${cap}.json`, JSON.stringify(raw));
	};

	it("optional_role_cap_one_self_check_exits_zero_without_traceback", () => {
		const r = runCli("--cases", optionalRoleFixture(1), "--self-check");
		assert.equal(r.status, 0, r.stderr);
		assert.ok(noTrace(r.stderr));
		assert.ok(r.stdout.includes("matched: 36/36"));
		assert.ok(r.stdout.includes("RESULT: PASS"));
	});

	it("optional_role_cap_zero_is_contextual_input_error", () => {
		const r = runCli("--cases", optionalRoleFixture(0), "--self-check");
		assert.equal(r.status, 2, r.stderr);
		assert.ok(r.stderr.includes("R34.max_dispatches.general-worker: expected an integer >= 1"));
		assert.ok(noTrace(r.stderr));
	});

	it("optional_role_predictions_without_calls_stay_unobserved", () => {
		const file = optionalRoleFixture(1);
		const rows = perfectPredictions(ev.parseFixture(fs.readFileSync(file, "utf8")));
		const row = caseRow(rows, "R34");
		delete row.calls;
		delete row.calls_provenance;
		const r = runCli("--cases", file, "--predictions", writeTmp("optional-unobserved.jsonl", toJsonl(rows)));
		assert.equal(r.status, 1, r.stderr);
		assert.ok(r.stdout.includes("no recorded native calls to count dispatches of general-worker"));
		assert.ok(noTrace(r.stderr));
	});

	it("optional_role_predictions_with_explicit_zero_calls_pass", () => {
		const file = optionalRoleFixture(1);
		const rows = perfectPredictions(ev.parseFixture(fs.readFileSync(file, "utf8")));
		const row = caseRow(rows, "R34");
		assert.deepEqual([row.roles, row.calls], [[], []]);
		const r = runCli("--cases", file, "--predictions", writeTmp("optional-zero.jsonl", toJsonl(rows)));
		assert.equal(r.status, 0, r.stderr);
		assert.ok(r.stdout.includes("dispatch_cases: 3 (with calls provided: 3)"));
		assert.ok(r.stdout.includes("RESULT: PASS"));
	});

	it("optional_role_predictions_over_cap_still_fail", () => {
		const file = optionalRoleFixture(1);
		const rows = perfectPredictions(ev.parseFixture(fs.readFileSync(file, "utf8")));
		setRow(rows, "R34", { roles: ["general-worker", "general-worker"], calls: [{ agent: "general-worker", task: "t" }, { agent: "general-worker", task: "t" }] });
		const r = runCli("--cases", file, "--predictions", writeTmp("optional-over.jsonl", toJsonl(rows)));
		assert.equal(r.status, 1, r.stderr);
		assert.ok(r.stdout.includes("dispatched 2 times"));
		assert.ok(noTrace(r.stderr));
	});
});

// ---------------------------------------------------------------------------------------------------------------------------
// New tests (not legacy cases): deliberate Python -> Node language-runtime differences, documented in references/skill-evaluation.md.
// ---------------------------------------------------------------------------------------------------------------------------
describe("NodeRuntimeDifferenceTests", () => {
	const fx = loadFixture();
	const ids = idsOf(fx);
	const cleanupText = (pr) => `[{"agent":"release-engineer","task":"t","cwd":"C:/p/pi","cleanup":{"checkout":"c","branch":"b","base":"main","pr":${pr},"headSha":"${"a".repeat(40)}","mergeCommit":"${"b".repeat(40)}","quiescent":true}}]`;

	it("json_float_tokens_stay_distinct_from_integers_in_text", () => {
		// Python tells 1.0 (float) from 1 (int); JS numbers do not, so the strict JSON reader tags float tokens.
		assert.equal(ev.parseCalls(ev.parseJson(cleanupText("12"), "x"), "calls").length, 1);
		for (const token of ["12.0", "1e1", "12E0"]) rejects(() => ev.parseCalls(ev.parseJson(cleanupText(token), "x"), "calls"), token, /pr: expected a positive integer/);
		const floatLimit = readText(CASES).replace(/"max_dispatches":\s*\{\s*"backend-worker":\s*1\s*\}/, '"max_dispatches": {"backend-worker": 1.0}');
		assert.ok(floatLimit.includes("1.0}"));
		rejects(() => ev.parseFixture(floatLimit), "1.0", /expected an integer >= 1, got 1\.0/);
	});

	it("big_integers_stay_integers_and_are_range_checked", () => {
		rejects(() => ev.parseCalls(ev.parseJson(cleanupText("123456789012345678901234567890"), "x"), "calls"), "bigint pr", /pr: expected a positive integer/);
		assert.equal(typeof ev.parseJson('{"a":123456789012345678901234567890}', "x").a, "bigint");
		assert.equal(ev.parseCalls(ev.parseJson(cleanupText("999999999"), "x"), "calls").length, 1);
		rejects(() => ev.parseCalls(ev.parseJson(cleanupText("1000000000"), "x"), "calls"), "just above range", /pr: expected/);
	});

	it("json_duplicate_and_proto_keys_are_own_data", () => {
		rejects(() => ev.parseJson('{"a":1,"a":2}', "x"), "dup", /duplicate JSON key: a/);
		const o = ev.parseJson('{"__proto__": 1, "b": 2}', "x");
		assert.deepEqual(Object.keys(o), ["__proto__", "b"]);
		assert.equal({}.polluted, undefined);
		rejects(() => ev.parseJson('{"__proto__":1,"__proto__":2}', "x"), "dup proto", /duplicate JSON key: __proto__/);
	});

	it("json_syntax_is_strict_like_python", () => {
		for (const text of ["", "  ", "{,}", "[1,]", "{'a':1}", "01", "+1", ".5", "1.", "[1 2]", '"a\nb"', '"\\x"', '"\\u12"', "tru", "nul", "[1] x", "\ufeff[]", "\u00a0[]", "[\u2028]"]) rejects(() => ev.parseJson(text, "x"), JSON.stringify(text), /malformed JSON/);
		for (const text of ["NaN", "Infinity", "-Infinity", "[NaN]"]) rejects(() => ev.parseJson(text, "x"), text, /non-finite or unsupported JSON constant/);
		assert.deepEqual(ev.parseJson(' \t\r\n["\\ud83d\\ude00", "\\ud800", -0, 1E2]\n', "x").slice(0, 2), ["\u{1F600}", "\ud800"]);
	});

	it("json_nesting_cap_is_explicit", () => {
		assert.equal(ev.JSON_MAX_DEPTH, 1000);
		assert.ok(Array.isArray(ev.parseJson("[".repeat(ev.JSON_MAX_DEPTH) + "]".repeat(ev.JSON_MAX_DEPTH), "x")));
		rejects(() => ev.parseJson("[".repeat(ev.JSON_MAX_DEPTH + 1) + "]".repeat(ev.JSON_MAX_DEPTH + 1), "x"), "deep", /JSON nesting too deep/);
	});

	it("blank_text_uses_python_whitespace_not_javascript_trim", () => {
		// Python str.isspace: U+001C-U+001F and U+0085 are whitespace; U+FEFF is not (JS trim() is the reverse).
		for (const blank of ["", " ", "\t\n", "\u0085", "\u001c", "\u3000", "\u2028", "\u00a0"]) assert.equal(ev.isBlank(blank), true, JSON.stringify(blank));
		for (const filled of ["\ufeff", "\u200b", "a", "\ufeff "]) assert.equal(ev.isBlank(filled), false, JSON.stringify(filled));
		rejects(() => ev.parseCalls([entry("security-specialist", { task: "\u0085\u3000" })], "calls"), "blank task", /expected non-empty string/);
		assert.equal(ev.parseCalls([entry("security-specialist", { task: "\ufeff" })], "calls").length, 1);
	});

	it("splitlines_matches_python_including_unicode_separators", () => {
		const cases = [["", []], ["a\n", ["a"]], ["a\n\n", ["a", ""]], ["\n", [""]], ["a\r\nb\rc", ["a", "b", "c"]], ["a\u2028b\u0085c\fd\ve\u001cf", ["a", "b", "c", "d", "e", "f"]], ["a\r\n\r\n", ["a", ""]]];
		for (const [text, expected] of cases) assert.deepEqual(ev.splitLines(text), expected, JSON.stringify(text));
		// A raw U+2028 inside a JSON string splits that prediction line: fail closed (exit 2), never a false PASS.
		const text = toJsonl(perfectPredictions(fx)).replace('"id":"R01"', '"id":"R0\u20281"');
		assert.ok(text.includes("\u2028"));
		rejects(() => ev.parsePredictions(text, ids), "u2028");
	});

	it("error_field_lists_sort_by_code_point_like_python", () => {
		// Python sorts by code point; the default JS sort uses UTF-16 units and would put U+1F600 before U+FF5E.
		const rec = { id: "R01", route: "T0_MAIN", roles: [], skills: [], "\uff5e": 1, "\u{1F600}": 2 };
		rejects(() => ev.parsePredictions(JSON.stringify(rec) + "\n", ids), "unknown fields", /\['\uff5e', '\u{1F600}'\]/u);
	});

	it("python_style_repr_in_messages", () => {
		assert.equal(ev.pyRepr(["a", "it's", true, null, 1, { k: "v" }]), `['a', "it's", True, None, 1, {'k': 'v'}]`);
		assert.equal(ev.pyRepr("a\nb\\c\u0001"), "'a\\nb\\\\c\\x01'");
		rejects(() => ev.parseCalls([entry("security-specialist", { modelTier: null })], "calls"), "null tier", /got None$/);
	});

	it("accuracy_formatting_rounds_half_to_even_like_python", () => {
		assert.equal(ev.format4(0.03125), "0.0312"); // exact binary tie: Python rounds half to even, toFixed rounds up
		assert.equal(ev.format4(0.09375), "0.0938");
		assert.equal(ev.format4(34 / 35), "0.9714");
		assert.equal(ev.format4(1), "1.0000");
		assert.equal(ev.format4(0.5), "0.5000");
	});

	it("import_has_no_cli_side_effects_and_main_is_injectable", () => {
		const out = [];
		const err = [];
		assert.equal(ev.main(["--cases", CASES, "--self-check"], { write: (s) => out.push(s) }, { write: (s) => err.push(s) }), 0);
		assert.ok(out.join("").includes("RESULT: PASS"));
		assert.deepEqual(err, []);
		assert.equal(ev.main([], { write() {} }, { write: (s) => err.push(s) }), 2);
		assert.match(err.join(""), /required: --cases/);
	});

	it("cli_usage_errors_exit_two_and_help_exits_zero", () => {
		for (const args of [[], ["--cases"], ["--cases", CASES, "--predictions", "x", "--self-check"], ["--cases", CASES, "--self-check", "extra"], ["--cases", CASES, "--bogus"], ["--cases", CASES, "--self-check=1"], ["--cases", CASES, "--p", "a", "--predictions", "b", "--self"]]) {
			const r = runCli(...args);
			assert.equal(r.status, 2, JSON.stringify(args));
			assert.ok(r.stderr.includes("error:"), JSON.stringify(args));
			assert.ok(!r.stdout.includes("RESULT:"), JSON.stringify(args));
		}
		const help = runCli("--help");
		assert.equal(help.status, 0);
		assert.ok(help.stdout.includes("--cases") && help.stdout.includes("--predictions") && help.stdout.includes("--self-check"));
		// argparse-style unique-prefix abbreviations and --opt=value are accepted.
		assert.equal(runCli(`--case=${CASES}`, "--self").status, 0);
		assert.equal(runCli("--cases", CASES, "--self-check").stdout, runCli(`--cases=${CASES}`, "--self-check").stdout);
	});

	it("invalid_utf8_fixture_exits_two", () => {
		const r = runCli("--cases", writeTmp("badfx.json", Buffer.from([0xff, 0xfe, 0x7b])), "--self-check");
		assert.equal(r.status, 2);
		assert.ok(r.stderr.includes("error:"));
		assert.ok(noTrace(r.stderr));
	});

	it("cli_stdout_report_is_byte_stable_for_self_check", () => {
		const a = runCli("--cases", CASES, "--self-check");
		const b = runCli("--cases", CASES, "--self-check");
		assert.equal(a.stdout, b.stdout);
		assert.ok(a.stdout.endsWith("RESULT: PASS\n"));
		assert.equal(a.stdout.split("\n").length, 10); // 8 report lines + RESULT + trailing newline
	});
});
