#!/usr/bin/env node
// Serena for harness workers, without pi-serena: a shell command instead of ~11 tool schemas in every launch.
//   node serena.mjs outline <file>...                  symbols of a file with kinds and line ranges
//   node serena.mjs find <Name or Owner/name> [path] [--body] [--kind <kind>]   where a symbol is defined (and its body)
//   node serena.mjs refs <name or Owner/name> [path]   code references, each with its enclosing symbol
//   node serena.mjs status                             what this machine has: Serena, its server, this project
//   node serena.mjs stop                               stop the server this skill started (the next query starts a fresh one)
// Serena (uv tool install serena-agent) answers through the language server: a small read-only server (serena_server.py, Serena's
// own project server) starts on first use, serves every project on this machine and exits after 30 idle minutes. The first query of a
// project waits while its language servers start. When Serena is missing or cannot serve the project, a built-in heuristic parser
// (symbols.mjs: Rust, TypeScript/JavaScript, Python) answers instead and the output says so. Lines are 1-based. Read-only.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCommand as heuristicFind, outlineCommand as heuristicOutline, refsCommand as heuristicRefs, langOf } from "./symbols.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const port = () => Number(process.env.HARNESS_SERENA_PORT || 24227); // read per call, so a caller (or test) can point elsewhere
const QUERY_TIMEOUT_MS = Number(process.env.HARNESS_SERENA_TIMEOUT_SECONDS || 300) * 1000;
const START_TIMEOUT_MS = 90_000;
const MAX_ANSWER_CHARS = 40_000;
const MAX_BODY_LINES = 300;
const STATE_DIR = path.join(os.tmpdir(), "harness-serena");
const LANGUAGES = { ".rs": "rust", ".ts": "typescript", ".tsx": "typescript", ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript", ".py": "python", ".go": "go", ".java": "java", ".kt": "kotlin", ".cs": "csharp", ".rb": "ruby", ".php": "php", ".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".h": "cpp", ".hpp": "cpp", ".swift": "swift", ".scala": "scala" };
const QUIET_KINDS = new Set(["Field", "Variable", "Constant", "EnumMember", "Property", "TypeParameter", "Key", "String", "Number", "Boolean", "Array", "Object", "Null"]);

class Unavailable extends Error {}

