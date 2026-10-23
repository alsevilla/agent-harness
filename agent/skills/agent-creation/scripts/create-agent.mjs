#!/usr/bin/env node
// Create one project-local Pi agent and an optional skill from a strict JSON spec.
//
// Preview is the default and writes nothing. --apply is explicit operator approval to create the listed files; it is not
// project trust, reload, activation or launch authority. Node built-ins only: no model, network, Pi or .NET calls.
// Trusted single-user projects only: this is not an adversarial race or OS sandbox.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_PARTIAL = 3;
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_META = 1024;
const MAX_MODEL = 256;
const MAX_INSTRUCTIONS = 32 * 1024;
const MAX_NAME = 64;
// shortcut: Python hit its recursion limit near 1000 and 4300 integer digits; these fixed limits replace that, revisit only if specs ever nest.
const MAX_JSON_DEPTH = 512;
const MAX_INT_DIGITS = 4300;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_NAMES = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
const SHELLS = ["bash", "powershell"];
const SPEC_KEYS = new Set(["name", "description", "instructions", "model", "thinking", "fallbackModel", "writer", "shell", "skill"]);
const REQUIRED_KEYS = ["name", "description", "instructions", "model"];
const SKILL_KEYS = ["name", "description", "instructions"];
const BAD_META = /[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]/u;
const BAD_INSTRUCTIONS = /[\p{Cc}\p{Cs}]/u;
const BASE_TOOLS = ["read", "grep", "find", "ls"];
// Python str.isspace() set (U+001C..U+001F, U+0085 included; U+FEFF excluded): strip semantics are kept exactly, not JS trim().
const PY_WS = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_ALL = new RegExp(`^[${PY_WS}]*$`);
const PY_WS_EDGES = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`);
const PY_WS_END = new RegExp(`[${PY_WS}]+$`);
const pyIsBlank = (s) => PY_WS_ALL.test(s);
const pyHasEdgeSpace = (s) => PY_WS_EDGES.test(s);
const codePoints = (s) => [...s].length;
// The value spaces after the colon are consumed here, so scalar rules see the value Pi sees; `s` keeps '.' matching U+2028/U+0085 as Python's did.
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ ]+(.*))?$/s;
// Plain scalars YAML would type as non-strings (or that are ambiguous); refused, never guessed.
const TYPED_PLAIN_RE = new RegExp("^(?:" + [
	"~", "null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF",
	"[-+]?(?:0|[1-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?", "[-+]?\\.[0-9_]+(?:[eE][-+]?[0-9]+)?",
	"0x[0-9a-fA-F_]+", "0o[0-7_]+", "[-+]?\\.(?:inf|Inf|INF)", "\\.(?:nan|NaN|NAN)",
].join("|") + ")$");
const INDICATORS = new Set("!&*|>[]{}%@`,#?-:");

/** Validation, permission, safety or collision refusal. Raised before any write. */
export class Refusal extends Error {}
/** Frontmatter outside the conservative subset; the caller refuses before writes. */
export class Unsupported extends Error {}
/** The exclusive create succeeded but the write or close failed: the partial file is kept, never deleted. */
class PartialWrite extends Error {}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const reason = (e) => (e && e.message) || String(e);
const normcase = (p) => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p);
const sameBytes = (a, b) => Buffer.compare(a, b) === 0;
// Case-insensitive collision key; upper-then-lower also folds ß/ſ like casefold() and may only over-refuse, never under-refuse.
const fold = (s) => s.toUpperCase().toLowerCase();

