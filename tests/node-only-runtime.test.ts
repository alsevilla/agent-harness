// Node-only production contract: first-party launch and monitor code carry no Bun compatibility (no hidden fallback).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { hostModules } from "../agent/extensions/subagent/tests/host-modules.ts";

// monitor.ts imports the Pi packages by bare name: map them to the installed host build, as monitor-scrollbar.test.ts does.
const host = hostModules(["@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"]);
const pkg = (path: string) => pathToFileURL(join(host, "@earendil-works", path)).href;
registerHooks({
	resolve(specifier: string, context: object, nextResolve: (s: string, c: object) => { url: string }) {
		if (specifier === "@earendil-works/pi-tui") return { url: pkg("pi-tui/dist/index.js"), shortCircuit: true };
		if (specifier === "@earendil-works/pi-coding-agent") return { url: pkg("pi-coding-agent/dist/index.js"), shortCircuit: true };
		return nextResolve(specifier, context);
	},
} as never);
const { WorkerStore } = await import("../agent/extensions/subagent/monitor.ts");

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("child launch detection recognises only the Node executable and no Bun virtual script", () => {
	const source = read("agent/extensions/subagent/index.ts");
	const start = source.indexOf("function getPiInvocation");
	const body = source.slice(start, source.indexOf("\n}\n", start));
	assert.ok(start > 0 && body.length > 0, "getPiInvocation found");
	assert.match(body, /\^node\(\\.exe\)\?\$/); // Node paths are preserved
	assert.doesNotMatch(body, /bun/i);
});

test("provider cooldown comment no longer describes Bun behavior", () => {
	assert.doesNotMatch(read("agent/extensions/subagent/provider-cooldown.ts"), /\bBun\b/);
});

test("the monitor labels Graphify through npx and uvx wrappers but not bunx", () => {
	const store = new WorkerStore();
	const label = (command: string) => {
		const record = store.begin("w", "t", "m", "e");
		store.event(record.id, { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command } });
		return record.tools[0].integration;
	};
	assert.equal(label("npx graphify query x"), "graphify");
	assert.equal(label("uvx graphify query x"), "graphify");
	assert.equal(label("graphify query x"), "graphify");
	assert.equal(label("bunx graphify query x"), undefined);
});
