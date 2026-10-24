// Launcher for the ordered-fallback runtime regression: it runs the hook-heavy suite (fallback-runtime.node.ts) in a child Node
// and guards its exact pass count. The canonical runner (scripts/run-node-tests.mjs) therefore does not also run that file directly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(testsDir, "fallback-runtime.node.ts");

interface NodeRun {
	status: number | null;
	signal: string | null;
	output: string;
	error?: Error;
}

function runUnderNode(): Promise<NodeRun> {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT; // inherited from a parent node --test would make the child emit TAP
	return new Promise((resolve) => {
		let output = "";
		const child = spawn(process.execPath, ["--experimental-transform-types", "--test", runner], { cwd: testsDir, env, timeout: 120_000, windowsHide: true });
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		child.on("error", (error) => resolve({ status: null, signal: null, output, error }));
		child.on("close", (status, signal) => resolve({ status, signal, output }));
	});
}

test("ordered fallback runtime regression passes under installed Node", { timeout: 150_000 }, async () => {
	const result = await runUnderNode();
	const output = result.output.trim();
	assert.equal(result.error, undefined, `failed to launch "node --test ${runner}" (cwd ${testsDir}): ${result.error?.message}\n${output}`);
	assert.equal(result.status, 0, `"node --test ${runner}" exited with ${result.status ?? result.signal}\n${output}`);
	// Pass count guards against a runner that loads cleanly but silently loses discovery/guard coverage (35 tests today: 20 prior (11 fallback-chain/abort/usage-chain, 4 discovery, 5 provider-cooldown), 7 guard-refusal, probe-busy, unavailable and pre-spawn-abort proofs, plus 8 all-job usage ledger proofs, plus 4 explicit modelSlot fallback proofs, plus 13 requested-vs-observed provenance and launched-attempt proofs).
	assert.match(output, /(?:\u2139|#) pass 52\b/, `expected 52 passing runtime tests\n${output}`);
});
