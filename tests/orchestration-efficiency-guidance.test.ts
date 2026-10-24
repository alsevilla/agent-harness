import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const routing = read("agent/skills/engineering-harness/references/routing.md");
const execute = read("agent/skills/engineering-harness/execute/index.md");
const recovery = read("agent/skills/engineering-harness/references/recovery.md");
const compact = (text: string) => text.replace(/\s+/g, " ");

test("routing decides single versus parallel by independence, size, overhead and reconciliation", () => {
  const text = compact(routing);
  const section = compact(routing.slice(routing.indexOf("## Task shape"), routing.indexOf("## Planning")));
  assert.match(section, /single versus parallel/i);
  assert.match(section, /independen(?:t|ce)[^.]*ownership/i);
  assert.match(section, /task size/i);
  assert.match(section, /setup or context overhead/i);
  assert.match(section, /reconciliation cost/i);
  assert.match(section, /choose one writer/i);
  assert.match(section, /never removes? (?:a )?mandatory role, specialist gate, independent verification or review, or tier rule/i);
  assert.match(section, /decompose dependent (?:downstream )?work only after the prerequisite result is accepted/i);
  assert.match(text, /Choosing single is not a bypass/i);
});

test("routing keeps one investigation per unknown bug and recovery continues terminal jobs with a new narrowed same-role packet", () => {
  const routingText = compact(routing);
  assert.match(routingText, /One investigation per unknown bug/);
  assert.match(routingText, /one debugger or one writer, not one worker per symptom/);
  const recoveryText = compact(recovery);
  assert.match(recoveryText, /terminal\) job cannot be resumed or restarted/);
  assert.match(recoveryText, /new narrowed packet to the same named role that cites its REPORT and the preserved partial writes/);
  assert.match(recoveryText, /native resume applies only to a paused active job/);
  assert.match(recoveryText, /never bypasses independent VERIFY or REVIEW/);
});

test("execute packet brief is a compact shared brief with decisions, interfaces, ownership and completion criteria", () => {
  const text = compact(execute);
  assert.match(text, /compact shared brief/i);
  assert.match(text, /accepted decisions/i);
  assert.match(text, /interfaces/i);
  assert.match(text, /file ownership/i);
  assert.match(text, /completion criteria/i);
  assert.match(text, /one shared artifact/i);
  assert.match(text, /role-specific delta/i);
});

const policy = read("agent/AGENTS.md");
const tokenEff = read("agent/skills/engineering-harness/references/token-efficiency.md");
const lf = (text: string) => text.replace(/\r\n/g, "\n");

test("AGENTS.md states a thin orchestrator with delegated reads, carve-outs and a dispatch-less fallback, naming no model", () => {
  const text = compact(policy);
  assert.match(text, /Main is orchestrator only: plan, decompose, delegate/);
  assert.match(text, /Delegate every file read, search, code\/test run and command inspection \(incl\. git\/hash identity\) to the narrowest read-only role, batched: one question-driven packet per decision point/);
  assert.match(text, /Main reads only platform-loaded policy, invoked modules, handoff replies, `subagent_control` results and its own PLAN\/DECISION\/evidence notes/);
  assert.match(text, /T0: standalone mechanical work[^.]*-> general-worker/);
  assert.match(text, /only when the host reports no usable dispatch[^.]*reads[^.]*standalone T0 edits; implementation, VERIFY, REVIEW, SHIP and delegated recovery stay blocked/i);
  assert.doesNotMatch(text, /main may edit/i);
  assert.doesNotMatch(text, /\b(?:claude|opus|sonnet|haiku|gpt-?\d*|gemini|openai|anthropic|codex|luna)\b/i);
});

test("AGENTS.md keeps mandatory roles, worker ownership and independence gates", () => {
  const text = compact(policy);
  for (const phrase of ["Main never impersonates a selected role", "test-engineer for independent VERIFY", "reviewer for REVIEW", "One writer owns each candidate", "remain worker-owned until explicit user reassignment", "return to debugger before main code tracing or speculative patches", "Never impersonate built-ins, substitute named roles", "Merge needs its own explicit approval", "VERIFY/REVIEW need exact candidate identity"]) assert.ok(text.includes(phrase), phrase);
});

