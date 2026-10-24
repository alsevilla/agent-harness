// Node port of the legacy Python suite for the agent-creation CLI (test_create_agent.py). Every legacy test keeps its
// `Class.test_name` title so the old-case-to-new-test map is mechanical. Offline: temp fixtures only, no model, network or Pi launch.
// CLI behaviour is exercised through process.execPath on the real scripts/create-agent.mjs; the few fault-injection cases
// (partial write, mocked link entry) call main() in-process with explicit dependencies instead of monkeypatching.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "create-agent.mjs");
const EXAMPLE = path.join(ROOT, "examples", "dotnet-worker.json");
const TEST_ROOT = process.env.AGENT_CREATION_TEST_ROOT || undefined;
const mod = await import(pathToFileURL(SCRIPT).href);

const BASE_SPEC = {
	name: "dotnet-worker",
	description: "Implements scoped .NET changes with the native SDK.",
	instructions: "Work only on the assigned .NET project.",
	model: "anthropic/claude-haiku-5-5",
	thinking: "low",
	fallbackModel: "openai-codex/gpt-6-luna || github-copilot/gpt-6-luna",
};
const SKILL = { name: "dotnet-sdk-first", description: "Use the native .NET SDK first when editing .NET projects.", instructions: "Prefer built-in SDK APIs. Add no new packages." };
const PACKAGED_ROLES = [
	{ name: "reviewer", provider: "anthropic", model: "claude-haiku-5-5", fallbackModel: "", thinking: "low", tools: "read" },
	{ name: "scout", provider: "anthropic", model: "claude-haiku-5-5", fallbackModel: "", thinking: "low", tools: "read" },
];

class Case {
	constructor(t) {
		this.dir = fs.mkdtempSync(path.join(TEST_ROOT ?? os.tmpdir(), "agent-creation-test-"));
		this.home = path.join(this.dir, "home");
		this.agent = path.join(this.dir, "agent");
		this.project = path.join(this.dir, "project");
		this.links = [];
		for (const d of [this.home, path.join(this.agent, "agents"), path.join(this.agent, "skills"), path.join(this.project, ".git")]) fs.mkdirSync(d, { recursive: true });
		const roles = [{ name: "backend-worker", provider: "anthropic", model: "claude-haiku-5-5", fallbackModel: "openai-codex/gpt-6-luna || github-copilot/gpt-6-luna", thinking: "low", tools: "read, grep, find, ls, bash, powershell, edit" }];
		fs.writeFileSync(path.join(this.agent, "roles.json"), JSON.stringify(roles));
		t.after(() => {
			for (const link of this.links) {
				try { fs.rmdirSync(link); } catch { try { fs.unlinkSync(link); } catch { /* already gone */ } }
			}
			fs.rmSync(this.dir, { recursive: true, force: true });
		});
	}
	// Junctions need no privilege on Windows; elsewhere Node creates a plain directory symlink (same lstat refusal path).
	makeJunction(link, target) { fs.symlinkSync(target, link, "junction"); this.links.push(link); }
	env(extra = {}) {
		const env = { ...process.env };
		delete env.PI_CODING_AGENT_DIR;
		const tmp = path.join(this.dir, "tmp");
		fs.mkdirSync(tmp, { recursive: true });
		return { ...env, HOME: this.home, USERPROFILE: this.home, TEMP: tmp, TMP: tmp, ...extra };
	}
	spec(over = {}) { return { ...BASE_SPEC, ...over }; }
	cli(spec, extra = [], { env, project, agent = true, script = SCRIPT } = {}) {
		const specPath = path.join(this.dir, "spec.json");
		fs.writeFileSync(specPath, typeof spec === "string" ? spec : JSON.stringify(spec));
		const args = [script, "--spec", specPath, "--project-root", project ?? this.project];
		if (agent) args.push("--agent-dir", this.agent);
		args.push(...extra);
		const r = spawnSync(process.execPath, args, { encoding: "utf8", env: env ?? this.env(), timeout: 60_000 });
		assert.equal(r.error, undefined, String(r.error));
		return r;
	}
	/** In-process main() with explicit dependencies (fault injection); never touches process env. */
	inProcess(spec, extra = [], deps = {}) {
		const specPath = path.join(this.dir, "spec.json");
		fs.writeFileSync(specPath, JSON.stringify(spec));
		const out = [], err = [];
		const code = mod.main(["--spec", specPath, "--project-root", this.project, "--agent-dir", this.agent, ...extra], { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, home: this.home, ...deps });
		return { code, out: out.join(""), err: err.join("") };
	}
	agentFile(name = "dotnet-worker") { return path.join(this.project, ".pi", "agents", `${name}.md`); }
	skillFile(name = "dotnet-sdk-first") { return path.join(this.project, ".pi", "skills", name, "SKILL.md"); }
	toolsOf(text) {
		const line = text.split("\n").find((l) => l.startsWith("tools: "));
		return JSON.parse(line.slice("tools: ".length)).split(",").map((s) => s.trim());
	}
	write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(text, "utf8")); }
	noPi() { return !fs.existsSync(path.join(this.project, ".pi")); }
}
const read = (p) => fs.readFileSync(p, "utf8");
const T = (name, fn) => test(name, async (t) => fn(new Case(t), t));
const out = (r) => r.stdout + r.stderr;

