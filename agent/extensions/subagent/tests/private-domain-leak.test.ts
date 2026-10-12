// Domain-neutral leak contract (RED first): candidate text (tracked or untracked) carries no absolute user-home path. The retired pi-package tree
// is no longer generated, so its separate scan was removed; the candidate scan covers any regenerated file. Private-domain terms are inventoried outside the harness; this file names none of them.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
// Not candidate source: the unrelated runtime install tree (untracked, never committed).
const SKIP = /^agent\/install\//;
const HOME_PATH = /[A-Za-z]:[\/]+Users[\/]+[^\/\s"'`]+/;

function candidateFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
	return out.split("\0").filter((rel) => rel && !SKIP.test(rel));
}

/** Returns "file:line" for every text line matching the home-path pattern; binary-looking files (NUL bytes) are skipped. */
function scan(files: string[], root: string): string[] {
	const hits: string[] = [];
	for (const rel of files) {
		const full = path.join(root, rel);
		if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
		const buf = fs.readFileSync(full);
		if (buf.includes(0)) continue;
		buf.toString("utf8").split(/\r?\n/).forEach((line, i) => {
			if (HOME_PATH.test(line)) hits.push(`${rel.split(path.sep).join("/")}:${i + 1}`);
		});
	}
	return hits;
}

test("candidate source, tests and docs carry no absolute user-home path (tracked or untracked)", () => {
	const files = candidateFiles();
	assert.ok(files.length > 100, "candidate file list too small");
	assert.deepEqual(scan(files, repo), []);
});