// ---- strict spec JSON -------------------------------------------------------------------------------------------------------
// Own parser: JSON.parse silently keeps the last duplicate key, accepts nothing non-finite and has no depth or digit limit to report.
export function strictJson(text) {
	let i = 0;
	const limit = () => new Refusal("JSON value exceeds parser limits (nesting depth or integer digits)");
	const fail = (msg, pos = i) => new Refusal(`invalid JSON: ${msg} (line ${text.slice(0, pos).split("\n").length})`);
	const skip = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
	const string = () => {
		const start = i++;
		while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
		if (i >= text.length) throw fail("Unterminated string starting at", start);
		i++;
		try { return JSON.parse(text.slice(start, i)); } catch { throw fail("Invalid control character or escape in string", start); }
	};
	const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
	const value = (depth) => {
		if (depth > MAX_JSON_DEPTH) throw limit();
		skip();
		const c = text[i];
		if (c === "{") {
			i++;
			const obj = Object.create(null);
			skip();
			if (text[i] === "}") { i++; return obj; }
			for (;;) {
				skip();
				if (text[i] !== '"') throw fail("Expecting property name enclosed in double quotes");
				const key = string();
				skip();
				if (text[i] !== ":") throw fail("Expecting ':' delimiter");
				i++;
				const v = value(depth + 1);
				if (hasOwn(obj, key)) throw new Refusal(`duplicate key in JSON object: ${key}`);
				obj[key] = v;
				skip();
				if (text[i] === ",") { i++; continue; }
				if (text[i] === "}") { i++; return obj; }
				throw fail("Expecting ',' delimiter");
			}
		}
		if (c === "[") {
			i++;
			const arr = [];
			skip();
			if (text[i] === "]") { i++; return arr; }
			for (;;) {
				arr.push(value(depth + 1));
				skip();
				if (text[i] === ",") { i++; continue; }
				if (text[i] === "]") { i++; return arr; }
				throw fail("Expecting ',' delimiter");
			}
		}
		if (c === '"') return string();
		for (const [token, v] of [["true", true], ["false", false], ["null", null]]) if (text.startsWith(token, i)) { i += token.length; return v; }
		for (const token of ["NaN", "Infinity", "-Infinity"]) if (text.startsWith(token, i)) throw new Refusal(`nonfinite number not allowed: ${token}`);
		NUMBER.lastIndex = i;
		const m = NUMBER.exec(text);
		if (!m) throw fail("Expecting value");
		i += m[0].length;
		const n = Number(m[0]);
		if (m[1] === undefined && m[2] === undefined) {
			if (m[0].replace("-", "").length > MAX_INT_DIGITS) throw limit();
			return n; // a huge integer may read as Infinity here; every number is refused later as a wrong type or unknown key
		}
		if (!Number.isFinite(n)) throw new Refusal(`nonfinite number not allowed: ${m[0]}`);
		return n;
	};
	if (text.startsWith("\ufeff")) throw fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
	const result = value(0);
	skip();
	if (i < text.length) throw fail("Extra data");
	return result;
}

const decodeUtf8 = (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); // ignoreBOM keeps a BOM so strictJson can refuse it

export function loadSpec(file, f = fs) {
	let raw;
	try {
		const fd = f.openSync(file, "r");
		try {
			const buf = Buffer.alloc(MAX_SPEC_BYTES + 1);
			let n = 0;
			for (let got = 1; got > 0 && n < buf.length; n += got) got = f.readSync(fd, buf, n, buf.length - n, null);
			raw = buf.subarray(0, n);
		} finally { f.closeSync(fd); }
	} catch (e) { throw new Refusal(`cannot read spec: ${reason(e)}`); }
	if (raw.length > MAX_SPEC_BYTES) throw new Refusal("spec exceeds the size limit");
	let text;
	try { text = decodeUtf8(raw); } catch { throw new Refusal("spec is not valid UTF-8"); }
	const data = strictJson(text);
	if (!isObject(data)) throw new Refusal("spec must be a JSON object");
	return data;
}

function slug(value, field) {
	if (typeof value !== "string") throw new Refusal(`${field} must be a string`);
	if (value.length > MAX_NAME || !NAME_RE.test(value)) throw new Refusal(`${field} must be a lowercase slug of at most ${MAX_NAME} characters (a-z, 0-9, single hyphens)`);
	if (RESERVED_NAMES.has(value.toUpperCase())) throw new Refusal(`${field} is a reserved Windows device name`);
	return value;
}
function meta(value, field, limit) {
	if (typeof value !== "string") throw new Refusal(`${field} must be a string`);
	if (!value || pyHasEdgeSpace(value)) throw new Refusal(`${field} must be non-empty with no leading or trailing whitespace`);
	if (codePoints(value) > limit) throw new Refusal(`${field} exceeds ${limit} characters`);
	if (BAD_META.test(value)) throw new Refusal(`${field} must be single-line text without control or format characters`);
	return value;
}
function instructions(value, field) {
	if (typeof value !== "string" || pyIsBlank(value)) throw new Refusal(`${field} must be a non-empty string`);
	if (codePoints(value) > MAX_INSTRUCTIONS) throw new Refusal(`${field} exceeds ${MAX_INSTRUCTIONS} characters`);
	if (BAD_INSTRUCTIONS.test(value.replace(/[\n\t]/g, ""))) throw new Refusal(`${field} contains a control character`);
	return value;
}
const sortedUnknown = (data, allowed) => Object.keys(data).filter((k) => !allowed.has(k)).sort();

