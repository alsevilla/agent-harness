#!/usr/bin/env node
// QMD for any host (Pi workers, GitHub Copilot CLI, by hand): one shell command instead of the Pi-only qmd_search/qmd_get/qmd_status
// tools. Same bounds as the Pi extension (agent/extensions/qmd): BM25 search, 3 hits by default and at most 5, no snippets; get reads at
// most 100 lines with a 10,000-character preview, the full received output saved to a temp file when cut; status inspects the index.
// Read-only: no update, embed, init or cleanup command is passed through. Missing QMD is a note and exit 0, so a run never loops on it.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PREVIEW = 10_000;
const MAX_STDOUT = 256_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", ".."); // agent/skills/qmd/scripts -> repository (or profile) root
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** Where QMD is: HARNESS_QMD_CLI, then the Pi extension's config.json (this checkout, then the Pi profile), then the global npm install. */
export function resolveQmd(env = process.env, opts = {}) {
	const timeoutMs = Number(env.HARNESS_QMD_TIMEOUT_MS) > 0 ? Number(env.HARNESS_QMD_TIMEOUT_MS) : undefined;
	if (env.HARNESS_QMD_CLI) {
		if (!isFile(env.HARNESS_QMD_CLI)) return { missing: `HARNESS_QMD_CLI does not name a file: ${env.HARNESS_QMD_CLI}` };
		return { node: env.HARNESS_QMD_NODE || process.execPath, cli: env.HARNESS_QMD_CLI, index: env.HARNESS_QMD_INDEX || "index", timeoutMs: timeoutMs ?? 15_000, source: "HARNESS_QMD_CLI" };
	}
	const configs = opts.configs ?? [path.join(repoRoot, "agent", "extensions", "qmd", "config.json"), path.join(opts.agentDir ?? agentDir, "extensions", "qmd", "config.json")];
	for (const file of configs) {
		const c = readJson(file);
		if (c && typeof c.cliPath === "string" && isFile(c.cliPath)) {
			const node = typeof c.nodePath === "string" && isFile(c.nodePath) ? c.nodePath : process.execPath;
			return { node, cli: c.cliPath, index: env.HARNESS_QMD_INDEX || c.indexName || "index", timeoutMs: timeoutMs ?? (Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 15_000), source: file };
		}
	}
	const root = opts.npmRoot !== undefined ? opts.npmRoot : (() => {
		const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000, windowsHide: true, shell: process.platform === "win32" });
		return r.status === 0 ? r.stdout.trim() : "";
	})();
	const cli = root ? path.join(root, "@tobilu", "qmd", "dist", "cli", "qmd.js") : "";
	if (cli && isFile(cli)) return { node: process.execPath, cli, index: env.HARNESS_QMD_INDEX || "index", timeoutMs: timeoutMs ?? 15_000, source: "npm root -g" };
	return { missing: "QMD is not installed or not configured (npm install -g @tobilu/qmd, or set HARNESS_QMD_CLI)" };
}

function run(q, args, cwd) {
	return new Promise((resolve, reject) => {
		// An explicit named index bypasses QMD's cwd-dependent .qmd config discovery; arguments go without a shell.
		const child = spawn(q.node, [q.cli, "--index", q.index, ...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => { child.kill(); reject(new Error(`QMD did not answer within ${q.timeoutMs} ms.`)); }, q.timeoutMs);
		child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > MAX_STDOUT) { child.kill(); reject(new Error("QMD output exceeded the retrieval limit.")); } });
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`QMD exited ${code}: ${stderr.trim()}`)); });
	});
}

/** Text over the preview limit: the first 10,000 characters, and the whole output saved to a new temp file the caller can read. */
export function capped(text, tmp = os.tmpdir()) {
	if (text.length <= PREVIEW) return text;
	const file = path.join(tmp, `harness-qmd-${randomBytes(8).toString("hex")}.txt`);
	fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
	return `${text.slice(0, PREVIEW)}\n[QMD output cut at ${PREVIEW.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters; the full output is in ${file}; read it with offset and limit if you need more]`;
}

const USAGE = `Usage:
  node qmd.mjs search <query> [-c <collection>] [-n <1-5>]
  node qmd.mjs get <file or #docid> [from-line] [lines<=100]
  node qmd.mjs status`;

export async function main(argv, env = process.env, cwd = process.cwd(), out = (s) => process.stdout.write(`${s}\n`)) {
	const [command, ...rest] = argv;
	if (!["search", "get", "status"].includes(command ?? "")) { out(USAGE); return command === "--help" || command === "help" ? 0 : 2; }
	const q = resolveQmd(env);
	if (q.missing) { out(`[qmd unavailable: ${q.missing}] Skip the prior-decision lookup and continue with Serena, read and grep.`); return 0; }
	try {
		if (command === "search") {
			const words = [];
			let collection, count = 3;
			for (let i = 0; i < rest.length; i++) {
				if (rest[i] === "-c") collection = rest[++i];
				else if (rest[i] === "-n") count = Math.min(5, Math.max(1, Number.parseInt(rest[++i] ?? "3", 10) || 3));
				else words.push(rest[i]);
			}
			const query = words.join(" ").trim();
			if (!query) { out(USAGE); return 2; }
			const args = ["search", query, "-n", String(count), "--format", "json", ...(collection ? ["-c", collection] : [])];
			const raw = await run(q, args, cwd);
			const parsed = raw.trim() === "No results found." ? [] : JSON.parse(raw);
			if (!Array.isArray(parsed)) throw new Error("Unexpected QMD search response.");
			const results = parsed.slice(0, count).map(({ docid, score, file, title, line }) => ({ docid, score, file, title, line }));
			out(JSON.stringify({ backend: "qmd", method: "BM25", collection, resultCount: results.length, results }));
			if (results.length) out(`Read a hit with: node "${fileURLToPath(import.meta.url)}" get <file or #docid> [from-line] [lines]`);
			return 0;
		}
		if (command === "get") {
			const [document, from, lines] = rest;
			if (!document) { out(USAGE); return 2; }
			const first = Math.max(1, Number.parseInt(from ?? "1", 10) || 1);
			const count = Math.min(100, Math.max(1, Number.parseInt(lines ?? "40", 10) || 40));
			out(capped(await run(q, ["get", `${document}:${first}:${count}`], cwd)));
			return 0;
		}
		out(capped(await run(q, ["status"], cwd)));
		return 0;
	} catch (error) {
		out(`[qmd failed: ${error instanceof Error ? error.message : String(error)}] Continue with Serena, read and grep.`);
		return 0;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