test("AGENTS.md is not larger than the committed base (it loads in every child)", () => {
  const base = lf(execFileSync("git", ["show", "HEAD:agent/AGENTS.md"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }));
  assert.ok(lf(policy).length <= base.length, `AGENTS.md ${lf(policy).length} chars > base ${base.length}`);
});

test("AGENTS.md has a hard retry cap reconciled with recovery.md", () => {
  const text = compact(policy);
  assert.match(text, /Retry cap: at most 2 fix rounds per task and 2 review cycles per candidate, then reassess and return to main\/user with the evidence; no automatic escalation, and a new distinct failure starts a fresh count/);
  assert.match(text, /not refusal of authorized work; attempt count alone is no blocker or renewed approval gate/);
  assert.match(text, /New unexplained failures return to debugger before main code tracing or speculative patches/);
  const rec = compact(recovery);
  assert.match(rec, /at most 2 fix rounds per task and 2 review cycles per candidate/);
  assert.match(rec, /not a refusal to continue authorized work/);
  assert.match(rec, /Attempt count alone is not a blocker/);
  assert.doesNotMatch(compact(execute), /no fixed retry count/);
});

test("token-efficiency batches reads, trims packet boilerplate and keeps digest honesty", () => {
  const text = compact(tokenEff);
  assert.match(text, /one question-driven read packet per decision point/);
  assert.match(text, /state only deviations from leaf, local-only and native-tool boilerplate/i);
  assert.match(text, /name a module only when it differs from the role default/i);
  assert.match(text, /verbatim snippets and path:line for failures, blockers, security\/data risks and PASS claims/);
  assert.match(text, /never accepts? PASS from a digest/);
  assert.match(compact(routing.slice(routing.indexOf("## Discovery"), routing.indexOf("## Debugging"))), /verbatim snippets and path:line/);
});

test("execute, recovery and discover route main-session reads to read-only roles", () => {
  assert.doesNotMatch(compact(execute), /Only standalone T0 work outside assigned implementation\/recovery may be edited directly/);
  assert.match(compact(execute), /standalone T0[^.]*general-worker/i);
  assert.match(compact(recovery), /main-session (?:inspection|reads?)[^.]*delegated to (?:the narrowest )?read-only/i);
  assert.match(compact(read("agent/skills/engineering-harness/discover/index.md")), /read-only role/i);
});

const BASE_AGENTS_CHARS = 11725; // fixed size of the pre-slimming AGENTS.md (LF); not git HEAD, so it stays meaningful
const routingText = compact(routing);

// Measured post-fix LF size is 10847 (~92.5% of base); the 10% goal would need dropping rules, which review forbade. Ratchet at the measured size so it cannot regrow.
const AGENTS_RATCHET_CHARS = 10850;
test("AGENTS.md stays >= 7% below the fixed base size and names no model", () => {
  const size = lf(policy).length;
  assert.ok(size <= AGENTS_RATCHET_CHARS && AGENTS_RATCHET_CHARS <= 0.93 * BASE_AGENTS_CHARS, `AGENTS.md ${size} chars > ${AGENTS_RATCHET_CHARS}`);
  assert.doesNotMatch(policy, /\b(?:claude|opus|sonnet|haiku|gpt-?\d*|gemini|openai|anthropic|codex|luna|sol)\b/i);
});

test("AGENTS.md keeps restored rule-meaning clauses", () => {
  const text = compact(policy);
  for (const phrase of [
    "(code preparation only does not)",
    "static text is not evidence of live autonomous delivery",
    "misplaced idle task output and retains and reports live/unknown data",
    "Completion states changes, actual checks,",
    "no extra skill read",
    "expected behavior/contract",
    "historical catalogs cannot add universal gates or override this policy",
    "never accept PASS from a digest",
  ]) assert.ok(text.includes(phrase), phrase);
});

test("AGENTS.md keeps the non-negotiable model-routing rules and points to routing.md", () => {
  const text = compact(policy);
  for (const phrase of [
    "Preserve declared role models/effort and supported fallback safeguards",
    "never arbitrary per-call model IDs",
    "no automatic escalation or retry upgrade",
    "do not silently upgrade models or replay after tools/abort",
    "unsupported tier names are refused",
    "high-risk work on an economy-default role requests configured `capable` explicitly",
    "Copilot uses the GitHub CLI-selected model (`pi.*`/`roles.json` never override it) and has no `modelSlot`",
    "worker tier follows task risk, not the main model",
    "`references/routing.md`, \"Explicit Pi model tier\"",
  ]) assert.ok(text.includes(phrase), phrase);
});