// ---- PreviewAndCreation ------------------------------------------------------------------------------------------------
T("PreviewAndCreation.test_preview_is_default_and_writes_nothing", (c) => {
	const r = c.cli(c.spec({ skill: SKILL }));
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /no files written/);
	assert.ok(r.stdout.includes('name: "dotnet-worker"'));
	assert.ok(c.noPi());
});
T("PreviewAndCreation.test_apply_creates_agent_and_optional_skill", (c) => {
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	const agent = read(c.agentFile());
	assert.ok(agent.startsWith('---\nname: "dotnet-worker"\n'));
	assert.ok(agent.includes('\nmodel: "anthropic/claude-haiku-5-5"\n'));
	assert.ok(read(c.skillFile()).startsWith('---\nname: "dotnet-sdk-first"\n'));
	assert.ok(r.stdout.includes("created: "));
});
T("PreviewAndCreation.test_apply_without_skill_creates_no_skill_directory", (c) => {
	const r = c.cli(c.spec(), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(fs.existsSync(c.agentFile()));
	assert.ok(!fs.existsSync(path.join(c.project, ".pi", "skills")));
});
T("PreviewAndCreation.test_agent_body_reads_absolute_skill_path", (c) => {
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(read(c.agentFile()).includes(c.skillFile()));
});
T("PreviewAndCreation.test_generated_frontmatter_round_trips_metadata", (c) => {
	const tricky = c.spec({ description: 'Quotes "x", back\\slash, colon: hash # and unicode \u00e9', thinking: "low" });
	const r = c.cli(tricky, ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	const data = mod.parseFrontmatterSubset(read(c.agentFile()));
	assert.equal(data.name, "dotnet-worker");
	assert.equal(data.description, tricky.description);
	assert.equal(data.model, "anthropic/claude-haiku-5-5");
	assert.equal(data.thinking, "low");
	assert.equal(data.tools, "read, grep, find, ls");
});
T("PreviewAndCreation.test_skill_frontmatter_round_trips_metadata", (c) => {
	const skill = { ...SKILL, description: 'Use "SDK" first: back\\slash # not a comment' };
	const r = c.cli(c.spec({ skill }), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	const data = mod.parseFrontmatterSubset(read(c.skillFile()));
	assert.equal(data.name, skill.name);
	assert.equal(data.description, skill.description);
});
T("PreviewAndCreation.test_example_spec_needs_explicit_grants_then_previews", (c) => {
	const spec = JSON.parse(read(EXAMPLE));
	assert.equal(spec.name, "dotnet-worker");
	assert.equal(c.cli(JSON.stringify(spec)).status, 1);
	const r = c.cli(JSON.stringify(spec), ["--allow-writers", "--allow-shell"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes("powershell"));
	assert.ok(c.noPi());
});
T("PreviewAndCreation.test_maximum_length_name_is_accepted", (c) => {
	const r = c.cli(c.spec({ name: "a".repeat(64) }));
	assert.equal(r.status, 0, r.stderr);
});

// ---- StrictSpec --------------------------------------------------------------------------------------------------------
T("StrictSpec.test_unknown_key_refused", (c) => {
	const r = c.cli(c.spec({ extra: 1 }));
	assert.equal(r.status, 1);
	assert.match(r.stderr, /unknown/);
});
T("StrictSpec.test_duplicate_key_refused", (c) => {
	const r = c.cli('{"name":"dotnet-worker","name":"other","description":"d","instructions":"i","model":"m"}');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /duplicate/);
});
T("StrictSpec.test_malformed_json_refused", (c) => {
	const r = c.cli('{"name":');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /invalid JSON/);
});
T("StrictSpec.test_bom_prefixed_spec_refused", (c) => {
	assert.equal(c.cli("\ufeff" + JSON.stringify(c.spec())).status, 1);
});
T("StrictSpec.test_nonfinite_numbers_refused", (c) => {
	for (const token of ["NaN", "Infinity", "-Infinity", "1e999"]) {
		const r = c.cli('{"name":"dotnet-worker","description":"d","instructions":"i","model":"m","thinking":' + token + "}");
		assert.equal(r.status, 1, token);
		assert.match(r.stderr, /nonfinite/, token);
	}
});
T("StrictSpec.test_wrong_types_refused", (c) => {
	const cases = {
		"writer-string": { writer: "true" }, "writer-int": { writer: 1 }, "writer-null": { writer: null },
		"shell-true": { shell: true }, "shell-sh": { shell: "sh" }, "shell-cmd": { shell: "cmd" },
		"shell-upper": { shell: "BASH" }, "shell-empty": { shell: "" }, "shell-int": { shell: 0 },
		"model-int": { model: 5 }, "model-null": { model: null }, "model-list": { model: [] },
		"instructions-list": { instructions: ["a"] }, "thinking-int": { thinking: 1 },
		"fallback-list": { fallbackModel: ["a"] }, "skill-string": { skill: "x" },
		"name-int": { name: 5 }, "name-null": { name: null },
	};
	for (const [label, over] of Object.entries(cases)) assert.equal(c.cli(c.spec(over), ["--allow-writers", "--allow-shell"]).status, 1, label);
});
T("StrictSpec.test_missing_required_fields_refused", (c) => {
	for (const key of ["name", "description", "instructions", "model"]) {
		const data = c.spec();
		delete data[key];
		assert.equal(c.cli(data).status, 1, key);
	}
});
T("StrictSpec.test_invalid_names_refused_before_any_output", (c) => {
	const names = ["", " dotnet", "Dotnet", "dotnet--worker", "-dotnet", "dotnet-", "dot.net", "dot_net", "../x", "a/b", "a\\b", "con", "nul", "com1", "lpt9", "x".repeat(65), "dotnet worker"];
	for (const name of names) {
		const r = c.cli(c.spec({ name, skill: SKILL }), ["--apply"]);
		assert.equal(r.status, 1, JSON.stringify(name) + r.stdout);
		assert.ok(c.noPi(), JSON.stringify(name));
	}
});
T("StrictSpec.test_control_and_whitespace_metadata_refused", (c) => {
	const bad = ["a\nb", "a\tb", "a\x01b", "a\x85b", "a\u2028b", "a\u0000b", " lead", "trail ", ""];
	for (const field of ["description", "thinking", "model", "fallbackModel"]) {
		for (const value of bad) assert.equal(c.cli(c.spec({ [field]: value })).status, 1, `${field} ${JSON.stringify(value)}`);
	}
	assert.equal(c.cli(c.spec({ description: "x".repeat(1025) })).status, 1);
	for (const value of ["a\rb", "a\x00b"]) assert.equal(c.cli(c.spec({ instructions: value })).status, 1, JSON.stringify(value));
});
T("StrictSpec.test_skill_object_is_strict", (c) => {
	const { description: _d, ...noDescription } = SKILL;
	for (const skill of [{ ...SKILL, extra: 1 }, noDescription, { ...SKILL, name: "Bad_Name" }, { ...SKILL, instructions: "" }]) {
		assert.equal(c.cli(c.spec({ skill })).status, 1, Object.keys(skill).join());
	}
});
T("StrictSpec.test_usage_error_exits_2", (c) => {
	const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: c.env() });
	assert.equal(r.status, 2);
});