// ---- Where things are.
export function projectRoot(start) {
	let dir = path.resolve(start);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(start);
		dir = parent;
	}
}
const serenaHome = () => process.env.SERENA_HOME || path.join(os.homedir(), ".serena");
const configFile = () => path.join(serenaHome(), "serena_config.yml");
function authSecret() {
	try { return /^auth_secret:\s*["']?([^"'\s#]+)/m.exec(fs.readFileSync(configFile(), "utf8"))?.[1]; } catch { return undefined; }
}
export function serenaPython() {
	if (process.env.HARNESS_SERENA_PYTHON) return fs.existsSync(process.env.HARNESS_SERENA_PYTHON) ? process.env.HARNESS_SERENA_PYTHON : undefined;
	const dirs = [];
	const uv = spawnSync("uv", ["tool", "dir"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
	if (uv.status === 0 && uv.stdout.trim()) dirs.push(uv.stdout.trim().split(/\r?\n/).pop());
	dirs.push(path.join(os.homedir(), ".local", "share", "uv", "tools"));
	if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "uv", "tools"));
	for (const dir of dirs) {
		for (const python of [path.join(dir, "serena-agent", "Scripts", "python.exe"), path.join(dir, "serena-agent", "bin", "python")]) if (fs.existsSync(python)) return python;
	}
	return undefined;
}
const relTo = (root, p) => path.relative(root, path.resolve(p)).split(path.sep).join("/");
const insideRoot = (root, p) => { const r = path.relative(root, path.resolve(p)); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

// ---- Project setup: Serena serves a checkout that has .serena/project.yml. It is created only in a primary checkout whose .gitignore
// already ignores it, so the candidate never gains an untracked file and worktree cleanup never meets a .serena folder it did not expect.
function projectLanguages(root) {
	const files = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
	const counts = new Map();
	for (const file of (files.stdout ?? "").split(/\r?\n/)) {
		const lang = LANGUAGES[path.extname(file).toLowerCase()];
		if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
	}
	return [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([lang]) => lang);
}
function ensureProject(root, python) {
	if (fs.existsSync(path.join(root, ".serena", "project.yml"))) return;
	if (!fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isDirectory()) throw new Unavailable(`Serena is not set up for this worktree (${root} has no .serena/project.yml), and the skill does not add one to a worktree`);
	const ignored = spawnSync("git", ["-C", root, "check-ignore", "-q", ".serena/project.yml"], { windowsHide: true, timeout: 15_000 });
	if (ignored.status !== 0) throw new Unavailable(`Serena is not set up for ${root}: add .serena/ to its .gitignore, or run serena project create there yourself`);
	const languages = projectLanguages(root);
	if (!languages.length) throw new Unavailable(`no language Serena supports was found in ${root}`);
	const create = spawnSync(python, ["-c", "from serena.cli import top_level; top_level()", "project", "create", root, ...languages.flatMap((l) => ["--ls", l])], { encoding: "utf8", windowsHide: true, timeout: 120_000, input: "" });
	if (create.status !== 0 || !fs.existsSync(path.join(root, ".serena", "project.yml"))) throw new Unavailable(`serena project create failed: ${(create.stderr || create.stdout || "").trim().split(/\r?\n/).pop()}`);
}

// ---- The server.
async function request(route, body, timeoutMs) {
	const secret = authSecret();
	if (!secret) throw new Unavailable(`no auth_secret in ${configFile()}`);
	const init = { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) };
	if (body !== undefined) init.body = JSON.stringify(body);
	const response = await fetch(`http://127.0.0.1:${port()}${route}`, init);
	const text = await response.text();
	if (response.status === 400) throw new Error(text.trim());
	if (!response.ok) throw new Unavailable(`Serena server answered HTTP ${response.status}`);
	return text;
}
const alive = async () => { try { return JSON.parse(await request("/heartbeat", undefined, 3000)).status === "alive"; } catch { return false; } };

async function ensureServer(python) {
	if (await alive()) return;
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const lock = path.join(STATE_DIR, `start-${port()}.lock`);
	let owner = false;
	try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); owner = true; } catch {
		try { if (Date.now() - fs.statSync(lock).mtimeMs > START_TIMEOUT_MS) { fs.rmSync(lock, { force: true }); fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); owner = true; } } catch { /* another caller is starting it */ }
	}
	const logFile = path.join(STATE_DIR, `server-${port()}.log`);
	let exited;
	try {
		if (owner) {
			const log = fs.openSync(logFile, "w");
			const child = spawn(python, [path.join(HERE, "serena_server.py"), String(port())], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
			child.on("exit", (code) => { exited = code ?? "signal"; });
			child.unref();
			fs.writeFileSync(path.join(STATE_DIR, `server-${port()}.json`), JSON.stringify({ pid: child.pid, port: port(), startedAt: new Date().toISOString() }));
		}
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (await alive()) return;
			if (exited !== undefined) {
				let last = "";
				try { last = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).pop() ?? ""; } catch { /* no log */ }
				throw new Unavailable(`the Serena server exited (${exited}): ${last.slice(0, 200)}${/project_server|ModuleNotFound|ImportError/.test(last) ? " (needs serena-agent 2.x: uv tool upgrade serena-agent)" : ""}`);
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Unavailable(`the Serena server did not start within ${START_TIMEOUT_MS / 1000} s (log: ${path.join(STATE_DIR, `server-${port()}.log`)})`);
	} finally { if (owner) fs.rmSync(lock, { force: true }); }
}

async function connect(cwd) {
	const python = serenaPython();
	if (!python) throw new Unavailable("Serena is not installed (uv tool install serena-agent)");
	const root = projectRoot(cwd);
	ensureProject(root, python);
	await ensureServer(python);
	return {
		root,
		tool: async (name, params) => request("/query_project", { project_name: root, tool_name: name, tool_params_json: JSON.stringify(params) }, QUERY_TIMEOUT_MS),
		outline: async (relative) => JSON.parse(await request("/outline", { project_name: root, relative_path: relative }, QUERY_TIMEOUT_MS)),
	};
}

// ---- Formatting (Serena reports 0-based lines; everything printed here is 1-based).
const range = (loc) => (loc ? `${loc.start_line + 1}-${loc.end_line + 1}` : "?");
const lastSegment = (namePath) => namePath.split("/").pop();
const ownerMatches = (namePath, owner) => namePath.split("/").slice(0, -1).some((seg) => seg === owner || seg === `impl ${owner}` || seg.endsWith(` for ${owner}`) || seg.startsWith(`${owner}<`) || seg.startsWith(`impl ${owner}<`));
const KIND_ALIASES = { fn: "function", func: "function", type: "typeparameter" };
const kindOk = (kind, wanted) => !wanted || kind.toLowerCase() === (KIND_ALIASES[wanted.toLowerCase()] ?? wanted.toLowerCase());

