// Deterministic Copilot adapter helpers: strict role/tool normalization, native-header drift check, exact-role and question/handoff interpretation.
// Not a dispatcher, question tool, hook or grant store; it never intercepts native execution. agent/roles.json stays the only role/grant source.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALIASES = Object.freeze({ read: "read", grep: "search", find: "search", ls: "search", bash: "execute", powershell: "execute", edit: "edit", write: "edit" });
const HEADER_KEYS = ["name", "description", "tools"];

/** Pi tool list -> deduped native aliases. Unknown/blank/empty input throws: never default to all tools. */
export function nativeTools(piTools) {
  if (typeof piTools !== "string" || !piTools.trim()) throw new Error("tools must be a non-empty comma-separated string");
  const out = [];
  for (const raw of piTools.split(",")) {
    const tool = raw.trim();
    if (!Object.hasOwn(ALIASES, tool)) throw new Error(`unmappable tool: ${JSON.stringify(tool)}`);
    if (!out.includes(ALIASES[tool])) out.push(ALIASES[tool]);
  }
  return out.join(", ");
}

const nonblank = (v) => typeof v === "string" && v.trim() !== "";
// Every index 0..length-1 must be an own property; refuses at the first hole without allocating by length.
const dense = (a) => { if (!Array.isArray(a)) return false; for (let i = 0; i < a.length; i++) if (!Object.hasOwn(a, i)) return false; return true; };
const denseText = (a) => dense(a) && a.length > 0 && a.every(nonblank);

/** Why a header value is not an unambiguous YAML plain string, or "" when it is. Supported subset only: starts with a letter, then letters, digits, space and , . ; ( ) / _ -; not a YAML typed word. Everything else (quotes, indicators, colons, #, brackets, leading digits/signs/dots, non-ASCII) is refused rather than guessed. */
function scalarProblem(v) {
  if (typeof v !== "string") return "value is not a string";
  if (!v.trim()) return "value is empty";
  if (!/^[A-Za-z][A-Za-z0-9 ,.;()/_-]*$/.test(v) || v !== v.trim()) return `outside the supported plain-string subset: ${v}`;
  if (/^(null|true|false|yes|no|on|off|y|n)$/i.test(v)) return `ambiguous non-string scalar: ${v}`;
  return "";
}

/** Strict single-line `key: plain string` frontmatter (the only native header shape used here). Keeps key order; rejects duplicate, malformed or ambiguous lines. */
export function readHeader(text) {
  const match = /^---\r?\n([^]*?)\r?\n---\r?\n/.exec(text);
  if (!match) throw new Error("missing YAML frontmatter");
  const header = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (!m) throw new Error(`unsupported header line: ${line}`);
    if (Object.hasOwn(header, m[1])) throw new Error(`duplicate header key: ${m[1]}`);
    const problem = scalarProblem(m[2]);
    if (problem) throw new Error(`header ${m[1]}: ${problem}`);
    header[m[1]] = m[2];
  }
  return header;
}

/** Registry roles vs native headers ({name: header}). Returns a list of problems; empty means aligned. */
export function checkAlignment(roles, headers) {
  const problems = [];
  const known = new Set();
  for (const role of roles) {
    known.add(role.name);
    const header = headers[role.name];
    if (!header) { problems.push(`${role.name}: native profile missing`); continue; }
    if (JSON.stringify(Object.keys(header)) !== JSON.stringify(HEADER_KEYS)) problems.push(`${role.name}: header keys must be exactly ${HEADER_KEYS.join(", ")} (got ${Object.keys(header).join(", ")})`);
    if (header.name !== role.name) problems.push(`${role.name}: header name is ${header.name}`);
    for (const key of HEADER_KEYS) { const p = scalarProblem(header[key]); if (p) problems.push(`${role.name}: header ${key}: ${p}`); }
    try {
      const expected = nativeTools(role.tools);
      if (header.tools !== expected) problems.push(`${role.name}: header tools "${header.tools}" != registry projection "${expected}"`);
    } catch (e) { problems.push(`${role.name}: ${e.message}`); }
  }
  for (const name of Object.keys(headers)) if (!known.has(name)) problems.push(`${name}: extra native profile not in registry`);
  return problems;
}