export function validateSpec(data) {
	const unknown = sortedUnknown(data, SPEC_KEYS);
	if (unknown.length) throw new Refusal("unknown key(s) in spec: " + unknown.join(", "));
	for (const key of REQUIRED_KEYS) if (!hasOwn(data, key)) throw new Refusal(`missing required key: ${key}`);
	const writer = hasOwn(data, "writer") ? data.writer : false;
	if (typeof writer !== "boolean") throw new Refusal("writer must be exactly JSON true or false");
	const shell = hasOwn(data, "shell") ? data.shell : false;
	if (!(shell === false || (typeof shell === "string" && SHELLS.includes(shell)))) throw new Refusal('shell must be false, "bash" or "powershell"');
	let skill = null;
	if (hasOwn(data, "skill")) {
		const raw = data.skill;
		if (!isObject(raw)) throw new Refusal("skill must be an object");
		const extra = sortedUnknown(raw, new Set(SKILL_KEYS));
		if (extra.length) throw new Refusal("unknown key(s) in skill: " + extra.join(", "));
		for (const key of SKILL_KEYS) if (!hasOwn(raw, key)) throw new Refusal(`missing required skill key: ${key}`);
		skill = { name: slug(raw.name, "skill.name"), description: meta(raw.description, "skill.description", MAX_META), instructions: instructions(raw.instructions, "skill.instructions") };
	}
	return {
		name: slug(data.name, "name"),
		description: meta(data.description, "description", MAX_META),
		instructions: instructions(data.instructions, "instructions"),
		model: meta(data.model, "model", MAX_MODEL),
		thinking: hasOwn(data, "thinking") ? meta(data.thinking, "thinking", MAX_MODEL) : null,
		fallbackModel: hasOwn(data, "fallbackModel") ? meta(data.fallbackModel, "fallbackModel", MAX_MODEL) : null,
		writer,
		shell,
		skill,
	};
}