// ---- Permissions -------------------------------------------------------------------------------------------------------
T("Permissions.test_writer_requires_exact_true_and_flag", (c) => {
	const r = c.cli(c.spec({ writer: true }), ["--apply"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--allow-writers/);
	assert.ok(c.noPi());
	assert.equal(c.cli(c.spec({ writer: "true" })).status, 1);
	assert.equal(c.cli(c.spec({ writer: true }), ["--allow-writers"]).status, 0);
});
T("Permissions.test_shell_requires_literal_value_and_flag", (c) => {
	assert.equal(c.cli(c.spec({ shell: "bash" })).status, 1);
	assert.equal(c.cli(c.spec({ shell: "bash" }), ["--allow-writers"]).status, 1);
	const r = c.cli(c.spec({ shell: "bash" }), ["--allow-shell"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes("bash"));
});
T("Permissions.test_flags_alone_grant_nothing", (c) => {
	const r = c.cli(c.spec(), ["--allow-writers", "--allow-shell", "--apply"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(c.toolsOf(read(c.agentFile())), ["read", "grep", "find", "ls"]);
});
T("Permissions.test_granted_tools_are_read_only_plus_edit_and_shell_only", (c) => {
	const r = c.cli(c.spec({ writer: true, shell: "powershell" }), ["--allow-writers", "--allow-shell", "--apply"]);
	assert.equal(r.status, 0, r.stderr);
	const tools = c.toolsOf(read(c.agentFile()));
	assert.deepEqual(new Set(tools), new Set(["read", "grep", "find", "ls", "edit", "powershell"]));
	for (const forbidden of ["write", "subagent", "mcp", "serena", "bash"]) assert.ok(!tools.some((t) => t.includes(forbidden)), forbidden);
});

// ---- ModelPreservation -------------------------------------------------------------------------------------------------
T("ModelPreservation.test_model_fallback_and_thinking_preserved_verbatim", (c) => {
	const r = c.cli(c.spec({ model: "claude-sonnet-5.5", fallbackModel: "openai-codex/gpt-6-luna||github-copilot/gpt-6-luna", thinking: "high" }), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	const text = read(c.agentFile());
	assert.ok(text.includes('\nmodel: "claude-sonnet-5.5"\n'));
	assert.ok(text.includes('\nfallbackModel: "openai-codex/gpt-6-luna||github-copilot/gpt-6-luna"\n'));
	assert.ok(text.includes('\nthinking: "high"\n'));
});
T("ModelPreservation.test_absent_optional_fields_are_omitted", (c) => {
	const { thinking: _t, fallbackModel: _f, ...spec } = BASE_SPEC;
	const r = c.cli(spec, ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	const text = read(c.agentFile());
	assert.ok(!text.includes("thinking:"));
	assert.ok(!text.includes("fallbackModel:"));
});
T("ModelPreservation.test_roles_registry_is_not_modified", (c) => {
	const before = fs.readFileSync(path.join(c.agent, "roles.json"));
	assert.equal(c.cli(c.spec(), ["--apply"]).status, 0);
	assert.deepEqual(fs.readFileSync(path.join(c.agent, "roles.json")), before);
});

// ---- Overwrite ---------------------------------------------------------------------------------------------------------
T("Overwrite.test_repeat_identical_is_unchanged", (c) => {
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 0);
	const first = [fs.readFileSync(c.agentFile()), fs.readFileSync(c.skillFile())];
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes("unchanged: "));
	assert.deepEqual([fs.readFileSync(c.agentFile()), fs.readFileSync(c.skillFile())], first);
});
T("Overwrite.test_differing_existing_agent_refused_not_overwritten", (c) => {
	fs.mkdirSync(path.dirname(c.agentFile()), { recursive: true });
	fs.writeFileSync(c.agentFile(), "different\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.equal(read(c.agentFile()), "different\n");
	assert.ok(!fs.existsSync(c.skillFile()));
});
T("Overwrite.test_collision_on_skill_blocks_agent_creation", (c) => {
	fs.mkdirSync(path.dirname(c.skillFile()), { recursive: true });
	fs.writeFileSync(c.skillFile(), "other\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.ok(!fs.existsSync(c.agentFile()));
	assert.equal(read(c.skillFile()), "other\n");
});
T("Overwrite.test_adding_skill_to_existing_agent_changes_bytes_and_is_refused", (c) => {
	assert.equal(c.cli(c.spec(), ["--apply"]).status, 0);
	const before = fs.readFileSync(c.agentFile());
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /will not be overwritten/);
	assert.deepEqual(fs.readFileSync(c.agentFile()), before);
	assert.ok(!fs.existsSync(c.skillFile()));
});

// ---- Collisions --------------------------------------------------------------------------------------------------------
const refusedNoOutput = (c, r) => { assert.equal(r.status, 1, out(r)); assert.ok(c.noPi()); };
T("Collisions.test_global_role_name_refused_case_insensitively", (c) => refusedNoOutput(c, c.cli(c.spec({ name: "backend-worker" }), ["--apply"])));
T("Collisions.test_global_agent_stem_refused", (c) => {
	c.write(path.join(c.agent, "agents", "dotnet-worker.md"), "---\nname: other\ndescription: d\n---\nbody\n");
	refusedNoOutput(c, c.cli(c.spec(), ["--apply"]));
});
T("Collisions.test_global_frontmatter_name_refused_when_stem_differs", (c) => {
	c.write(path.join(c.agent, "agents", "elsewhere.md"), "---\nname: dotnet-worker\ndescription: d\n---\nbody\n");
	refusedNoOutput(c, c.cli(c.spec(), ["--apply"]));
});
T("Collisions.test_project_agent_collision_refused", (c) => {
	c.write(path.join(c.project, ".pi", "agents", "other.md"), "---\nname: dotnet-worker\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.ok(!fs.existsSync(c.skillFile()));
});
T("Collisions.test_supported_name_spellings_are_detected", (c) => {
	const spellings = ['name: "dotnet\\u002dworker"', "name: 'dotnet-worker'", "name: dotnet-worker", 'name: "DOTNET-worker"'];
	spellings.forEach((line, i) => {
		const p = path.join(c.agent, "agents", `spelling${i}.md`);
		c.write(p, "---\n" + line + "\ndescription: d\n---\nb\n");
		assert.equal(c.cli(c.spec(), ["--apply"]).status, 1, line);
		fs.unlinkSync(p);
	});
});
T("Collisions.test_unsupported_frontmatter_refused_before_writes", (c) => {
	const cases = {
		"hex-escape": 'name: "dotnet\\x2dworker"', anchor: "name: &a dotnet-worker", alias: "name: *a",
		"duplicate-name": "name: a\nname: dotnet-worker", "quoted-key": '"name": dotnet-worker', "block-scalar": "name: |\n  dotnet-worker",
		"colon-plain": "name: a: b", "numeric-plain": "name: 123", tag: "name: !!str dotnet-worker", "flow-sequence": "name: [dotnet-worker]",
	};
	for (const [label, line] of Object.entries(cases)) {
		const p = path.join(c.agent, "agents", "odd.md");
		c.write(p, "---\n" + line + "\ndescription: d\n---\nb\n");
		const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
		assert.equal(r.status, 1, label + out(r));
		assert.ok(c.noPi(), label);
		fs.unlinkSync(p);
	}
});
T("Collisions.test_ancestor_project_agents_shadow_warning_and_collision", (c) => {
	const outer = path.join(c.dir, "outer"), inner = path.join(outer, "inner");
	fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
	c.write(path.join(outer, ".pi", "agents", "ancestor.md"), "---\nname: ancestor-agent\ndescription: d\n---\nb\n");
	const r = c.cli(c.spec(), [], { project: inner });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes("shadow"));
	c.write(path.join(outer, ".pi", "agents", "ancestor.md"), "---\nname: dotnet-worker\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec(), [], { project: inner }).status, 1);
});
T("Collisions.test_skill_name_from_skill_md_not_only_dirname", (c) => {
	c.write(path.join(c.agent, "skills", "unrelated-dir", "SKILL.md"), "---\nname: dotnet-sdk-first\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.ok(!fs.existsSync(c.agentFile()));
});
T("Collisions.test_skill_dirname_reserved_when_frontmatter_name_differs", (c) => {
	c.write(path.join(c.agent, "skills", "dotnet-sdk-first", "SKILL.md"), "---\nname: other-name\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.equal(c.cli(c.spec({ skill: { ...SKILL, name: "other-name" } }), ["--apply"]).status, 1);
});
T("Collisions.test_project_agents_skills_root_collision_refused", (c) => {
	c.write(path.join(c.project, ".agents", "skills", "dotnet-sdk-first", "SKILL.md"), "---\nname: dotnet-sdk-first\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.ok(!fs.existsSync(c.agentFile()));
});
T("Collisions.test_unsupported_skill_frontmatter_refused", (c) => {
	c.write(path.join(c.agent, "skills", "odd", "SKILL.md"), "---\nname: |\n  x\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
});

// ---- PathRefusals ------------------------------------------------------------------------------------------------------
T("PathRefusals.test_dot_dot_root_segment_refused", (c) => {
	const r = c.cli(c.spec(), [], { project: c.project + path.sep + ".." + path.sep + "project" });
	assert.equal(r.status, 1, r.stderr);
	assert.ok(r.stderr.includes(".."));
	assert.ok(c.noPi());
});
T("PathRefusals.test_project_root_inside_global_agent_dir_refused", (c) => {
	const inner = path.join(c.agent, "projects", "p");
	fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
	const r = c.cli(c.spec(), [], { project: inner });
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /global agent directory/);
	assert.ok(!fs.existsSync(path.join(inner, ".pi")));
});
T("PathRefusals.test_agent_dir_precedence_flag_over_environment", (c) => {
	const env = c.env({ PI_CODING_AGENT_DIR: path.join(c.project, ".pi") });
	assert.equal(c.cli(c.spec(), [], { agent: false, env }).status, 1);
	const r = c.cli(c.spec(), [], { env });
	assert.equal(r.status, 0, r.stderr);
});
T("PathRefusals.test_relative_or_missing_project_root_refused", (c) => {
	const r = c.cli(c.spec(), [], { project: "relative-project" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /absolute/);
	assert.equal(c.cli(c.spec(), [], { project: path.join(c.dir, "missing") }).status, 1);
});
T("PathRefusals.test_junction_root_and_ancestor_refused", (c) => {
	const link = path.join(c.dir, "jroot");
	c.makeJunction(link, c.project);
	assert.equal(c.cli(c.spec(), [], { project: link }).status, 1);
	fs.mkdirSync(path.join(c.project, "child"));
	assert.equal(c.cli(c.spec(), [], { project: path.join(link, "child") }).status, 1);
	assert.ok(c.noPi());
});
T("PathRefusals.test_junction_pi_dir_refused_and_target_untouched", (c) => {
	const target = path.join(c.dir, "elsewhere");
	fs.mkdirSync(target);
	c.makeJunction(path.join(c.project, ".pi"), target);
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 1, r.stderr);
	assert.deepEqual(fs.readdirSync(target), []);
});
T("PathRefusals.test_junction_agents_dir_refused_and_target_untouched", (c) => {
	const target = path.join(c.dir, "elsewhere");
	fs.mkdirSync(target);
	fs.mkdirSync(path.join(c.project, ".pi"));
	c.makeJunction(path.join(c.project, ".pi", "agents"), target);
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 1, r.stderr);
	assert.deepEqual(fs.readdirSync(target), []);
	assert.ok(!fs.existsSync(c.skillFile()));
});
T("PathRefusals.test_junction_skills_dir_blocks_all_outputs", (c) => {
	const target = path.join(c.dir, "elsewhere");
	fs.mkdirSync(target);
	fs.mkdirSync(path.join(c.project, ".pi", "agents"), { recursive: true });
	c.makeJunction(path.join(c.project, ".pi", "skills"), target);
	const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(r.status, 1, r.stderr);
	assert.ok(!fs.existsSync(c.agentFile()));
	assert.deepEqual(fs.readdirSync(target), []);
});
T("PathRefusals.test_symlink_pi_dir_refused_when_privilege_available", (c, t) => {
	const target = path.join(c.dir, "elsewhere");
	fs.mkdirSync(target);
	const link = path.join(c.project, ".pi");
	try { fs.symlinkSync(target, link, "dir"); } catch (e) { return t.skip(`NOT RUN: symlink privilege unavailable (${e.code})`); }
	c.links.push(link);
	assert.equal(c.cli(c.spec(), ["--apply"]).status, 1);
	assert.deepEqual(fs.readdirSync(target), []);
});

// ---- PartialFailure / WriteFailure (in-process: injected fs operations around the real writer) -------------------------------
T("PartialFailure.test_late_io_failure_reports_created_without_deletes", (c) => {
	let opens = 0;
	const faulty = { ...fs, openSync: (p, flag, ...rest) => { if (flag === "wx" && ++opens === 2) throw Object.assign(new Error("injected late write failure"), { code: "EIO" }); return fs.openSync(p, flag, ...rest); } };
	const r = c.inProcess(c.spec({ skill: SKILL }), ["--apply"], { fs: faulty });
	assert.equal(r.code, 3, r.err);
	assert.equal(opens, 2);
	assert.ok(fs.existsSync(c.agentFile()));
	assert.ok(!fs.existsSync(c.skillFile()));
	assert.ok(r.out.includes("created: " + c.agentFile()));
	assert.ok(r.out.includes("uncreated: " + c.skillFile()));
});

function lateFailure(c, when, target) {
	const wanted = path.normalize(target);
	const owned = new Set();
	const faulty = {
		...fs,
		openSync: (p, flag, ...rest) => { const fd = fs.openSync(p, flag, ...rest); if (flag === "wx" && path.normalize(p) === wanted) owned.add(fd); return fd; },
		writeSync: (fd, data, off, len) => {
			if (when === "write" && owned.has(fd)) { fs.writeSync(fd, data, 0, 10); throw Object.assign(new Error("No space left on device (MOCK)"), { code: "ENOSPC" }); }
			return fs.writeSync(fd, data, off, len);
		},
		closeSync: (fd) => { fs.closeSync(fd); if (when === "close" && owned.has(fd)) throw Object.assign(new Error("close failed (MOCK)"), { code: "EIO" }); },
	};
	return c.inProcess(c.spec({ skill: SKILL }), ["--apply"], { fs: faulty });
}
T("WriteFailure.test_late_write_failure_reports_partial_not_uncreated", (c) => {
	const r = lateFailure(c, "write", c.skillFile());
	assert.equal(r.code, 3, r.err);
	assert.ok(r.out.includes("created: " + c.agentFile()));
	assert.ok(r.out.includes("partial: " + c.skillFile()));
	assert.ok(!r.out.includes("uncreated: " + c.skillFile()));
	assert.equal(fs.readFileSync(c.skillFile()).length, 10);
	assert.ok(r.err.includes("partial file left"));
	const retry = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
	assert.equal(retry.status, 1, out(retry));
	assert.equal(fs.readFileSync(c.skillFile()).length, 10);
});
T("WriteFailure.test_late_close_failure_reports_partial_not_uncreated", (c) => {
	const r = lateFailure(c, "close", c.skillFile());
	assert.equal(r.code, 3, r.err);
	assert.ok(r.out.includes("partial: " + c.skillFile()));
	assert.ok(!r.out.includes("uncreated: " + c.skillFile()));
	assert.ok(fs.existsSync(c.skillFile()));
});
T("WriteFailure.test_first_output_partial_leaves_second_uncreated", (c) => {
	const r = lateFailure(c, "write", c.agentFile());
	assert.equal(r.code, 3, r.err);
	assert.ok(r.out.includes("partial: " + c.agentFile()));
	assert.ok(r.out.includes("uncreated: " + c.skillFile()));
	assert.ok(!r.out.includes("created: " + c.agentFile()));
	assert.ok(!fs.existsSync(c.skillFile()));
});

// ---- MultiSpaceMetadata ------------------------------------------------------------------------------------------------
T("MultiSpaceMetadata.test_parser_strips_value_spaces_before_scalar_rules", () => {
	const parse = mod.parseFrontmatterSubset;
	assert.equal(parse("---\nname: newbie\n---\n").name, "newbie");
	assert.equal(parse("---\nname:  newbie  \n---\n").name, "newbie");
	assert.equal(parse('---\nname:   "dotnet-worker"\n---\n').name, "dotnet-worker");
	assert.equal(parse("---\nname:  'dotnet-worker'\n---\n").name, "dotnet-worker");
	assert.equal(parse('---\nname:  "a  b"\n---\n').name, "a  b");
	for (const line of ["name:  123", "name:     true", "name:  ~", "name:  !!str x", "name:  [a]", "name:  &a x"]) {
		assert.throws(() => parse("---\n" + line + "\n---\n"), mod.Unsupported, line);
	}
});
T("MultiSpaceMetadata.test_multi_space_name_collides_in_every_scanned_location", (c) => {
	const cases = {
		"global agent, stem differs": [path.join(c.agent, "agents", "elsewhere.md"), "name:  dotnet-worker"],
		"global agent, five spaces quoted": [path.join(c.agent, "agents", "quoted.md"), 'name:     "dotnet-worker"'],
		"project agent, five spaces": [path.join(c.project, ".pi", "agents", "other.md"), "name:     dotnet-worker"],
		"global skill SKILL.md": [path.join(c.agent, "skills", "unrelated-dir", "SKILL.md"), "name:  dotnet-sdk-first"],
		"project skill SKILL.md": [path.join(c.project, ".agents", "skills", "elsewhere", "SKILL.md"), "name:  dotnet-sdk-first"],
	};
	for (const [label, [p, line]] of Object.entries(cases)) {
		c.write(p, "---\n" + line + "\ndescription: d\n---\nb\n");
		const r = c.cli(c.spec({ skill: SKILL }), ["--apply"]);
		assert.equal(r.status, 1, label + out(r));
		assert.ok(!fs.existsSync(c.agentFile()), label);
		fs.unlinkSync(p);
	}
});
T("MultiSpaceMetadata.test_single_space_control_still_applies", (c) => {
	c.write(path.join(c.agent, "agents", "control.md"), "---\nname: unrelated-agent\ndescription: d\n---\nb\n");
	const r = c.cli(c.spec(), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(fs.existsSync(c.agentFile()));
});
T("MultiSpaceMetadata.test_multi_space_typed_scalar_refused", (c) => {
	c.write(path.join(c.agent, "agents", "typed.md"), "---\nname:     true\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec(), ["--apply"]).status, 1);
	assert.ok(c.noPi());
});

// ---- ShortPathAlias ----------------------------------------------------------------------------------------------------
T("ShortPathAlias.test_short_path_root_inside_global_agent_dir_refused", (c, t) => {
	if (process.platform !== "win32") return t.skip("8.3 short names are Windows-only");
	const inner = path.join(c.agent, "Projects With Long Name", "repo");
	fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
	let short;
	try { short = execFileSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${inner}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).trim(); } catch { short = ""; }
	if (!short || short.toLowerCase() === inner.toLowerCase()) return t.skip("NOT RUN: 8.3 short names unavailable on this volume");
	const r = c.cli(c.spec(), ["--apply"], { project: short });
	assert.equal(r.status, 1, out(r));
	assert.match(r.stderr, /global agent directory/);
	assert.ok(!fs.existsSync(path.join(inner, ".pi")));
});

// ---- ParserLimits ------------------------------------------------------------------------------------------------------
T("ParserLimits.test_deep_nesting_refused_without_traceback", (c) => {
	const r = c.cli('{"name": "x", "deep": ' + "[".repeat(5000) + "]".repeat(5000) + "}");
	assert.equal(r.status, 1, r.stderr);
	assert.doesNotMatch(r.stderr, /Traceback|\n\s+at /);
	assert.match(r.stderr, /exceeds parser limits/);
});
T("ParserLimits.test_oversized_integer_refused_without_traceback", (c) => {
	const r = c.cli('{"name": "x", "n": ' + "9".repeat(5000) + "}");
	assert.equal(r.status, 1, r.stderr);
	assert.doesNotMatch(r.stderr, /Traceback|\n\s+at /);
	assert.match(r.stderr, /exceeds parser limits/);
});

// ---- PermissionDisplay -------------------------------------------------------------------------------------------------
T("PermissionDisplay.test_preview_states_write_tool_and_source_edit_status", (c) => {
	const r = c.cli(c.spec());
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes("write-tool=disabled"));
	assert.ok(r.stdout.includes("source-edit=readonly"));
	assert.ok(!r.stdout.includes("write=never"));
	assert.ok(c.cli(c.spec({ writer: true }), ["--allow-writers"]).stdout.includes("source-edit=approved"));
});
T("PermissionDisplay.test_shell_power_is_explicit_in_preview", (c) => {
	assert.ok(c.cli(c.spec({ shell: "bash" }), ["--allow-shell"]).stdout.includes("shell=bash (explicit grant; not a sandbox)"));
	assert.ok(c.cli(c.spec()).stdout.includes("shell=false"));
});

// ---- NativeLinkAndNameFallbacks ----------------------------------------------------------------------------------------
function junctionEntry(c, root, entry, declared) {
	const target = path.join(c.dir, "target");
	c.write(path.join(target, "SKILL.md"), "---\n" + (declared ? `name: ${declared}\n` : "") + "description: d\n---\nb\n");
	fs.mkdirSync(root, { recursive: true });
	c.makeJunction(path.join(root, entry), target);
	return target;
}
function assertLinkedRefused(c, skillName, target) {
	const r = c.cli(c.spec({ skill: { ...SKILL, name: skillName } }), ["--apply"]);
	assert.equal(r.status, 1, out(r));
	assert.match(r.stderr, /linked skill entry refused/);
	assert.ok(!fs.existsSync(c.agentFile()));
	assert.ok(!fs.existsSync(c.skillFile(skillName)));
	assert.deepEqual(fs.readdirSync(target), ["SKILL.md"]);
}
T("NativeLinkAndNameFallbacks.test_junction_entry_refused_in_global_agent_skills", (c) => assertLinkedRefused(c, "linked-x", junctionEntry(c, path.join(c.agent, "skills"), "lnk", "linked-x")));
T("NativeLinkAndNameFallbacks.test_junction_entry_refused_in_project_pi_skills", (c) => assertLinkedRefused(c, "linked-x", junctionEntry(c, path.join(c.project, ".pi", "skills"), "lnk", "linked-x")));
T("NativeLinkAndNameFallbacks.test_junction_entry_refused_in_project_agents_skills", (c) => assertLinkedRefused(c, "linked-x", junctionEntry(c, path.join(c.project, ".agents", "skills"), "lnk", "linked-x")));
T("NativeLinkAndNameFallbacks.test_junction_entry_refused_in_home_agents_skills", (c) => assertLinkedRefused(c, "linked-x", junctionEntry(c, path.join(c.home, ".agents", "skills"), "lnk", "linked-x")));
T("NativeLinkAndNameFallbacks.test_nameless_skill_inside_junction_refused", (c) => assertLinkedRefused(c, "lnk-nameless", junctionEntry(c, path.join(c.agent, "skills"), "lnk-nameless", null)));
T("NativeLinkAndNameFallbacks.test_linked_file_entry_refused_by_stat_mock_not_physical_link", (c) => {
	c.write(path.join(c.agent, "skills", "fl", "SKILL.md"), "---\nname: fl-x\ndescription: d\n---\nb\n");
	const real = mod.isLink;
	assert.equal(typeof real, "function");
	const r = c.inProcess(c.spec({ skill: { ...SKILL, name: "fl-x" } }), ["--apply"], { isLink: (p) => path.basename(p) === "SKILL.md" || real(p) });
	assert.equal(r.code, 1);
	assert.match(r.err, /linked skill entry refused/);
	assert.ok(!fs.existsSync(c.agentFile()));
});
T("NativeLinkAndNameFallbacks.test_dot_and_node_modules_junction_entries_stay_ignored", (c) => {
	const root = path.join(c.agent, "skills");
	junctionEntry(c, root, ".lnk", "linked-x");
	c.makeJunction(path.join(root, "node_modules"), path.join(c.dir, "target"));
	const r = c.cli(c.spec({ skill: { ...SKILL, name: "linked-x" } }));
	assert.equal(r.status, 0, out(r));
});
T("NativeLinkAndNameFallbacks.test_nameless_root_md_reserves_parent_skills_name", (c) => {
	for (const root of [path.join(c.agent, "skills"), path.join(c.project, ".pi", "skills")]) {
		c.write(path.join(root, "legacy.md"), "---\ndescription: legacy desc\n---\nbody\n");
		const r = c.cli(c.spec({ skill: { ...SKILL, name: "skills" } }), ["--apply"]);
		assert.equal(r.status, 1, root + out(r));
		assert.ok(!fs.existsSync(c.agentFile()));
		fs.unlinkSync(path.join(root, "legacy.md"));
	}
});
T("NativeLinkAndNameFallbacks.test_nameless_nested_agents_md_reserves_parent_directory_name", (c) => {
	for (const root of [path.join(c.project, ".agents", "skills"), path.join(c.home, ".agents", "skills")]) {
		c.write(path.join(root, "sub", "leaf.md"), "---\ndescription: d\n---\nbody\n");
		const r = c.cli(c.spec({ skill: { ...SKILL, name: "sub" } }), ["--apply"]);
		assert.equal(r.status, 1, root + out(r));
		assert.ok(!fs.existsSync(c.agentFile()));
		fs.rmSync(path.join(root, "sub"), { recursive: true });
	}
});
T("NativeLinkAndNameFallbacks.test_explicit_name_nested_agents_md_reserves_declared_name_only", (c) => {
	c.write(path.join(c.project, ".agents", "skills", "sub", "leaf.md"), "---\nname: explicit-leaf\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: { ...SKILL, name: "explicit-leaf" } }), ["--apply"]).status, 1);
	assert.equal(c.cli(c.spec({ skill: { ...SKILL, name: "sub" } })).status, 0);
});
T("NativeLinkAndNameFallbacks.test_nested_md_in_pi_skill_roots_is_not_native_loaded_control", (c) => {
	c.write(path.join(c.project, ".pi", "skills", "sub", "leaf.md"), "---\ndescription: d\n---\nb\n");
	c.write(path.join(c.agent, "skills", "sub2", "leaf.md"), "---\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: { ...SKILL, name: "sub" } })).status, 0);
	assert.equal(c.cli(c.spec({ skill: { ...SKILL, name: "sub2" } })).status, 0);
});
T("NativeLinkAndNameFallbacks.test_unsupported_nested_agents_md_frontmatter_refused", (c) => {
	c.write(path.join(c.project, ".agents", "skills", "odd", "notes.md"), "---\nname: |\n  x\n---\nb\n");
	assert.equal(c.cli(c.spec({ skill: SKILL }), ["--apply"]).status, 1);
	assert.ok(!fs.existsSync(c.agentFile()));
});

// ---- PackageDefaults ---------------------------------------------------------------------------------------------------
class PkgCase extends Case {
	constructor(t) {
		super(t);
		this.pkg = path.join(this.dir, "pkg");
		const scripts = path.join(this.pkg, "agent", "skills", "agent-creation", "scripts");
		fs.mkdirSync(scripts, { recursive: true });
		fs.mkdirSync(path.join(this.pkg, "agent", "agents"), { recursive: true });
		this.pkgScript = path.join(scripts, "create-agent.mjs");
		fs.copyFileSync(SCRIPT, this.pkgScript);
		fs.writeFileSync(path.join(this.pkg, "package.json"), JSON.stringify({ name: "@alsevilla/pi-engineering-harness", version: "0.1.0" }));
		fs.writeFileSync(path.join(this.pkg, "agent", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: r\ntools: read\n---\nbody\n");
		fs.writeFileSync(path.join(this.pkg, "agent", "agents", "scout.md"), "---\nname: scout\ndescription: s\ntools: read\n---\nbody\n");
		this.roles(PACKAGED_ROLES);
		fs.unlinkSync(path.join(this.agent, "roles.json")); // fresh profile: no user registry at all
	}
	roles(data) { fs.writeFileSync(path.join(this.pkg, "agent", "roles.json"), JSON.stringify(data)); }
	pkgCli(spec, extra = [], script) { return this.cli(spec, extra, { script: script ?? this.pkgScript }); }
	refusedNoOutput(r, text) {
		assert.equal(r.status, 1, out(r));
		assert.ok(r.stderr.includes(text), r.stderr);
		assert.ok(!r.stderr.includes(this.pkg));
		assert.ok(!fs.existsSync(this.agentFile()));
		assert.ok(this.noPi());
	}
}
const P = (name, fn) => test(name, async (t) => fn(new PkgCase(t)));
const AGREE = "package roles.json and agents disagree", MUST = "package roles.json must list";
P("PackageDefaults.test_packaged_agent_file_name_refused_on_fresh_profile_with_no_output", (c) => {
	const r = c.pkgCli(c.spec({ name: "reviewer" }), ["--apply"]);
	assert.equal(r.status, 1, out(r));
	assert.match(r.stderr, /package roles/);
	assert.ok(!r.stderr.includes(c.pkg));
	assert.ok(c.noPi());
});
P("PackageDefaults.test_packaged_roles_json_name_refused_in_preview_too", (c) => {
	const r = c.pkgCli(c.spec({ name: "scout" }));
	assert.equal(r.status, 1, out(r));
	assert.ok(c.noPi());
});
P("PackageDefaults.test_non_colliding_name_still_creates_in_package_mode", (c) => {
	assert.equal(c.pkgCli(c.spec(), ["--apply"]).status, 0);
	assert.ok(fs.existsSync(c.agentFile()));
});
P("PackageDefaults.test_live_layout_without_package_root_keeps_preview_behaviour", (c) => {
	const live = path.join(c.dir, "live", "skills", "agent-creation", "scripts");
	fs.mkdirSync(live, { recursive: true });
	fs.copyFileSync(SCRIPT, path.join(live, "create-agent.mjs"));
	assert.equal(c.pkgCli(c.spec({ name: "reviewer" }), [], path.join(live, "create-agent.mjs")).status, 0);
});
P("PackageDefaults.test_package_name_mismatch_is_not_treated_as_the_package", (c) => {
	fs.writeFileSync(path.join(c.pkg, "package.json"), JSON.stringify({ name: "other-package" }));
	assert.equal(c.pkgCli(c.spec({ name: "reviewer" })).status, 0);
});
P("PackageDefaults.test_unreadable_package_manifest_refuses_instead_of_skipping_roles", (c) => {
	fs.writeFileSync(path.join(c.pkg, "package.json"), "{not json");
	const r = c.pkgCli(c.spec({ name: "reviewer" }));
	assert.equal(r.status, 1, out(r));
	assert.match(r.stderr, /package manifest/);
});
P("PackageDefaults.test_missing_packaged_roles_json_refuses_with_no_output", (c) => {
	fs.unlinkSync(path.join(c.pkg, "agent", "roles.json"));
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), "package roles missing");
});
P("PackageDefaults.test_missing_packaged_agents_dir_refuses_with_no_output", (c) => {
	fs.rmSync(path.join(c.pkg, "agent", "agents"), { recursive: true });
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), "package roles missing");
});
P("PackageDefaults.test_missing_root_manifest_is_the_legacy_live_layout_and_stays_silent", (c) => {
	fs.unlinkSync(path.join(c.pkg, "package.json"));
	assert.equal(c.pkgCli(c.spec({ name: "reviewer" }), ["--apply"]).status, 0);
});
P("PackageDefaults.test_renamed_root_manifest_stays_inert_and_creates", (c) => {
	fs.writeFileSync(path.join(c.pkg, "package.json"), JSON.stringify({ name: "x-renamed-harness" }));
	assert.equal(c.pkgCli(c.spec({ name: "reviewer" })).status, 0);
});
P("PackageDefaults.test_packaged_role_without_definition_refuses_with_no_output", (c) => {
	c.roles([...PACKAGED_ROLES, { name: "ghost", provider: "anthropic", model: "claude-haiku-5-5", fallbackModel: "", thinking: "low", tools: "read" }]);
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), AGREE);
});
P("PackageDefaults.test_packaged_definition_without_role_refuses_with_no_output", (c) => {
	fs.unlinkSync(path.join(c.pkg, "agent", "agents", "scout.md"));
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), AGREE);
});
P("PackageDefaults.test_garbled_packaged_definition_refuses_with_no_output", (c) => {
	fs.writeFileSync(path.join(c.pkg, "agent", "agents", "scout.md"), "no frontmatter here\n");
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), AGREE);
});
P("PackageDefaults.test_emptied_packaged_agents_refuse_with_no_output", (c) => {
	for (const f of fs.readdirSync(path.join(c.pkg, "agent", "agents"))) fs.unlinkSync(path.join(c.pkg, "agent", "agents", f));
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), AGREE);
});
P("PackageDefaults.test_empty_packaged_roles_list_refuses_with_no_output", (c) => {
	c.roles([]);
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), MUST);
});
P("PackageDefaults.test_garbled_packaged_role_entry_refuses_with_no_output", (c) => {
	c.roles([{ Name: "scout" }, PACKAGED_ROLES[0]]);
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), MUST);
});
P("PackageDefaults.test_duplicate_packaged_role_name_refuses_with_no_output", (c) => {
	c.roles([...PACKAGED_ROLES, PACKAGED_ROLES[0]]);
	c.refusedNoOutput(c.pkgCli(c.spec(), ["--apply"]), MUST);
});

