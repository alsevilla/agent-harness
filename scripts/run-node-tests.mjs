#!/usr/bin/env node
// Canonical Node-only test entrypoint: `npm test` / `node scripts/run-node-tests.mjs`.
// Discovers every *.test.ts/*.test.mjs and *.node.ts runtime suite by walking the tree (no shell globs, so Bash and PowerShell behave alike),
// then runs them in one `node --test` process. The core harness (routing evaluator, agent creation) is Node-only; optional Graphify/UI-UX Python utilities are not core.
//   node scripts/run-node-tests.mjs            run everything
//   node scripts/run-node-tests.mjs --list     print the discovered files and the wrapper-covered exclusions, run nothing
//   node scripts/run-node-tests.mjs <file...>  run only the named discovered files (repo-relative)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".serena"]);
// Several suites spawn Node/git children under fixed timeouts (8 s in dag-runtime); full CPU fan-out starves them, so files run 4 at a time unless overridden.
const CONCURRENCY = process.env.NODE_TEST_FILE_CONCURRENCY || "4";
const TEST_FILE = /\.(?:test\.(?:ts|mjs)|node\.ts)$/;

/** Runtime suites that a *.test.ts wrapper already launches as a child process (with its own pass-count guard): running them here too would duplicate the work. */
export const WRAPPED = { "agent/extensions/subagent/tests/fallback-runtime.node.ts": "agent/extensions/subagent/tests/fallback-runtime.test.ts" };

export function discoverTests(root = ROOT) {
	const found = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); }
			else if (TEST_FILE.test(entry.name)) found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
		}
	};
	walk(root);
	return found.sort();
}

/** Split discovered files into the ones this runner executes and the wrapper-covered ones; a wrapper that no longer names its suite is an error, never a silent omission. */
export function plan(files, root = ROOT) {
	const covered = [];
	for (const [suite, wrapper] of Object.entries(WRAPPED)) {
		if (!files.includes(suite)) continue;
		if (!files.includes(wrapper) || !fs.readFileSync(path.join(root, wrapper), "utf8").includes(path.posix.basename(suite))) throw new Error(`${suite} is excluded as wrapper-covered, but ${wrapper} is missing or does not launch it`);
		covered.push(suite);
	}
	return { run: files.filter((f) => !covered.includes(f)), covered };
}

function main(argv) {
	const files = discoverTests();
	const { run, covered } = plan(files);
	if (argv.includes("--list")) {
		console.log(run.join("\n"));
		for (const suite of covered) console.log(`# not run directly (covered by ${WRAPPED[suite]}): ${suite}`);
		return 0;
	}
	const selected = argv.length ? argv.map((a) => a.replaceAll("\\", "/").replace(/^\.\//, "")) : run;
	const unknown = selected.filter((f) => !files.includes(f));
	if (unknown.length) { console.error(`not a discovered test file: ${unknown.join(", ")}`); return 2; }
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT; // a parent node --test would make this run emit machine output
	const result = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--test", `--test-concurrency=${CONCURRENCY}`, ...selected], { cwd: ROOT, env, stdio: "inherit" });
	if (result.error) { console.error(result.error.message); return 1; }
	return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
