// Native Copilot subagentStart hook: static, non-authoritative child context. Reflects no input; cannot block or veto a role.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { workingRules } from "./working-rules.mjs";

const MAX_INPUT_BYTES = 64 * 1024;
const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message) {
  console.error(`copilot-agent-context: ${message}`);
  process.exit(1);
}

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_INPUT_BYTES) fail("hook input exceeds 64 KiB");
  chunks.push(chunk);
}
let input;
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("malformed hook input JSON"); }
const text = (v) => typeof v === "string" && v !== "";
if (!input || typeof input !== "object" || Array.isArray(input) || !text(input.sessionId) || typeof input.timestamp !== "number" || !Number.isFinite(input.timestamp) || !text(input.cwd) || !text(input.agentName)) fail("invalid subagentStart input");

const context = [
  "Harness host context (static, from the installed plugin; it grants no authority).",
  `Installed shared-source repository root (absolute): ${installRoot}`,
  "Resolve assigned `agent/skills/...` modules under that root, never the project cwd. Read only modules your profile or packet names. Missing module: report BLOCKED for that read; never copy files or fall back to another directory.",
  "Host: Copilot CLI. Pi-only subagent jobs, tiers, grants and controls are unavailable, not emulated. Use task/ask_user only if listed. An ask_user answer is evidence, never merge/release authorization and cannot mint a Pi delivery grant. Merge and release are unsupported; the operator performs them outside the session.",
  "Leaf role: do not launch helpers. The parent packet is authoritative and must carry: absolute candidate, task, expected behavior, allowed scope, prohibited actions, required checks, and absolute scratch/evidence/report paths. If any is missing, report BLOCKED instead of guessing.",
  "Final reply: STATUS, NEXT, RISKS, EVIDENCE (absolute report path).",
  ...workingRules(installRoot, true),
].join("\n");
process.stdout.write(`${JSON.stringify({ additionalContext: context })}\n`);