// ---- Deliberate language-runtime differences (new in the Node port; each pinned explicitly) -----------------------------------
const run = (c, args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: c.env() });
T("NodePort.test_argument_abbreviations_are_refused_with_usage_exit_2", (c) => {
	const specPath = path.join(c.dir, "spec.json");
	fs.writeFileSync(specPath, JSON.stringify(c.spec()));
	// argparse accepted unambiguous prefixes (--appl); an abbreviated --apply must never grant approval, so it is a usage error.
	const r = run(c, ["--spec", specPath, "--project-root", c.project, "--agent-dir", c.agent, "--appl"]);
	assert.equal(r.status, 2, out(r));
	assert.ok(c.noPi());
	for (const args of [["--spec"], ["--spec", specPath], ["--spec", specPath, "--project-root", c.project, "extra"], ["--bogus"]]) {
		assert.equal(run(c, args).status, 2, args.join(" "));
	}
});
T("NodePort.test_help_exits_0_without_reading_a_spec", (c) => {
	const r = run(c, ["--help"]);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /--apply/);
});
T("NodePort.test_unicode_whitespace_and_category_rules_match_python_str_semantics", (c) => {
	// Python str.strip() treats U+00A0 as whitespace and U+FEFF as not whitespace; the port keeps that exact set.
	assert.equal(c.cli(c.spec({ description: "ok\u00a0" })).status, 1);
	assert.equal(c.cli(c.spec({ description: "ok\ufeff" })).status, 1); // Cf refused
	const r = c.cli(c.spec({ instructions: "body\ufeff" }), ["--apply"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(read(c.agentFile()).includes("body\ufeff\n"), "trailing U+FEFF is kept (not Python whitespace)");
	// U+2028 inside a plain scalar is ordinary text (Python '.' matches it), so this file's name does not collide.
	c.write(path.join(c.agent, "agents", "ls.md"), "---\nname: unrelated\u2028x\ndescription: d\n---\nb\n");
	assert.equal(c.cli(c.spec({ name: "other-worker" })).status, 0);
});
T("NodePort.test_spec_decode_keeps_bom_and_rejects_invalid_utf8_and_oversize", (c) => {
	const specPath = path.join(c.dir, "spec.json");
	const base = ["--spec", specPath, "--project-root", c.project, "--agent-dir", c.agent];
	fs.writeFileSync(specPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(c.spec()))]));
	const bad = run(c, base);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /not valid UTF-8/);
	fs.writeFileSync(specPath, Buffer.alloc(256 * 1024 + 1, 0x20));
	const big = run(c, base);
	assert.equal(big.status, 1);
	assert.match(big.stderr, /size limit/);
	assert.equal(c.cli('{"__proto__":{"name":"x"},"name":"dotnet-worker","description":"d","instructions":"i","model":"m"}').status, 1);
	assert.equal(run(c, ["--spec", path.join(c.dir, "missing.json"), "--project-root", c.project]).status, 1);
});

