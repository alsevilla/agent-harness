// Field report: workers never called the installed Serena, QMD or Graphify and searched with grep/find. The tools were active (verified with
// Pi 1.5.0); the first broad search of a run that has not used them now gets one appended line naming them. Nothing is ever blocked.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { createLookupNudge, isBroadSearch, isLookupCall, launchLookupTools, lookupNudgeText } from "../lookup-nudge.ts";

const out = (text = "src/sms.rs:12: fn queue") => [{ type: "text", text }];
const all = { serena: true, qmd: true, graph: true };

test("broad searches: find, grep over a folder, recursive shell searches; a single named file is not", () => {
	for (const [tool, input] of [["find", { pattern: "*.rs" }], ["grep", { pattern: "Sms" }], ["grep", { pattern: "Sms", path: "backend/src" }],
		["bash", { command: "rg -n SmsQueue backend" }], ["bash", { command: "grep -rn SmsQueue ." }], ["bash", { command: "find . -name '*.tsx'" }],
		["powershell", { command: "Get-ChildItem -Recurse -Filter *.tsx" }], ["powershell", { command: "Select-String -Pattern Sms -Path src -Recurse" }]] as const) {
		assert.equal(isBroadSearch(tool, input), true, `${tool} ${JSON.stringify(input)}`);
	}
	for (const [tool, input] of [["grep", { pattern: "Sms", path: "backend/src/sms.rs" }], ["bash", { command: "grep -n Sms backend/src/sms.rs" }],
		["bash", { command: "npm test" }], ["read", { path: "a.ts" }], ["bash", { command: "git grep -n x" }]] as const) {
		assert.equal(isBroadSearch(tool, input), false, `${tool} ${JSON.stringify(input)}`);
	}
});

test("lookup calls: serena_, qmd_, graphify_ tools and the read_graph.py helper", () => {
	assert.equal(isLookupCall("serena_find_symbol", {}), true);
	assert.equal(isLookupCall("qmd_search", {}), true);
	assert.equal(isLookupCall("bash", { command: "python3 /a/skills/graphify/scripts/read_graph.py query --query Sms" }), true);
	assert.equal(isLookupCall("powershell", { command: "py C:\\a\\graphify\\scripts\\read_graph.py path --from A --to B" }), true);
	assert.equal(isLookupCall("bash", { command: "grep -rn x ." }), false);
});

test("the first broad search of a run without lookups gets one appended line; once only; nothing after a lookup or without tools", () => {
	const n = createLookupNudge(all);
	assert.equal(n.onResult("read", { path: "a.ts" }, out(), false), undefined, "not a search");
	const first = n.onResult("grep", { pattern: "Sms", path: "backend" }, out(), false)!;
	assert.equal(first.length, 2, "the result is kept and one line appended");
	assert.equal(first[0].text, "src/sms.rs:12: fn queue");
	assert.match(first[1].text!, /^\[harness\] This launch has the graph \(the graphify skill's read_graph\.py helper, or the listed graph report\), qmd_search for prior decisions and specs, Serena \(find symbol, symbols overview, references\) for definitions and callers, and none has been used yet\. For code the packet does not locate, use them before broad grep or find; keep grep for literal text, config and renames\.$/);
	assert.equal(n.onResult("find", { pattern: "*.rs" }, out(), false), undefined, "once per run");

	const used = createLookupNudge(all);
	used.onResult("serena_find_symbol", { name_path: "SmsWorker" }, out(), false);
	assert.equal(used.onResult("bash", { command: "rg -n Sms ." }, out(), false), undefined, "a lookup was already used");

	assert.equal(createLookupNudge({ serena: false, qmd: false, graph: false }).onResult("find", {}, out(), false), undefined, "no lookup tools in this launch");
	assert.equal(createLookupNudge(all).onResult("grep", { pattern: "x" }, out(), true), undefined, "errors are left alone");
	assert.equal(lookupNudgeText({ serena: true, qmd: false, graph: false }), "[harness] This launch has Serena (find symbol, symbols overview, references) for definitions and callers, and none has been used yet. For code the packet does not locate, use them before broad grep or find; keep grep for literal text, config and renames.", "names only what the launch has");
});

test("launch lookup tools come from the active tools and the launch arguments; the worker entry wires the nudge", () => {
	assert.deepEqual(launchLookupTools(["read", "serena_find_symbol", "qmd_search"], ["node", "pi"]), { serena: true, qmd: true, graph: false });
	assert.deepEqual(launchLookupTools(["read"], ["--skill", "C:\\agent\\skills\\graphify\\SKILL.md"]), { serena: false, qmd: false, graph: true });
	const entry = fs.readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /nudge \?\?= createLookupNudge\(launchLookupTools\(pi\.getActiveTools\(\)\)\)/);
	assert.doesNotMatch(fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"), /lookup-nudge/, "workers only");
});
