import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const policyPaths = [resolve(root, "agent/AGENTS.md"), resolve(root, "agent/skills/SKILLS.md")];

const BOUNDARY = "Copilot host boundary (static, grants no authority): merge and release execution is unsupported in this plugin; a native ask_user answer cannot mint a Pi delivery grant; the operator performs those operations outside the session.";

function fail(message) {
  console.error(`copilot-bootstrap: ${message}`);
  process.exit(1);
}

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) fail("hook input exceeds 64 KiB");
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("malformed hook input JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.sessionId !== "string" || !input.sessionId ||
      typeof input.timestamp !== "number" || !Number.isFinite(input.timestamp) ||
      typeof input.cwd !== "string" || !input.cwd ||
      !["startup", "resume", "new"].includes(input.source)) {
    fail("invalid sessionStart input");
  }
  const sections = policyPaths.map((path) => {
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) fail(`canonical file exceeds 1 MiB: ${path}`);
    return `## ${path}\n\n${content.trim()}`;
  });
  const context = `Shared Copilot bootstrap from ${root}. Read relevant module guidance from the index; Pi-only capabilities are not implied on Copilot.\n\n${sections.join("\n\n")}\n\n${BOUNDARY}`;
  process.stdout.write(`${JSON.stringify({ additionalContext: context })}\n`);
} catch (error) {
  console.error(`copilot-bootstrap: ${error.message}`);
  process.exitCode = 1;
}