/** Exact named dispatch gate: only a runtime-verified ("supported") capability and an exactly available role pass. No substitution. */
export function resolveRole(requested, available, capability) {
  if (capability !== "supported") return { ok: false, reason: `dispatch capability ${capability === "unsupported" ? "unsupported" : "unverified"}` };
  if (!nonblank(requested) || !dense(available) || !available.every(nonblank)) return { ok: false, reason: "requested role and inventory must be a nonblank name and an array of nonblank names" };
  if (!available.includes(requested)) return { ok: false, reason: `role ${JSON.stringify(requested)} not available; no substitution` };
  return { ok: true, role: requested };
}

/** Internal normalized comparison only: true when the record says answered with exactly the approving option. The native cancel/timeout encoding is unknown, so anything else is false. Not native authority and not proof the user approved. */
export function isApproval(result, approveOption) {
  return nonblank(approveOption) && !!result && typeof result === "object" && !Array.isArray(result) && result.status === "answered" && nonblank(result.answer) && result.answer === approveOption;
}

/** Portable handoff structure check only (not that paths exist, checks ran, permissions were granted or the candidate is isolated). Returns problems. */
export function validateHandoff(h) {
  if (!h || typeof h !== "object") return ["handoff must be an object"];
  const problems = [];
  if (!nonblank(h.candidate) || !isAbsolute(h.candidate)) problems.push("candidate must be an absolute path");
  if (!nonblank(h.task)) problems.push("task must be a nonblank string");
  if (!nonblank(h.expectedBehavior)) problems.push("expectedBehavior must be a nonblank string");
  if (!denseText(h.allowedScope)) problems.push("allowedScope must be a dense non-empty list of nonblank strings");
  if (!denseText(h.prohibitedActions)) problems.push("prohibitedActions must be a dense non-empty list of nonblank strings (explicit none is fine)");
  if (!["PASS", "FAIL", "INCONCLUSIVE", "BLOCKED", "ESCALATE"].includes(h.status)) problems.push("status must be PASS|FAIL|INCONCLUSIVE|BLOCKED|ESCALATE");
  if (!nonblank(h.next)) problems.push("next action must be a nonblank string (explicit none is fine)");
  if (!nonblank(h.risks)) problems.push("risks must be a nonblank string (explicit none is fine)");
  const checks = dense(h.checks) ? h.checks : [];
  if (!dense(h.checks) || !checks.length) problems.push("checks must be a dense list of at least one command");
  for (const c of checks) {
    if (!c || typeof c !== "object" || !nonblank(c.command) || c.command.trim().toLowerCase() === "done" || !Number.isInteger(c.exitCode)) problems.push(`check needs command and integer exitCode: ${JSON.stringify(c)}`);
    else if (h.status === "PASS" && c.exitCode !== 0) problems.push(`PASS with failing check: ${c.command}`);
  }
  const ev = h.evidence;
  if (!dense(ev) || !ev.length || !ev.every((p) => nonblank(p) && isAbsolute(p))) problems.push("evidence must be absolute paths");
  return problems;
}

const LIMITATIONS = Object.freeze([
  "Internal preflight data, not trusted authority and not native interception or enforcement.",
  "Model, thinking and ordered-fallback honoring cannot be established from caller data or catalog membership; no provider IDs are translated and nothing is emitted to native calls.",
]);

/** Verbatim model requirement of a registry role's declared default tier. Throws on malformed/missing source; never reads session or other sources. */
export function modelRequirement(role) {
  if (!role || typeof role !== "object" || Array.isArray(role) || !nonblank(role.name)) throw new Error("role must be an object with a nonblank name");
  const tier = role.defaultModelTier;
  if (!nonblank(tier)) throw new Error(`${role.name}: defaultModelTier must be a nonblank string`);
  const tiers = role.modelTiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers) || !Object.hasOwn(tiers, tier)) throw new Error(`${role.name}: modelTiers has no declared default tier ${JSON.stringify(tier)}`);
  const src = tiers[tier];
  if (!src || typeof src !== "object" || Array.isArray(src)) throw new Error(`${role.name}: tier ${tier} must be an object`);
  if (!nonblank(src.model)) throw new Error(`${role.name}: tier ${tier} model must be a nonblank string`);
  if (typeof src.fallbackModel !== "string") throw new Error(`${role.name}: tier ${tier} fallbackModel must be a string (may be empty)`);
  if (!nonblank(src.thinking)) throw new Error(`${role.name}: tier ${tier} thinking must be a nonblank string`);
  return { role: role.name, tier, model: src.model, fallbackModel: src.fallbackModel, thinking: src.thinking };
}

