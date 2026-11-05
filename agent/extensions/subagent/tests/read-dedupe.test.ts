// Duplicate-read skip (Ledger 2608.00808, CORVUS 2607.22711): an unchanged repeat read becomes a note; everything else passes.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { createReadDedupe, duplicateReadNote } from "../read-dedupe.ts";

const text = (t: string) => [{ type: "text", text: t }];
const cwd = "/w/app";

test("a repeat read of unchanged text becomes a one-line note; the first read and changed text pass through", () => {
	const d = createReadDedupe();
	assert.equal(d.onResult("read", { path: "src/a.ts" }, text("one"), false, cwd), undefined, "first read kept");
	assert.deepEqual(d.onResult("read", { path: "src/a.ts" }, text("one"), false, cwd), text(duplicateReadNote("src/a.ts")));
	assert.deepEqual(d.onResult("read", { path: "/w/app/src/a.ts" }, text("one"), false, cwd), text(duplicateReadNote("/w/app/src/a.ts")), "relative and absolute name the same file");
	assert.equal(d.onResult("read", { path: "src/a.ts" }, text("two"), false, cwd), undefined, "changed content (for example after a shell edit) is kept");
	assert.deepEqual(d.onResult("read", { path: "src/a.ts" }, text("two"), false, cwd), text(duplicateReadNote("src/a.ts")), "and the new text is what later repeats compare with");
	assert.match(duplicateReadNote("src/a.ts"), /^\[unchanged: .*src\/a\.ts \(same range\); use that earlier copy/);
});

test("another range, errors, images, other tools and missing paths pass through", () => {
	const d = createReadDedupe();
	d.onResult("read", { path: "a.ts" }, text("x"), false, cwd);
	assert.equal(d.onResult("read", { path: "a.ts", offset: 40, limit: 20 }, text("x"), false, cwd), undefined, "a different range is its own read");
	assert.ok(d.onResult("read", { path: "a.ts", offset: 40, limit: 20 }, text("x"), false, cwd), "the same range repeats");
	assert.equal(d.onResult("read", { path: "a.ts" }, text("x"), true, cwd), undefined, "an error result is never replaced");
	const image = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
	assert.equal(d.onResult("read", { path: "shot.png" }, image, false, cwd), undefined);
	assert.equal(d.onResult("read", { path: "shot.png" }, image, false, cwd), undefined, "images always pass (the model must see them)");
	assert.equal(d.onResult("bash", { command: "cat a.ts" }, text("x"), false, cwd), undefined);
	assert.equal(d.onResult("read", {}, text("x"), false, cwd), undefined);
	assert.equal(d.onResult("read", { path: "a.ts" }, [], false, cwd), undefined);
});

test("an edit or write of the file, and a compaction, forget what was seen", () => {
	const d = createReadDedupe();
	d.onResult("read", { path: "a.ts" }, text("x"), false, cwd);
	d.onResult("edit", { path: "a.ts", oldText: "x", newText: "x" }, text("ok"), false, cwd);
	assert.equal(d.onResult("read", { path: "a.ts" }, text("x"), false, cwd), undefined, "after an edit the next read is kept");
	d.onResult("write", { path: "/w/app/a.ts", content: "x" }, text("ok"), false, cwd);
	assert.equal(d.onResult("read", { path: "a.ts" }, text("x"), false, cwd), undefined, "after a write too");
	d.reset();
	assert.equal(d.onResult("read", { path: "a.ts" }, text("x"), false, cwd), undefined, "after compaction the earlier copy may be gone, so the read is kept");
});

test("only workers load it: the child guard entry wires tool_result and compaction; main's extension does not", () => {
	const entry = fs.readFileSync(new URL("../safety-guard-entry.ts", import.meta.url), "utf8");
	assert.match(entry, /createReadDedupe\(\)/);
	assert.match(entry, /pi\.on\("tool_result"/);
	assert.match(entry, /pi\.on\("session_compact", \(\) => \{ dedupe\.reset\(\); capped = false; compactAsked = false; \}\)/);
	assert.match(entry, /if \(result\.step === "over" && !compactAsked\) \{\s*compactAsked = true;\s*try \{ ctx\?\.compact\?\.\(/, "still over budget after every step: ask the host to compact, once");
	assert.match(entry, /ctx\?\.getSystemPrompt\?\.\(\)/, "the estimate includes the real system prompt");
	assert.match(entry, /if \(capped\) return undefined;/, "once older outputs are masked, the duplicate-read note is off (its earlier copy may be gone)");
	assert.match(entry, /if \(!capped\) \{ capped = true; dedupe\.reset\(\); \}/);
	assert.doesNotMatch(fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8"), /read-dedupe/);
});

// "Does a Language Server Save Tokens for Coding Agents?" (2608.13568): named targets are cheaper to read or grep directly.
test("Serena guidance: read or grep a named file or symbol; grep for renames and every occurrence; Serena for noisy matches or unfamiliar code", () => {
	const source = fs.readFileSync(new URL("../code-integrations.ts", import.meta.url), "utf8");
	assert.match(source, /When the packet names the file or symbol, read or grep it directly\. Use grep for renames and every occurrence: it also finds comments and strings, which symbol references miss\. Use Serena symbol overview, lookup and references when grep matches are noisy \(definitions vs calls\) or to explore unfamiliar code/);
	assert.doesNotMatch(source, /Use Serena[^"]*to find every reference or caller/, "language-server references bought precision, not savings, and missed rename sites");
});
