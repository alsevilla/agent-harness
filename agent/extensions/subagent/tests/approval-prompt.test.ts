// Field report: a merge approval prompt popped up while the operator was typing. Keys typed after a prompt appears go to it, and
// Pi's confirm highlights Yes first, so an Enter meant for the message approved. Harness approvals now list No first.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { approve } from "../approval-prompt.ts";

test("approval prompts list No first: an immediate Enter declines, Yes must be chosen", async () => {
	const seen: Array<{ title: string; options: string[]; opts: unknown }> = [];
	const ui = (pick: (options: string[]) => string | undefined) => ({
		confirm: async () => { throw new Error("confirm must not be used when select exists"); },
		select: async (title: string, options: string[], opts?: unknown) => { seen.push({ title, options, opts }); return pick(options); },
	});
	assert.equal(await approve({ ui: ui((o) => o[0]) }, "Authorize PR merge?", "PR #77", { timeout: 120_000 }), false, "Enter on the highlighted first option declines");
	assert.deepEqual(seen[0], { title: "Authorize PR merge?\nPR #77", options: ["No", "Yes"], opts: { timeout: 120_000 } });
	assert.equal(await approve({ ui: ui(() => "Yes") }, "t", "m"), true);
	assert.equal(await approve({ ui: ui(() => undefined) }, "t", "m"), false, "a timeout or cancel declines");
	assert.equal(await approve({ ui: { confirm: async () => true } }, "t", "m"), true, "a UI without select keeps confirm");
});

test("every harness approval goes through approve", () => {
	const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /ui\.confirm\(/);
	assert.ok((source.match(/await approve\(ctx, /g) ?? []).length >= 4);
});