// ---- filesystem safety (lstat before any resolution) ------------------------------------------------------------------------
// Node's lstat reports symlinks and junctions as links but hides other Windows reparse points (cloud placeholders, dedup, WOF).
// To keep the legacy "any reparse point is refused" contract, every existing entry that lstat calls plain is also attested by the
// OS: fixed System32\fsutil.exe, argv array, shell:false. Exit 0 = reparse point; exit 1 with numeric error 4390 = not one; anything
// else (missing exe, spawn error, timeout, denied, unparseable, budget exhausted) refuses, never falls back to lstat alone.
// Nothing is memoized: each phase (scan, post-mkdir, apply recheck) asks the OS again. Real placeholder/WOF entries are untested
// (only injectable); non-Windows has no such attribute, so only lstat symlinks apply there.
export const REPARSE_BUDGET_MS = 20_000;
export function makeReparseAttestor({ spawn = spawnSync, platform = process.platform, env = process.env, now = Date.now, budgetMs = REPARSE_BUDGET_MS } = {}) {
	let deadline = now() + budgetMs;
	const attest = (p) => {
		if (platform !== "win32") return false;
		const remaining = deadline - now();
		if (remaining <= 0) throw new Refusal(`cannot attest reparse state (time budget exhausted): ${p}`);
		const root = env.SystemRoot || env.windir;
		if (!root || !path.win32.isAbsolute(root)) throw new Refusal(`cannot attest reparse state (SystemRoot unavailable): ${p}`);
		const exe = path.win32.join(root, "System32", "fsutil.exe");
		const r = spawn(exe, ["reparsepoint", "query", p], { shell: false, windowsHide: true, encoding: "utf8", timeout: Math.min(5000, remaining), maxBuffer: 65536 });
		if (r.error || r.signal || typeof r.status !== "number") throw new Refusal(`cannot attest reparse state (${r.error ? reason(r.error) : "fsutil did not complete"}): ${p}`);
		if (r.status === 0) return true;
		if (r.status === 1) {
			const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => l.trim());
			// Single "<label> <code>:" record only; localized labels of another shape refuse (fail closed).
			if (lines.length === 1 && /^\p{L}[\p{L}\p{M}]*\s+(\d+)\s*[:：]/u.exec(lines[0])?.[1] === "4390") return false;
		}
		throw new Refusal(`cannot attest reparse state (fsutil exit ${r.status}): ${p}`);
	};
	attest.restart = () => { deadline = now() + budgetMs; };
	return attest;
}
let attestReparse = makeReparseAttestor();
export function isLink(p) {
	try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 'dir', 'file' or null (missing). Links and junctions are refused. */
function kind(p) {
	let st;
	try { st = fs.lstatSync(p); } catch (e) {
		if (e.code === "ENOENT") return null;
		throw new Refusal(`cannot inspect ${p}: ${reason(e)}`);
	}
	if (st.isSymbolicLink() || attestReparse(p)) throw new Refusal(`symlink, junction or reparse point refused: ${p}`);
	if (st.isDirectory()) return "dir";
	if (st.isFile()) return "file";
	throw new Refusal(`unsupported filesystem entry: ${p}`);
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const parts = (p, base) => path.relative(base, p).split(path.sep).filter((s) => s && s !== ".");

function checkRoot(raw) {
	if (!path.isAbsolute(raw)) throw new Refusal("project root must be an absolute path");
	if (raw.split(/[\\/]+/).some((s) => s === "." || s === "..")) throw new Refusal("project root must not contain . or .. segments");
	const root = path.resolve(raw);
	const k = kind(root);
	if (k === null) throw new Refusal("project root does not exist");
	if (k !== "dir") throw new Refusal("project root must be a directory");
	const prefix = path.parse(root).root;
	let cur = prefix;
	for (const part of parts(root, prefix).slice(0, -1)) {
		cur = path.join(cur, part);
		if (kind(cur) !== "dir") throw new Refusal(`project root ancestor is not a plain directory: ${cur}`);
	}
	return root;
}

/** Refuse links below root; returns 'dir', 'file' or null for the final path. */
function inspectChain(p, root) {
	let k = "dir";
	let cur = root;
	for (const part of parts(p, root)) {
		cur = path.join(cur, part);
		k = kind(cur);
		if (k === null) return null;
		if (cur !== p && k !== "dir") throw new Refusal(`path component is not a directory: ${cur}`);
	}
	return k;
}

function ensureParentDirs(p, root, createdDirs) {
	let cur = root;
	for (const part of parts(path.dirname(p), root)) {
		cur = path.join(cur, part);
		if (kind(cur) === null) {
			fs.mkdirSync(cur);
			createdDirs.push(cur);
			if (kind(cur) !== "dir") throw new Refusal(`directory changed during creation: ${cur}`);
		}
	}
}

function within(p, base) {
	const rel = path.relative(base, p);
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** realpath that tolerates a missing tail: the nearest existing ancestor is resolved (expanding 8.3 aliases), the rest appended. */
function realpathLoose(p) {
	const tail = [];
	let cur = p;
	for (;;) {
		try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch (e) {
			const up = path.dirname(cur);
			if (up === cur) return p;
			tail.push(path.basename(cur));
			cur = up;
		}
	}
}

function expandHome(value, home) {
	return value === "~" || value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(1)) : value;
}
function resolveAgentDir(explicit, env, home) {
	const value = expandHome(explicit || env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), home);
	if (!path.isAbsolute(value)) throw new Refusal("agent dir must be an absolute path");
	return path.resolve(value);
}

// ---- conservative frontmatter subset ----------------------------------------------------------------------------------------
function scalar(raw) {
	if (raw === "") return null;
	if (raw[0] === '"') {
		let value;
		try { value = JSON.parse(raw); } catch { throw new Unsupported("double-quoted scalar is not a single-line JSON-compatible string"); }
		if (typeof value !== "string") throw new Unsupported("double-quoted scalar is not a string");
		return value;
	}
	if (raw[0] === "'") {
		if (raw.length < 2 || raw.at(-1) !== "'") throw new Unsupported("single-quoted scalar is not closed on the same line");
		const body = raw.slice(1, -1);
		let out = "";
		for (let i = 0; i < body.length; i++) {
			if (body[i] === "'") {
				if (body[i + 1] === "'") { out += "'"; i++; continue; }
				throw new Unsupported("single-quoted scalar has an unescaped quote");
			}
			out += body[i];
		}
		return out;
	}
	if (INDICATORS.has(raw[0]) || raw.includes(" #") || raw.includes(": ") || raw.endsWith(":")) throw new Unsupported(`plain scalar uses YAML syntax outside the supported subset: ${JSON.stringify(raw.slice(0, 40))}`);
	if (TYPED_PLAIN_RE.test(raw)) throw new Unsupported(`plain scalar would be typed by YAML: ${JSON.stringify(raw.slice(0, 40))}`);
	return raw;
}

/** {key: string|null} for a '---' block, or null when no frontmatter is present. Anything outside the supported subset throws Unsupported. */
export function parseFrontmatterSubset(input) {
	let text = input.startsWith("\ufeff") ? input.slice(1) : input;
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!text.startsWith("---")) return null;
	const lines = text.split("\n");
	if (lines[0] !== "---") throw new Unsupported("frontmatter opener must be a bare --- line");
	const close = lines.indexOf("---", 1);
	if (close < 0) throw new Unsupported("frontmatter has no closing --- line");
	const data = Object.create(null);
	for (const line of lines.slice(1, close)) {
		if (pyIsBlank(line) || line.startsWith("#")) continue;
		if (/[\x00-\x1f]/.test(line)) throw new Unsupported("control character inside frontmatter");
		const m = KEY_RE.exec(line);
		if (m === null) throw new Unsupported(`line outside the supported key/value subset: ${JSON.stringify(line.slice(0, 40))}`);
		if (hasOwn(data, m[1])) throw new Unsupported(`duplicate frontmatter key: ${m[1]}`);
		data[m[1]] = scalar((m[2] ?? "").replace(/ +$/, ""));
	}
	return data;
}