test("routing.md states the relocated modelTier/modelSlot detail", () => {
  for (const phrase of [
    "Explicit Pi `modelTier` selection is the narrow exception to preserving declared role models",
    "only a supported canonical package role's validated `roles.json` tier applies",
    "tools, permissions and role owner stay unchanged",
    "no numeric tier policy",
    "starts that task on the first configured fallback of the same validated tier (exact primary excluded) with an empty replay chain",
    "selects no arbitrary model, provider or thinking value",
    "never returns to the primary",
    "Copilot has no `modelSlot` and uses the GitHub CLI-selected model",
    "`pi.*` and `roles.json` are Pi-only and must not override Copilot selection or map provider IDs",
    "Extensions, patches and settings remain Pi-specific",
    "never silently upgrade models or replay after tools/abort",
  ]) assert.ok(routingText.includes(phrase), phrase);
});

test("recovery.md escalation text is model-agnostic", () => {
  assert.doesNotMatch(recovery, /\b(?:Luna|Sol|Opus|Sonnet)\b/);
});

const skill = read("agent/skills/engineering-harness/SKILL.md");
const readme = read("README.md");

test("routing states one evidence-before-decomposition rule without a new universal gate", () => {
  const text = compact(routing);
  assert.equal(text.match(/Decompose dependent downstream work only after the prerequisite result is accepted/g)?.length, 1);
  const start = routing.indexOf("### Evidence before decomposition");
  assert.ok(start > routing.indexOf("## Task shape") && start < routing.indexOf("## Planning"), "rule lives in Task shape");
  const rule = compact(routing.slice(start, routing.indexOf("\n### ", start + 5)));
  assert.match(rule, /accept(?:ed)? (?:the )?(?:discovery|prerequisite)[^.]*evidence before (?:any )?material downstream assignment/i);
  assert.match(rule, /already-known localized contracts? (?:do(?:es)? not|need no)[^.]*discovery/i);
  assert.match(rule, /parallelize only disjoint, independent assignments/i);
  assert.match(rule, /adds no (?:universal )?(?:chain|gate)/i);
});

test("SKILL.md routing table maps need to module, existing role and acceptance check within a size budget", () => {
  const rows = skill.split(/\r?\n/).filter((line) => /^\|/.test(line) && !/^\|[-| ]+\|$/.test(line));
  const header = rows[0].split("|").slice(1, -1).map((cell) => cell.trim());
  assert.deepEqual(header, ["Need", "Module", "Role", "Acceptance check"]);
  const roles = new Set(readdirSync(new URL("../agent/agents/", import.meta.url)).map((file) => file.replace(/\.md$/, "")));
  for (const row of rows.slice(1)) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 4, row);
    assert.ok(cells[3].length > 0, row);
    for (const [, name] of cells[2].matchAll(/`([a-z-]+)`/g)) assert.ok(name === "main" || roles.has(name), `${name} is not an existing role`);
  }
  const roleCol = rows.slice(1).map((row) => row.split("|")[3]).join(" ");
  for (const owner of ["debugger", "test-engineer", "reviewer", "release-engineer", "backend-worker", "frontend-worker", "general-worker", "platform-worker"]) assert.ok(roleCol.includes(owner), owner);
  assert.match(roleCol, /main/);
  assert.match(skill, /main owns PLAN/);
  assert.ok(skill.length <= 5200, `SKILL.md ${skill.length} chars`);
});

test("README states latest-only host support separately from the version actually tested", () => {
  const text = compact(readme);
  assert.match(text, /Only the latest Pi release is supported/);
  assert.match(text, /scripts\/check-pi-latest\.mjs/);
  assert.match(text, /latest-runtime validation unavailable/);
  assert.match(text, /version actually tested/i);
  assert.doesNotMatch(text, /tested baseline is Pi 1\.1\.0|Pi 1\.1\.0 \(tested baseline/);
  assert.doesNotMatch(compact(read("agent/extensions/subagent/README.md")), /targets Pi 1\.1\.0 \(tested baseline/);
  assert.doesNotMatch(compact(read("agent/VALIDATION.md")), /current tested baseline is Pi 1\.1\.0/);
});