// ---- Windows reparse attestation (new: restores the legacy Python "any reparse point" refusal via fsutil) -------------------
const refusesWith = (r, re) => { assert.equal(r.code, 1, r.err); assert.match(r.err, re); };
T("ReparseAttestation.test_injected_nonlink_reparse_root_ancestor_chain_and_scan_entry_refused_with_no_writes", (c) => {
	const entry = path.join(c.project, ".pi", "skills", "placeholder-entry", "SKILL.md");
	c.write(entry, "---\nname: placeholder-entry\ndescription: d\n---\nbody\n");
	const cases = [[c.project, /reparse point refused/], [c.dir, /ancestor is not a plain directory|reparse point refused/], [path.join(c.project, ".pi", "skills"), /reparse point refused/], [path.dirname(entry), /linked skill entry refused|reparse point refused/]];
	for (const [target, re] of cases) {
		const r = c.inProcess(c.spec({ skill: SKILL }), [], { attest: (p) => p === target });
		refusesWith(r, re);
		assert.equal(r.out, "");
		assert.ok(!fs.existsSync(c.agentFile()), `no agent written for ${target}`);
	}
	// A scanned entry that lstat calls plain but the OS calls a reparse point is refused by the collision scan.
	refusesWith(c.inProcess(c.spec({ skill: SKILL }), [], { attest: (p) => p === entry }), /linked skill entry refused/);
});
T("ReparseAttestation.test_failed_query_refuses_in_preview_and_apply_with_no_writes", (c) => {
	for (const extra of [[], ["--apply"]]) {
		const r = c.inProcess(c.spec(), extra, { attest: () => { throw new mod.Refusal("cannot attest reparse state (fsutil exit 5): x"); } });
		refusesWith(r, /cannot attest reparse state/);
		assert.equal(r.out, "");
	}
	assert.ok(c.noPi());
});
T("ReparseAttestation.test_directory_that_becomes_reparse_after_mkdir_is_caught_by_the_recheck", (c) => {
	const pi = path.join(c.project, ".pi");
	const r = c.inProcess(c.spec(), ["--apply"], { attest: (p) => p === pi }); // .pi is missing in preview (no query), present after mkdir
	assert.equal(r.code, 3, r.err);
	assert.ok(!fs.existsSync(c.agentFile()), "no file written through the suspect directory");
});
T("ReparseAttestation.test_proof_is_never_reused_across_phases", (c) => {
	const agentsDir = path.join(c.project, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const seen = new Map();
	const r = c.inProcess(c.spec(), ["--apply"], { attest: (p) => { seen.set(p, (seen.get(p) ?? 0) + 1); return false; } });
	assert.equal(r.code, 0, r.err);
	assert.ok(seen.get(agentsDir) >= 2, `existing directory attested again per phase (saw ${seen.get(agentsDir)})`);
	assert.ok(fs.existsSync(c.agentFile()));
});

const fake = (result) => { const calls = []; const spawn = (exe, argv, opts) => { calls.push({ exe, argv, opts }); return typeof result === "function" ? result() : result; }; return { spawn, calls }; };
const BS = String.fromCharCode(92);
const ENV = { SystemRoot: "C:"+BS+"Windows" };
const attestor = (f, extra = {}) => mod.makeReparseAttestor({ spawn: f.spawn, platform: "win32", env: ENV, ...extra });
T("ReparseAttestation.test_fsutil_is_called_with_fixed_exe_argv_and_no_shell", () => {
	const f = fake({ status: 0, stdout: "Reparse Tag Value : 0xa0000003\r\n" });
	assert.equal(attestor(f)("C:"+BS+"p & x"+BS+"%PATH%"), true);
	assert.equal(f.calls[0].exe, path.win32.join("C:"+BS+"Windows", "System32", "fsutil.exe"));
	assert.deepEqual(f.calls[0].argv, ["reparsepoint", "query", "C:"+BS+"p & x"+BS+"%PATH%"]);
	assert.equal(f.calls[0].opts.shell, false);
	assert.equal(f.calls[0].opts.timeout <= 5000, true);
	assert.equal(f.calls[0].opts.maxBuffer, 65536);
});
T("ReparseAttestation.test_status_mapping_is_numeric_and_fail_closed", () => {
	assert.equal(attestor(fake({ status: 1, stdout: "Error 4390: not a reparse point" }))("p"), false);
	assert.equal(attestor(fake({ status: 1, stdout: "Fehler 4390: localized text" }))("p"), false);
	assert.equal(attestor(fake({ status: 1, stdout: "Error 4390: The file or directory is not a reparse point.\r\n" }))("p"), false);
	assert.equal(attestor(fake({ status: 1, stdout: "", stderr: "Error 4390: The file or directory is not a reparse point.\r\n" }))("p"), false);
	assert.equal(attestor(fake({ status: 1, stdout: "エラー 4390：not a reparse point" }))("p"), false);
	const bad = [
		{ status: 1, stdout: "Error 5: Access is denied." }, { status: 1, stdout: "Error 2: missing" }, { status: 1, stdout: "gibberish" },
		{ status: 1, stdout: "gibberish 4390" }, { status: 1, stdout: "Error 5: Access is denied. C:"+BS+"4390" }, { status: 1, stdout: "Error 5: denied", stderr: "Error 4390: x" },
		{ status: 1, stdout: "4390" }, { status: 1, stdout: "Error 43900: x" }, { status: 1, stdout: "Error 04390: x" }, { status: 1, stdout: "Error 4390" },
		{ status: 1, stdout: "Error 4390: x\r\nsecond prose line" }, { status: 1, stdout: "" },
		{ status: 2, stdout: "Error 4390" }, { status: null, signal: "SIGTERM" }, { status: null, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) },
		{ status: null, error: Object.assign(new Error("spawnSync fsutil.exe ENOENT"), { code: "ENOENT" }) }, { status: 0 === 1 ? 0 : undefined },
	];
	for (const r of bad) assert.throws(() => attestor(fake(r))("p"), (e) => e instanceof mod.Refusal && /cannot attest reparse state/.test(e.message), JSON.stringify(r));
	assert.throws(() => mod.makeReparseAttestor({ spawn: fake({ status: 0 }).spawn, platform: "win32", env: {} })("p"), /SystemRoot unavailable/);
	assert.throws(() => mod.makeReparseAttestor({ spawn: fake({ status: 0 }).spawn, platform: "win32", env: { SystemRoot: "relative" } })("p"), /SystemRoot unavailable/);
});
T("ReparseAttestation.test_budget_is_bounded_and_restartable_and_posix_does_not_spawn", () => {
	let t = 0;
	const f = fake({ status: 1, stdout: "Error 4390: not a reparse point" });
	const a = attestor(f, { now: () => t, budgetMs: 100 });
	assert.equal(a("p"), false);
	t = 101;
	assert.throws(() => a("p"), /time budget exhausted/);
	a.restart();
	assert.equal(a("p"), false);
	const posix = fake({ status: 0 });
	assert.equal(mod.makeReparseAttestor({ spawn: posix.spawn, platform: "linux" })("p"), false);
	assert.equal(posix.calls.length, 0);
});
T("ReparseAttestation.test_real_fsutil_flags_a_junction_with_special_name_and_clears_a_plain_directory", (c, t) => {
	if (process.platform !== "win32") return t.skip("fsutil is Windows only");
	const target = path.join(c.dir, "target");
	fs.mkdirSync(target);
	const junction = path.join(c.dir, "J & x %PATH% ^ü");
	c.makeJunction(junction, target);
	const a = mod.makeReparseAttestor();
	assert.equal(a(junction), true);
	assert.equal(a(target), false);
	assert.equal(a(path.join(target, "..", "target")), false);
});