function frontmatter(bytes, p) {
	let text;
	try { text = decodeUtf8(bytes); } catch { throw new Refusal(`not valid UTF-8, collision check cannot be established: ${p}`); }
	try { return parseFrontmatterSubset(text); } catch (e) {
		if (e instanceof Unsupported) throw new Refusal(`unsupported frontmatter, collision check cannot be established (${e.message}): ${p}`);
		throw e;
	}
}
function readBytes(p) {
	try { return fs.readFileSync(p); } catch (e) { throw new Refusal(`cannot read ${p}: ${reason(e)}`); }
}

// ---- collision registry -----------------------------------------------------------------------------------------------------
function add(table, key, source) {
	if (key) {
		const k = fold(key);
		if (!table.has(k)) table.set(k, []);
		table.get(k).push(source);
	}
}

function loadRoles(agentDir) {
	const p = path.join(agentDir, "roles.json");
	if (!fs.existsSync(p)) return [];
	let data;
	try { data = strictJson(decodeUtf8(fs.readFileSync(p))); } catch (e) {
		if (e instanceof Refusal) throw e;
		throw new Refusal(`roles.json unreadable, collision check cannot be established: ${p}`);
	}
	if (!Array.isArray(data)) throw new Refusal(`roles.json must be a list: ${p}`);
	return data.filter((e) => isObject(e) && typeof e.name === "string").map((e) => e.name);
}

function listDir(dir, label) {
	try { return fs.readdirSync(dir).sort(); } catch (e) { throw new Refusal(`cannot scan ${label} ${dir}: ${reason(e)}`); }
}

function scanAgentDir(dir, label, own, table) {
	if (!isDir(dir)) return;
	for (const entry of listDir(dir, label)) {
		const p = path.join(dir, entry);
		if (!entry.endsWith(".md") || !isFile(p)) continue;
		const data = readBytes(p);
		const mine = own.get(normcase(p));
		if (mine && sameBytes(mine, data)) continue;
		const fm = frontmatter(data, p);
		add(table, entry.slice(0, -3), `${label} file name ${p}`);
		if (fm && typeof fm.name === "string") add(table, fm.name, `${label} frontmatter name in ${p}`);
	}
}

