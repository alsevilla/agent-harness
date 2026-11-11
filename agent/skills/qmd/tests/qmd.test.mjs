// The qmd skill: QMD through one shell command on any host (Copilot CLI included), with the Pi extension's bounds.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { capped, main, resolveQmd } from "../scripts/qmd.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qmd-skill-"));
const log = path.join(dir, "args.json");
const fake = path.join(dir, "qmd.js");
fs.writeFileSync(fake, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
const cmd = args[2];
if (cmd === "search") process.stdout.write(JSON.stringify([1,2,3,4,5,6].map((n) => ({ docid: "#d" + n, score: 1 / n, file: "docs/n" + n + ".md", title: "T" + n, line: n, snippet: "never shown" }))));
else if (cmd === "get") process.stdout.write("x".repeat(12000));
else if (cmd === "status") process.stdout.write("collections: 2");
else { process.stderr.write("unknown"); process.exit(3); }
`);
const env = { HARNESS_QMD_CLI: fake, HARNESS_QMD_INDEX: "harness" };
const collect = async (argv, e = env) => { const lines = []; const code = await main(argv, e, dir, (s) => lines.push(s)); return { code, text: lines.join("\n") }; };

test("search: the named index, at most 5 hits, no snippets, and how to read one", async () => {
	const { code, text } = await collect(["search", "sms", "queue", "pacing", "-n", "9", "-c", "decisions"]);
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), ["--index", "harness", "search", "sms queue pacing", "-n", "5", "--format", "json", "-c", "decisions"]);
	const result = JSON.parse(text.split("\n")[0]);
	assert.equal(result.resultCount, 5);
	assert.equal("snippet" in result.results[0], false);
	assert.match(text, /Read a hit with: node ".*qmd\.mjs" get/);
});

test("get: at most 100 lines; output over 10,000 characters is cut with the full text on disk; status passes through", async () => {
	const { text } = await collect(["get", "#d1", "20", "500"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")).slice(2), ["get", "#d1:20:100"]);
	const saved = /the full output is in (\S+);/.exec(text)[1];
	assert.equal(fs.readFileSync(saved, "utf8").length, 12_000);
	assert.ok(text.startsWith("x".repeat(10_000) + "\n[QMD output cut at 10,000 of 12,000 characters"));
	assert.equal(capped("short"), "short");
	assert.equal((await collect(["status"])).text, "collections: 2");
});

test("missing or failing QMD is a one-line note and exit 0; bad usage exits 2; read-only commands only", async () => {
	const missing = await collect(["search", "x"], { HARNESS_QMD_CLI: path.join(dir, "nope.js") });
	assert.equal(missing.code, 0);
	assert.match(missing.text, /^\[qmd unavailable: HARNESS_QMD_CLI does not name a file: .*\] Skip the prior-decision lookup/);
	assert.match(resolveQmd({}, { configs: [], npmRoot: "" }).missing, /not installed or not configured/);
	for (const argv of [["update"], ["embed"], [], ["search"]]) assert.equal((await collect(argv)).code, 2, argv.join(" "));
});

test("the Pi extension's config.json is used when HARNESS_QMD_CLI is unset", () => {
	const cfg = path.join(dir, "config.json");
	fs.writeFileSync(cfg, JSON.stringify({ nodePath: path.join(dir, "no-node"), cliPath: fake, timeoutMs: 9000, indexName: "notes" }));
	const q = resolveQmd({}, { configs: [cfg], npmRoot: "" });
	assert.deepEqual([q.cli, q.index, q.timeoutMs, q.node], [fake, "notes", 9000, process.execPath], "a missing nodePath falls back to this Node");
});

test("a global QMD install works without any extension config", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "qmd-global-"));
	try {
		const cli = path.join(root, "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(cli), { recursive: true });
		fs.writeFileSync(cli, "");
		const q = resolveQmd({}, { configs: [], npmRoot: root });
		assert.equal(q.cli, cli);
		assert.equal(q.source, "npm root -g");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