function outlineLines(symbols, level = 1) {
	const out = [];
	const byLine = [...symbols].sort((a, b) => (a.body_location?.start_line ?? 0) - (b.body_location?.start_line ?? 0));
	for (const s of byLine) {
		if (level > 1 && QUIET_KINDS.has(s.kind)) continue;
		out.push(`${"  ".repeat(level)}${s.kind.toLowerCase()} ${lastSegment(s.name_path)}  L${range(s.body_location)}`);
		if (s.children) out.push(...outlineLines(s.children, level + 1));
	}
	return out;
}

async function findSymbols(serena, name, relative, body) {
	const params = { name_path_pattern: name, include_body: body, max_answer_chars: MAX_ANSWER_CHARS };
	if (relative) params.relative_path = relative;
	let hits = JSON.parse(await serena.tool("find_symbol", params));
	if (!hits.length && name.includes("/")) {
		// Rust methods sit under "impl Owner", so Owner/name finds nothing: search the name and keep the owner's.
		const owner = name.split("/").slice(-2, -1)[0];
		hits = JSON.parse(await serena.tool("find_symbol", { ...params, name_path_pattern: lastSegment(name) })).filter((h) => ownerMatches(h.name_path, owner));
	}
	return hits;
}

function bodyLines(hit) {
	const lines = String(hit.body ?? "").split("\n");
	const start = (hit.body_location?.start_line ?? 0) + 1;
	const out = lines.slice(0, MAX_BODY_LINES).map((l, i) => `${String(start + i).padStart(6)}  ${l}`);
	if (lines.length > MAX_BODY_LINES) out.push(`  ... ${lines.length - MAX_BODY_LINES} more lines: read ${hit.relative_path} with offset ${start + MAX_BODY_LINES}`);
	return out;
}

export async function serenaOutline(serena, files) {
	const out = [];
	for (const file of files) {
		const relative = relTo(serena.root, file);
		const symbols = await serena.outline(relative);
		out.push(`${relative} (${symbols.length} top-level symbols)`, ...outlineLines(symbols));
	}
	return out.join("\n");
}

export async function serenaFind(serena, name, target, opts = {}) {
	const hits = (await findSymbols(serena, name, target ? relTo(serena.root, target) : "", !!opts.body)).filter((h) => kindOk(h.kind, opts.kind));
	if (!hits.length) return `no definition of ${name} found by Serena (try a shorter name, Owner/name, or grep for the literal text)`;
	const out = [`${hits.length} definition${hits.length === 1 ? "" : "s"} of ${name}`];
	hits.forEach((h, i) => {
		out.push(`${h.relative_path}:${range(h.body_location)}  ${h.kind.toLowerCase()}  ${h.name_path}`);
		if (opts.body && i < 5) out.push(...bodyLines(h));
	});
	if (opts.body && hits.length > 5) out.push("bodies shown for the first 5; narrow with a path or Owner/name");
	return out.join("\n");
}

export async function serenaRefs(serena, name, target) {
	const hits = await findSymbols(serena, name, target ? relTo(serena.root, target) : "", false);
	if (!hits.length) return `no definition of ${name} found by Serena, so no references (grep finds the literal text)`;
	if (hits.length > 1) return [`${name} is defined ${hits.length} times; pass the file or use Owner/name:`, ...hits.map((h) => `${h.relative_path}:${range(h.body_location)}  ${h.kind.toLowerCase()}  ${h.name_path}`)].join("\n");
	const [def] = hits;
	const found = JSON.parse(await serena.tool("find_referencing_symbols", { name_path: def.name_path, relative_path: def.relative_path, max_answer_chars: MAX_ANSWER_CHARS }));
	const out = [];
	for (const [file, byKind] of Object.entries(found)) {
		for (const refs of Object.values(byKind)) {
			for (const ref of refs) {
				const marked = /^\s*>\s*(\d+):(.*)$/m.exec(String(ref.content_around_reference ?? ""));
				out.push(`${file}:${marked ? Number(marked[1]) + 1 : "?"}  [${ref.name_path}]  ${marked ? marked[2].trim().slice(0, 160) : ""}`);
			}
		}
	}
	if (!out.length) return `no references to ${def.name_path} (${def.relative_path}) found by Serena`;
	return [`${out.length} reference${out.length === 1 ? "" : "s"} to ${def.name_path} (${def.relative_path}:${range(def.body_location)})`, ...out].join("\n");
}