/** Conservative model compatibility. Never ready: only an exact rejection or an inventory lacking the model is conclusive (unsupported); everything else, including an advertised model, stays unverified. */
export function modelCompatibility(requirement, evidence) {
  const base = { ready: false, requirement, limitations: LIMITATIONS };
  const ev = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : undefined;
  const list = (v) => (v === undefined ? undefined : denseText(v) ? v : null);
  const rejected = ev ? list(ev.rejectedModels) : undefined;
  const advertised = ev ? list(ev.advertisedModels) : undefined;
  if (!ev || rejected === null || advertised === null || (rejected === undefined && advertised === undefined)) return { ...base, status: "unverified", reasons: ["no usable active native model evidence"] };
  if (rejected?.includes(requirement.model)) return { ...base, status: "unsupported", reasons: [`runtime rejected model ${requirement.model}`] };
  if (advertised && !advertised.includes(requirement.model)) return { ...base, status: "unsupported", reasons: [`model ${requirement.model} is not advertised by the runtime`] };
  return { ...base, status: "unverified", reasons: ["model name alone does not prove the model, thinking effort or ordered fallback are honored"] };
}

/** Exact native identity: canonical registry role + explicit runtime namespace + exact `namespace:role` in the runtime inventory. Availability only; no fuzzy match, no built-in substitute. */
export function nativeIdentity(roles, role, namespace, inventory, capability) {
  if (!dense(roles) || !nonblank(role) || !roles.some((r) => r && r.name === role)) return { ok: false, reason: "role is not a canonical registry role" };
  if (!nonblank(namespace) || !/^[A-Za-z0-9._-]+$/.test(namespace)) return { ok: false, reason: "an explicit runtime plugin namespace is required" };
  const r = resolveRole(`${namespace}:${role}`, inventory, capability);
  return r.ok ? { ok: true, nativeName: r.role } : r;
}

/** Named-role preflight: nativeDispatchReady is native availability only (not permission or source authority); modelRequirementsVerified is always false (no caller input proves model honoring) and model-bound delegation is never ready here. Throws if the role is not in the registry. */
export function rolePreflight(roles, { role, namespace, inventory, dispatch, modelEvidence } = {}) {
  const entry = dense(roles) ? roles.find((r) => r && r.name === role) : undefined;
  if (!entry) throw new Error(`role ${JSON.stringify(role)} is not in the registry`);
  const model = modelCompatibility(modelRequirement(entry), modelEvidence);
  const native = nativeIdentity(roles, role, namespace, inventory, dispatch);
  return { role, requirement: model.requirement, native, model, nativeDispatchReady: native.ok, modelRequirementsVerified: false, modelBoundDelegation: "non-ready", limitations: LIMITATIONS };
}

/** Reads roles.json and agent headers under a package root. */
export const loadRoles = (root) => JSON.parse(readFileSync(join(root, "agent", "roles.json"), "utf8"));

export function checkPackage(root) {
  const roles = loadRoles(root);
  const dir = join(root, "agent", "agents");
  const headers = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), readHeader(readFileSync(join(dir, f), "utf8"))]));
  return checkAlignment(roles, headers);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Strict args: [--root DIR] [--role NAME], each at most once, no positionals. --role prints requirements/preflight without native calls; exit 2 = model-bound delegation non-ready (nativeDispatchReady is reported separately).
  const args = process.argv.slice(2);
  const opts = {};
  let bad = "";
  for (let k = 0; k < args.length; k += 2) {
    const flag = args[k];
    if ((flag !== "--root" && flag !== "--role") || Object.hasOwn(opts, flag) || !nonblank(args[k + 1]) || args[k + 1].startsWith("--")) { bad = `unsupported or incomplete argument: ${flag}`; break; }
    opts[flag] = args[k + 1];
  }
  const root = resolve(opts["--root"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  if (bad) { console.error(`${bad}\nusage: copilot-compat.mjs [--root DIR] [--role NAME]`); process.exitCode = 1; }
  else if (opts["--role"]) {
    try { console.log(JSON.stringify(rolePreflight(loadRoles(root), { role: opts["--role"] }), null, 2)); process.exitCode = 2; } catch (e) { console.error(e.message); process.exitCode = 1; }
  } else {
    let problems;
    try { problems = checkPackage(root); } catch (e) { problems = [e.message]; }
    if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; } else console.log("copilot-compat: registry and native headers aligned");
  }
}