function nearestProjectAgentsDir(root) {
	let cur = path.dirname(root);
	for (;;) {
		const candidate = path.join(cur, ".pi", "agents");
		if (isDir(candidate)) return candidate;
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

const PACKAGE_NAME = "@alsevilla/pi-engineering-harness";

function packageRoot(scriptFile) {
	// Native layout: <package>/agent/skills/agent-creation/scripts/create-agent.mjs. Resources are <package>/agent; the named manifest is <package>/package.json.
	const resources = path.dirname(path.dirname(path.dirname(path.dirname(path.resolve(scriptFile)))));
	const manifest = path.join(path.dirname(resources), "package.json");
	try { fs.lstatSync(manifest); } catch { return null; } // No root manifest is the legacy/live layout; bundled roles are not discovered there either.
	let data;
	try { data = strictJson(decodeUtf8(fs.readFileSync(manifest))); } catch { throw new Refusal(`package manifest unreadable, collision check cannot be established: ${manifest}`); }
	if (!isObject(data)) throw new Refusal(`package manifest must be an object, collision check cannot be established: ${manifest}`);
	return data.name === PACKAGE_NAME ? resources : null;
}

function packageRoleNames(resources) {
	// Names contract only (not a full role parser): a non-empty list of objects with unique non-empty string names.
	let data;
	try { data = strictJson(decodeUtf8(readBytes(path.join(resources, "roles.json")))); } catch (e) {
		if (e instanceof Refusal) throw e;
		throw new Refusal("package roles.json must list named roles, collision check cannot be established");
	}
	const names = Array.isArray(data) ? data.map((e) => (isObject(e) ? e.name : null)) : [];
	if (!names.length || names.some((n) => typeof n !== "string" || !n.trim()) || new Set(names).size !== names.length) {
		throw new Refusal("package roles.json must list named roles without duplicates, collision check cannot be established");
	}
	return names;
}

function scanPackageRoles(resources, table) {
	// Bundled role names are reserved as a static label; paths stay out of the refusal text.
	const agents = path.join(resources, "agents");
	// Package mode fails closed: a partial bundle would let a colliding name through the collision check.
	if (!isFile(path.join(resources, "roles.json")) || !isDir(agents)) throw new Refusal("package roles missing, collision check cannot be established");
	const declared = packageRoleNames(resources);
	for (const name of declared) add(table, name, "package roles.json");
	const defined = [];
	for (const entry of listDir(agents, "package agents")) {
		const p = path.join(agents, entry);
		if (!entry.endsWith(".md") || !isFile(p)) continue;
		const fm = frontmatter(readBytes(p), p);
		add(table, entry.slice(0, -3), "package agent file");
		const name = fm ? fm.name : null;
		if (typeof name !== "string" || !name.trim()) throw new Refusal("package roles.json and agents disagree on role names, collision check cannot be established");
		defined.push(name);
		add(table, name, "package agent frontmatter name");
	}
	// Exact set equality: each declared role has one parsed definition and no definition is undeclared.
	if (JSON.stringify([...declared].sort()) !== JSON.stringify([...defined].sort())) throw new Refusal("package roles.json and agents disagree on role names, collision check cannot be established");
}

function agentRegistry(agentDir, root, own, warnings, pkg) {
	const table = new Map();
	for (const name of loadRoles(agentDir)) add(table, name, "global roles.json");
	if (pkg) scanPackageRoles(pkg, table);
	scanAgentDir(path.join(agentDir, "agents"), "global agents", own, table);
	const target = path.join(root, ".pi", "agents");
	if (kind(target) === "dir") scanAgentDir(target, "project agents", own, table);
	else {
		const nearest = nearestProjectAgentsDir(root);
		if (nearest) {
			scanAgentDir(nearest, "nearest ancestor project agents", own, table);
			warnings.push(`warning: creating ${target} shadows the nearest project agents directory ${nearest} for sessions started in ${root}; its agents are not discovered from that root`);
		}
	}
	return table;
}

function skillRoots(agentDir, root, home) {
	const roots = [[path.join(agentDir, "skills"), "pi"], [path.join(home, ".agents", "skills"), "agents"], [path.join(root, ".pi", "skills"), "pi"], [path.join(root, ".agents", "skills"), "agents"]];
	let cur = root;
	for (;;) {
		roots.push([path.join(cur, ".agents", "skills"), "agents"]);
		if (fs.existsSync(path.join(cur, ".git"))) break;
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	const seen = new Set();
	return roots.filter(([item]) => { const k = normcase(path.normalize(item)); return seen.has(k) ? false : (seen.add(k), true); });
}

function scanSkillRoot(base, mode, own, table, linked) {
	// mode 'pi' loads root-level *.md; mode 'agents' loads nested *.md (Pi package-manager rules)
	if (!isDir(base)) return;
	const stack = [base];
	while (stack.length) {
		const cur = stack.pop();
		let entries;
		try { entries = fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch (e) { throw new Refusal(`cannot scan skill root ${cur}: ${reason(e)}`); }
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue; // native ignores these entries too
			const p = path.join(cur, entry.name);
			if (linked(p) || attestReparse(p)) throw new Refusal(`linked skill entry refused; native follows links, collision check cannot be established: ${p}`);
			if (entry.isDirectory()) stack.push(p);
			else if (entry.isFile() && (entry.name === "SKILL.md" || (entry.name.endsWith(".md") && (cur === base || mode === "agents")))) {
				const data = readBytes(p);
				const mine = own.get(normcase(p));
				if (mine && sameBytes(mine, data)) continue;
				const fm = frontmatter(data, p);
				const declared = fm && typeof fm.name === "string" ? fm.name : null;
				if (entry.name === "SKILL.md") {
					add(table, declared, `skill name in ${p}`);
					add(table, path.basename(cur), `skill directory name for ${p}`);
				} else {
					add(table, declared, `skill file name in ${p}`);
					if (cur === base) add(table, entry.name.slice(0, -3), `skill file stem ${p}`);
					// native name = frontmatter name || parent directory; root *.md only loads in pi mode
					if (!declared && (cur !== base || mode === "pi")) add(table, path.basename(cur), `skill file parent-directory name for ${p}`);
				}
			}
		}
	}
}

// ---- rendering --------------------------------------------------------------------------------------------------------------
// JSON-quoted YAML double-quoted scalar; control characters were already refused, so JSON.stringify matches Python's json.dumps(ensure_ascii=False).
const q = (value) => JSON.stringify(value);

function toolsFor(spec) {
	const tools = [...BASE_TOOLS];
	if (spec.writer) tools.push("edit");
	if (spec.shell !== false) tools.push(spec.shell);
	return tools;
}

function renderAgent(spec, skillPath) {
	const fm = ["---", `name: ${q(spec.name)}`, `description: ${q(spec.description)}`, `model: ${q(spec.model)}`];
	if (spec.thinking !== null) fm.push(`thinking: ${q(spec.thinking)}`);
	if (spec.fallbackModel !== null) fm.push(`fallbackModel: ${q(spec.fallbackModel)}`);
	fm.push(`tools: ${q(toolsFor(spec).join(", "))}`, "---");
	const body = [`# ${spec.name}`, "", spec.instructions.replace(PY_WS_END, ""), "", "## Generated boundaries",
		"- Work only inside the assigned project and task scope; preserve unrelated code, tests and user changes.",
		"- Do not launch, delegate or supervise other agents, helpers or subagent tools.",
		"- Do not commit, push, merge, publish, deploy or change model, provider, fallback or global role configuration.",
		"- Use only the tools listed in this definition; shell access, when granted, is not a sandbox."];
	if (skillPath) body.push(`- Before starting, read the original skill instructions at this absolute path and follow them within this role's authority: ${skillPath}`);
	return [...fm, "", ...body].join("\n") + "\n";
}

function renderSkill(skill) {
	return ["---", `name: ${q(skill.name)}`, `description: ${q(skill.description)}`, "---", "", `# ${skill.name}`, "", skill.instructions.replace(PY_WS_END, "")].join("\n") + "\n";
}

function buildTargets(spec, root, agentDir) {
	const skillPath = spec.skill ? path.join(root, ".pi", "skills", spec.skill.name, "SKILL.md") : null;
	const targets = [{ label: "agent", path: path.join(root, ".pi", "agents", spec.name + ".md"), data: Buffer.from(renderAgent(spec, skillPath), "utf8"), status: null }];
	if (spec.skill) targets.push({ label: "skill", path: skillPath, data: Buffer.from(renderSkill(spec.skill), "utf8"), status: null });
	for (const t of targets) {
		if (within(t.path, agentDir) || within(t.path, realpathLoose(agentDir))) throw new Refusal(`output inside the global agent directory refused: ${t.path}`);
	}
	return targets;
}

/** Exclusive create: a failure to create writes nothing; a failure after the create is a PartialWrite and the file is kept. */
function createExclusive(p, data, f) {
	const fd = f.openSync(p, "wx");
	try {
		for (let off = 0; off < data.length;) off += f.writeSync(fd, data, off, data.length - off);
	} catch (e) {
		try { f.closeSync(fd); } catch { /* the write failure is the one reported */ }
		throw new PartialWrite(reason(e));
	}
	try { f.closeSync(fd); } catch (e) { throw new PartialWrite(reason(e)); }
}

// ---- run ---------------------------------------------------------------------------------------------------------------------
function stop(o, createdDirs, created, partial, uncreated, exc) {
	for (const d of createdDirs) o.out(`created-dir: ${d}\n`);
	for (const c of created) o.out(`created: ${c}\n`);
	if (partial) o.out(`partial: ${partial}\n`);
	for (const u of uncreated) o.out(`uncreated: ${u}\n`);
	if (partial) o.err(`ERROR: write failed after ${created.length} complete file(s); partial file left at ${partial}: ${reason(exc)}; nothing was deleted; review the partial file before any cleanup\n`);
	else o.err(`ERROR: write stopped after ${created.length} file(s): ${reason(exc)}; nothing was deleted\n`);
}

function emitPlan(o, mode, root, agentDir, spec, targets, warnings) {
	const line = (s) => o.out(s + "\n");
	line(`mode: ${mode}`);
	line(`project root: ${root}`);
	line(`agent dir: ${agentDir}`);
	const shell = spec.shell !== false ? `${spec.shell} (explicit grant; not a sandbox)` : "false";
	line(`permissions: tools=${toolsFor(spec).join(", ")}; write-tool=disabled; source-edit=${spec.writer ? "approved" : "readonly"}; writer=${spec.writer}; shell=${shell}; model=${spec.model}; fallbackModel=${spec.fallbackModel || "none"}; thinking=${spec.thinking || "none"}`);
	for (const w of warnings) line(w);
	for (const t of targets) line(`${t.label} file: ${t.path} -> ${t.status}`);
	if (mode === "preview") {
		line("no files written; re-run with --apply to create the files listed above");
		for (const t of targets) {
			line(`--- BEGIN ${t.label} file: ${t.path} ---`);
			o.out(t.data.toString("utf8"));
			line(`--- END ${t.label} file ---`);
		}
	}
}

/** o: {out, err, env, home, fs, isLink, attest}; attest(p) => true for a reparse point, or throws Refusal when it cannot tell; fs and isLink are injectable so tests can force write and link failures. */
export function run(args, o) {
	attestReparse = o.attest ?? makeReparseAttestor();
	const spec = validateSpec(loadSpec(args.spec, o.fs));
	if (spec.writer && !args.allowWriters) throw new Refusal("writer:true requires --allow-writers");
	if (spec.shell !== false && !args.allowShell) throw new Refusal(`shell:${spec.shell} requires --allow-shell`);
	const root = checkRoot(args.projectRoot);
	const agentDir = resolveAgentDir(args.agentDir, o.env, o.home);
	const targets = buildTargets(spec, root, agentDir);
	for (const t of targets) {
		const k = inspectChain(t.path, root);
		if (k === "file") {
			if (sameBytes(readBytes(t.path), t.data)) t.status = "unchanged";
			else throw new Refusal(`existing file differs and will not be overwritten: ${t.path}`);
		} else if (k === "dir") throw new Refusal(`output path is a directory: ${t.path}`);
		else t.status = "create";
	}
	// Canonical check after the lstat/link refusals above: 8.3 or other aliases of the global dir are caught.
	const realAgent = realpathLoose(agentDir);
	for (const t of targets) if (within(realpathLoose(t.path), realAgent)) throw new Refusal(`output inside the global agent directory refused: ${t.path}`);
	if (within(realpathLoose(root), realAgent)) throw new Refusal(`project root inside the global agent directory refused: ${root}`);
	const own = new Map(targets.filter((t) => t.status === "unchanged").map((t) => [normcase(t.path), t.data]));
	const warnings = [];
	const agents = agentRegistry(agentDir, root, own, warnings, packageRoot(fileURLToPath(import.meta.url)));
	const skills = new Map();
	for (const [base, mode] of skillRoots(agentDir, root, o.home)) scanSkillRoot(base, mode, own, skills, o.isLink);
	for (const t of targets) {
		const table = t.label === "agent" ? agents : skills;
		const key = t.label === "agent" ? spec.name : spec.skill.name;
		const hit = table.get(fold(key));
		if (hit) throw new Refusal(`${t.label} name '${key}' collides with: ${hit[0]}`);
	}
	const mode = args.apply ? "apply" : "preview";
	emitPlan(o, mode, root, agentDir, spec, targets, warnings);
	if (!args.apply) return EXIT_OK;
	attestReparse.restart?.(); // apply phase gets its own budget; no proof from the preview scan is reused
	const created = [], createdDirs = [], pending = targets.filter((t) => t.status === "create");
	for (const t of targets) if (t.status === "unchanged") o.out(`unchanged: ${t.path}\n`);
	for (const [index, t] of pending.entries()) {
		try {
			ensureParentDirs(t.path, root, createdDirs);
			if (kind(t.path) !== null) throw new Refusal(`path appeared during apply: ${t.path}`);
			createExclusive(t.path, t.data, o.fs);
		} catch (e) {
			if (e instanceof PartialWrite) { stop(o, createdDirs, created, t.path, pending.slice(index + 1).map((u) => u.path), e); return EXIT_PARTIAL; }
			if (e instanceof Refusal || typeof e?.code === "string") { // Refusal or a system error; anything else is a bug and propagates
				stop(o, createdDirs, created, null, pending.slice(index).map((u) => u.path), e); return EXIT_PARTIAL; }
			throw e;
		}
		created.push(t.path);
	}
	for (const d of createdDirs) o.out(`created-dir: ${d}\n`);
	for (const c of created) o.out(`created: ${c}\n`);
	return EXIT_OK;
}

const OPTIONS = {
	spec: { type: "string" }, "project-root": { type: "string" }, "agent-dir": { type: "string" },
	apply: { type: "boolean" }, "allow-writers": { type: "boolean" }, "allow-shell": { type: "boolean" }, help: { type: "boolean", short: "h" },
};
const USAGE = "usage: create-agent.mjs [-h] --spec SPEC --project-root PROJECT_ROOT [--agent-dir AGENT_DIR] [--apply] [--allow-writers] [--allow-shell]\n";
const HELP = `${USAGE}
Preview or create a project-local Pi agent (and optional skill).

  --spec SPEC                strict JSON spec file
  --project-root PROJECT_ROOT  absolute existing project root
  --agent-dir AGENT_DIR      global agent dir (else PI_CODING_AGENT_DIR, else ~/.pi/agent)
  --apply                    create files (default: preview only)
  --allow-writers            permit writer:true (adds edit)
  --allow-shell              permit shell bash/powershell
`;

/** CLI entry. Returns the exit code; never calls process.exit so piped output is flushed. Abbreviated flags are refused (argparse accepted prefixes). */
export function main(argv, io = {}) {
	const o = {
		out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), env: process.env, home: os.homedir(),
		isLink, ...io,
	};
	o.fs = { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync, readSync: fs.readSync, ...io.fs };
	let values;
	try { values = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values; } catch (e) {
		o.err(`${USAGE}create-agent.mjs: error: ${reason(e)}\n`);
		return EXIT_USAGE;
	}
	if (values.help) { o.out(HELP); return EXIT_OK; }
	const missing = ["spec", "project-root"].filter((k) => values[k] === undefined);
	if (missing.length) {
		o.err(`${USAGE}create-agent.mjs: error: the following arguments are required: ${missing.map((k) => "--" + k).join(", ")}\n`);
		return EXIT_USAGE;
	}
	const args = { spec: values.spec, projectRoot: values["project-root"], agentDir: values["agent-dir"], apply: !!values.apply, allowWriters: !!values["allow-writers"], allowShell: !!values["allow-shell"] };
	try { return run(args, o); } catch (e) {
		if (!(e instanceof Refusal)) throw e;
		o.err(`ERROR: ${e.message}\n`);
		return EXIT_REFUSED;
	}
}

function isMain() {
	try { return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) process.exitCode = main(process.argv.slice(2));
