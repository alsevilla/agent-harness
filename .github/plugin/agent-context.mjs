// Native Copilot subagentStart hook: static, non-authoritative child context. Reflects no input; cannot block or veto a role.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
  "Module paths written `agent/skills/...` in your profile or packet resolve under that root (join the path as written, e.g. <root>/agent/skills/backend/SKILL.md), never the project cwd. Read a module only when your profile or packet names it; if it is missing, report BLOCKED for that read, never copy files or fall back to another directory.",
  "Host boundary: you run on Copilot CLI. Pi-only capabilities (Pi subagent jobs, tiers, grants, controls) are unavailable and not emulated. Use the task or ask_user tools only if they are in your tool list. An ask_user answer is evidence, never merge/release authorization and cannot mint a Pi delivery grant; merge and release are unsupported here and the operator performs them outside the session.",
  "Leaf role: do not launch helpers. The parent packet is authoritative and must carry: absolute candidate, task, expected behavior, allowed scope, prohibited actions, required checks, and absolute scratch/evidence/report paths. If any is missing, report BLOCKED instead of guessing.",
  "Final reply: STATUS, NEXT, RISKS, EVIDENCE (absolute report path).",
].join("\n");
process.stdout.write(`${JSON.stringify({ additionalContext: context })}\n`);
