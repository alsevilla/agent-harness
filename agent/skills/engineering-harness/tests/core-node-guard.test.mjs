// Guard: the core harness (routing evaluator, agent creation) is Node-only. Optional Graphify/UI-UX Python utilities are not core and are not scanned.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SELF = fileURLToPath(import.meta.url);
const rel = (p) => path.relative(REPO, p).split(path.sep).join("/");

const RETIRED = [
	"agent/skills/engineering-harness/scripts/evaluate-routing.py",
	"agent/skills/engineering-harness/tests/test_evaluate_routing.py",
	"agent/skills/agent-creation/scripts/create_agent.py",
	"agent/skills/agent-creation/tests/test_create_agent.py",
];

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".git") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// Production/caller files and core docs/scripts (tests and the optional Python utilities are not core invocation sites).
function coreFiles() {
	const files = [];
	for (const dir of ["scripts", "agent/extensions", "agent/skills/engineering-harness", "agent/skills/agent-creation"]) {
		for (const f of walk(path.join(REPO, dir))) {
			// The two port suites name their legacy Python origin in a header comment.
			if (f === SELF || /(create-agent|evaluate-routing)\.test\.mjs$/.test(f) || !/\.(mjs|ts|md|json)$/.test(f)) continue;
			files.push(f);
		}
	}
	for (const f of ["README.md", "agent/skills/SKILLS.md", "package.json"]) files.push(path.join(REPO, f));
	return files.filter((f) => !rel(f).includes("/install/"));
}

test("the four retired core Python files are absent", () => {
	for (const f of RETIRED) assert.equal(fs.existsSync(path.join(REPO, f)), false, `${f} must stay deleted`);
});

test("core Node replacements exist", () => {
	for (const f of ["agent/skills/engineering-harness/scripts/evaluate-routing.mjs", "agent/skills/engineering-harness/tests/evaluate-routing.test.mjs", "agent/skills/agent-creation/scripts/create-agent.mjs", "agent/skills/agent-creation/tests/create-agent.test.mjs"]) {
		assert.ok(fs.existsSync(path.join(REPO, f)), f);
	}
});

test("no core file references the retired Python entries or the interpreter test escape", () => {
	const bad = /create_agent|test_create_agent|(?<!former )evaluate-routing\.py|test_evaluate_routing|SUBAGENT_CREATE_TEST_PYTHON|unittest discover/;
	for (const f of coreFiles()) {
		const text = fs.readFileSync(f, "utf8");
		assert.equal(bad.test(text), false, `${rel(f)} references retired core Python`);
	}
});

test("no production/caller code spawns a Python interpreter", () => {
	const spawnPython = /(spawn|exec|execFile)(Sync)?\(\s*[^)]{0,80}["'`](python3?|py)(\.exe)?["'`]/;
	const literal = /["'`](python3?|py)(\.exe)?["'`]/;
	for (const f of coreFiles()) {
		// agent/extensions/refresh runs the optional Graphify Python tool by design; it is not core.
		if (!/\.(mjs|ts)$/.test(f) || /\/tests\//.test(rel(f)) || rel(f).startsWith("agent/extensions/refresh/")) continue;
		const text = fs.readFileSync(f, "utf8");
		assert.equal(spawnPython.test(text) || literal.test(text), false, `${rel(f)} launches Python`);
	}
});

test("core docs give no active Python command for core tools", () => {
	const cmd = /^\s*(\$ )?(python3?|py)(\.exe)?\s+-?\S*(create|evaluate|unittest)/im;
	for (const f of coreFiles()) {
		if (!f.endsWith(".md")) continue;
		assert.equal(cmd.test(fs.readFileSync(f, "utf8")), false, `${rel(f)} documents a Python core command`);
	}
});
