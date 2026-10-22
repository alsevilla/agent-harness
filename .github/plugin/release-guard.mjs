// Native Copilot preToolUse guard: DENY-ONLY, best-effort speed bump for merge/release/tag publication via shell tools.
// Not authorization: it never allows or asks, has no env/file override, and cannot see through obfuscation, scripts or direct API clients.
// A hook timeout fails open and plugin hooks can be disabled; the real boundary is user-owned branch protection/rulesets and token scope.
const MAX_INPUT_BYTES = 64 * 1024;
const REASON = "Merge/release is unsupported on Copilot in this harness: no trusted operator approval exists. Do it outside the agent session.";

function fail(message) {
  console.error(`copilot-release-guard: ${message}`);
  process.exit(2);
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
if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.toolName !== "string") fail("invalid preToolUse input");
if (!["bash", "powershell"].includes(input.toolName.toLowerCase())) process.exit(0);

let args = input.toolArgs;
if (typeof args === "string") { try { args = JSON.parse(args); } catch { fail("unparseable shell toolArgs"); } }
if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.command !== "string" || !args.command.trim()) fail("missing shell command");

// Small quote-aware splitter (not a shell interpreter): statements end at ; & | CR LF outside quotes; quoted text stays one inert word.
// Backslash/backtick line continuations are joined. Substitutions, subshells, scripts and obfuscation are not interpreted.
// `#` at a token boundary outside quotes starts a comment to the real line end. Escapes are shell-selected: Bash `` (any char outside quotes; only "  $ ` in double quotes; none in single), PowerShell backtick (backslash is literal).
function parse(text, ps) {
  const out = [];
  let words = [], cur = "", has = false, q = "";
  const endWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const endStmt = () => { endWord(); if (words.length) out.push(words); words = []; };
  const esc = ps ? "`" : "\\"; // each shell's own escape character; the other one is literal
  const eol = (j) => /^\r?\n/.exec(text.slice(j, j + 2));
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = "";
      else if (q === '"' && c === esc && i + 1 < text.length && (ps || '"\\$`'.includes(text[i + 1]) || eol(i + 1))) { const m = ps ? (text[i + 1] === "\n" ? ["\n"] : null) : eol(i + 1); if (m) i += m[0].length; else cur += text[++i]; }
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === esc && i + 1 < text.length) { const m = eol(i + 1); if (m && !(ps && has && m[0].length === 2)) i += m[0].length; /* PS: glued backtick-CRLF escapes the CR, LF then ends the statement */ else { cur += text[++i]; has = true; } }
    else if (c === "#" && !has && !cur) { while (i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") i++; }
    else if (c === "`") { /* Bash substitution marker: dropped */ }
    else if (/[;&|\r\n]/.test(c)) endStmt();
    else if (/\s/.test(c)) endWord();
    else { cur += c; has = true; }
  }
  endStmt();
  return out;
}

const WRITE = new Set(["post", "put", "patch", "delete"]);
const low = (w) => w.toLowerCase();
const exeName = (w) => low(w).replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
const CURL = new Set(["curl", "wget", "invoke-restmethod", "irm", "invoke-webrequest", "iwr"]);
// Explicit HTTP method: -X/--request/--method/-Method (value attached with = or after); the LAST one wins (curl semantics), else "".
function explicitMethod(ws) {
  let method = "";
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], l = low(w);
    if (w === "-X" || ["--method", "-method", "--request"].includes(l)) { method = low(ws[++i] || ""); continue; }
    const m = /^(?:--method|--request)=(.*)$/i.exec(w) || /^-X(.+)$/.exec(w);
    if (m) method = low(m[1]);
  }
  return method;
}
// Method used: explicit one wins; curl -G turns data into a query (GET); data/body/field options imply POST.
function isWrite(ws, gh) {
  const m = explicitMethod(ws);
  if (m) return WRITE.has(m);
  if (ws.some((w) => w === "-G" || low(w) === "--get")) return false;
  return ws.some((w) => /^(?:-[FdT]|--(?:raw-)?field|--input|--data[\w-]*|--json|--form|--upload-file|--post-(?:data|file)|--body-(?:data|file))(?:=|$)/.test(w) || /^-[dFT]./.test(w) || (gh && /^-f$/.test(w)) || /^-(?:body|infile)$/i.test(w));
}
const tagRef = /^\+?(?::?refs\/tags\/.*|.*:refs\/tags\/.*|v?\d+\.\d+\.\d+(?:[-+][\w.]+)?)$/;
// Non-flag words from index `from`; `skip` names options whose next word is a value.
function positional(ws, from, skip) {
  const out = [];
  for (let i = from; i < ws.length; i++) {
    if (ws[i].startsWith("-")) { if (skip.test(ws[i])) i++; } else out.push(ws[i]);
  }
  return out;
}
function protectedStatement(ws) {
  let k = 0;
  while (k < ws.length && /^\w+=/.test(ws[k])) k++;
  ws = ws.slice(k);
  if (!ws.length) return false;
  const exe = exeName(ws[0]);
  if (exe === "gh") {
    const pos = positional(ws, 1, /^(?:-R|--repo|--hostname)$/).map(low);
    if (pos[0] === "pr") return pos[1] === "merge";
    if (pos[0] === "release") return ["create", "edit", "upload", "delete", "delete-asset"].includes(pos[1]);
    if (pos[0] !== "api" || !isWrite(ws, true)) return false;
    return ws.some((w) => /\/merge(?:[?#]|$)|\/releases(?:[/?#]|$)|refs\/tags/i.test(w));
  }
  if (CURL.has(exe)) {
    if (!isWrite(ws)) return false;
    const urls = ws.filter((w) => /api\.github\.com/i.test(w));
    return urls.some((u) => /\/merge(?:[?#]|$)|\/releases(?:[/?#]|$)|\/git\/refs\/tags/i.test(u) || (/\/git\/refs(?:[/?#]|$)/i.test(u) && ws.some((w) => /refs\/tags\//i.test(w))));
  }
  if (exe === "git") {
    let i = 1;
    while (i < ws.length && ws[i].startsWith("-")) i += /^-[Cc]$/.test(ws[i]) ? 2 : 1;
    if (low(ws[i] || "") !== "push") return false;
    const rest = ws.slice(i + 1);
    if (rest.some((w) => /^--(?:tags|follow-tags|mirror)(?:=|$)/.test(low(w)))) return true;
    const pos = positional(rest, 0, /^$/);
    return (pos[1] === "tag" && pos.length > 2) || pos.some((w) => tagRef.test(w));
  }
  return false;
}
const hit = parse(args.command, input.toolName.toLowerCase() === "powershell").some(protectedStatement);
if (hit) process.stdout.write(`${JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: REASON })}\n`);