/** Stop the server this skill started (recorded pid, still answering with this machine's Serena secret). */
export async function stopServer() {
	const stateFile = path.join(STATE_DIR, `server-${port()}.json`);
	let pid;
	try { pid = JSON.parse(fs.readFileSync(stateFile, "utf8")).pid; } catch { /* no record */ }
	if (!(await alive())) {
		fs.rmSync(stateFile, { force: true });
		return `No Serena server is running on 127.0.0.1:${port()}; the next query starts one.`;
	}
	if (!Number.isInteger(pid)) return `A Serena server answers on 127.0.0.1:${port()}, but this skill has no record of starting it; stop it yourself.`;
	try { process.kill(pid); } catch (error) { return `Could not stop the Serena server (pid ${pid}): ${error.message}`; }
	for (let i = 0; i < 20 && (await alive()); i++) await new Promise((r) => setTimeout(r, 500));
	fs.rmSync(stateFile, { force: true });
	return `Stopped the Serena server (pid ${pid}); the next query starts a fresh one with new language servers.`;
}

// ---- Fallback.
function heuristic(command, args, opts, reason, cwd) {
	const note = `[heuristic parser, not Serena: ${reason}]`;
	if (command === "outline") {
		const unsupported = args.filter((f) => !langOf(f));
		if (unsupported.length) return `${note}\n${unsupported.join(", ")}: the heuristic parser reads only Rust, TypeScript/JavaScript and Python; use read with offset/limit`;
		return `${note}\n${heuristicOutline(args)}`;
	}
	const name = args[0];
	const targets = args.length > 1 ? args.slice(1) : [cwd];
	if (command === "find") return `${note}\n${heuristicFind(name, targets, opts)}`;
	return `${note}\n${heuristicRefs(name.split("/").pop(), targets)}`;
}

const USAGE = `usage:
  node serena.mjs outline <file>...
  node serena.mjs find <Name or Owner/name> [path] [--body] [--kind <kind>]
  node serena.mjs refs <name or Owner/name> [path]
  node serena.mjs status
  node serena.mjs stop`;

export async function main(argv, cwd = process.cwd()) {
	const [command, ...rest] = argv;
	const kindAt = rest.indexOf("--kind");
	const opts = { body: rest.includes("--body"), kind: kindAt >= 0 ? rest[kindAt + 1] : undefined };
	const words = rest.filter((a, i) => a !== "--body" && a !== "--kind" && !(kindAt >= 0 && i === kindAt + 1));
	// Paths resolve against the caller's folder; the first word of find and refs is a name.
	const args = words.map((a, i) => (command === "outline" || i > 0 ? path.resolve(cwd, a) : a));
	if (command === "stop") return stopServer();
	if (command === "status") {
		const python = serenaPython();
		const root = projectRoot(cwd);
		return [`Serena: ${python ?? "not installed (uv tool install serena-agent)"}`, `server on 127.0.0.1:${port()}: ${(await alive()) ? "running" : "not running (starts on first query)"}`,
			`project ${root}: ${fs.existsSync(path.join(root, ".serena", "project.yml")) ? "set up (.serena/project.yml)" : "not set up yet"}`].join("\n");
	}
	if (!["outline", "find", "refs"].includes(command) || !args.length) throw new Error(USAGE);
	const root = projectRoot(cwd);
	for (const p of command === "outline" ? args : args.slice(1)) if (!insideRoot(root, p)) throw new Error(`${p} is outside the project ${root}; run from the candidate root`);
	const fallback = (reason) => heuristic(command, args, opts, reason, cwd);
	let serena;
	try { serena = await connect(cwd); } catch (error) {
		if (error instanceof Unavailable) return fallback(error.message);
		throw error;
	}
	try {
		if (command === "outline") return await serenaOutline(serena, args);
		if (command === "find") return await serenaFind(serena, args[0], args[1], opts);
		return await serenaRefs(serena, args[0], args[1]);
	} catch (error) {
		if (error instanceof Unavailable || error?.name === "TimeoutError" || error?.cause?.code === "ECONNREFUSED") return fallback(error.message || String(error));
		return `Serena error: ${error.message}`;
	}
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) {
	main(process.argv.slice(2)).then((text) => process.stdout.write(`${text}\n`), (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
