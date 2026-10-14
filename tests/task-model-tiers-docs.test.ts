import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const root = read("README.md");
const extension = read("agent/extensions/subagent/README.md");
const runtime = read("agent/skills/engineering-harness/references/runtime.md");
const policy = read("agent/AGENTS.md");
const routing = read("agent/skills/engineering-harness/references/routing.md");
const tokenEfficiency = read("agent/skills/engineering-harness/references/token-efficiency.md");
const manifest = read("agent/skills/engineering-harness/references/run-manifest.md");
const compact = (text: string) => text.replace(/\s+/g, " ");

test("optional Pi task model tiers are documented without changing host defaults", () => {
  assert.match(root, /optional Pi-only `economy`\/`capable` task tiers/i);
  assert.match(extension, /modelTier/);
  for (const mode of ["single", "parallel", "chain", "DAG"]) assert.match(extension, new RegExp(mode, "i"));
  assert.match(extension, /modelTiers/);
  assert.match(extension, /diagnostic|usage/i);
  assert.match(extension, /Copilot.*(?:unchanged|native)|(?:unchanged|native).*Copilot/i);
  assert.match(runtime, /Pi-only.*tier|tier.*Pi-only/i);
  assert.match(extension, /no task\/tool\/abort replay/i);
});

test("explicit economy tier is limited to bounded known-contract backend and frontend work with defaults unchanged", () => {
  const text = compact(routing);
  assert.match(text, /Explicit Pi model tier/);
  assert.match(text, /bounded, known-contract backend or frontend implementation/);
  assert.match(text, /`modelTier: "economy"`/);
  assert.match(text, /backend-worker: add one validated field to an existing endpoint whose schema and focused tests are named in the packet -> explicit economy/);
  assert.match(text, /frontend-worker: adjust presentational state of an existing component whose design is already approved and whose focused tests are named -> explicit economy/);
  assert.match(text, /omit the field: the role's `defaultModelTier` runs unchanged/);
  assert.match(text, /no automatic escalation/);
  assert.match(compact(policy), /Explicit `economy` fits bounded known-contract backend or frontend implementation with declared checks/);
  assert.match(compact(runtime), /routing\.md`? \("Explicit Pi model tier"\)/);
  assert.match(compact(runtime), /applies only the requested tier's configured model, fallbackModel and thinking to that task and changes no stored role default, preset or tools/);
  assert.match(text, /applies only the requested tier's configured model, fallback and thinking to that task; it changes no stored role default, preset or tools/);
});

test("exact-operation grants are documented against the recorded tool cwd, not a git -C target", () => {
  const text = compact(runtime);
  assert.match(text, /Exact-operation grants match the recorded tool cwd, not a `git -C` target inside the command/);
  assert.match(text, /internal read-only lookups still use a neutral cwd with explicit `git -C`/);
  assert.match(text, /candidate-boundary leases are a distinct mechanism/);
});

test("complex work and unsupported tier names never take the economy route", () => {
  const text = compact(routing);
  assert.match(text, /never economy for complex, unresolved, security-sensitive, concurrency, persistence or cross-layer work; that work stays on capable \(the omitted default when it is capable, or explicit `capable` on an economy-default role\) or a specialist route/i);
  assert.match(text, /backend-worker: auth, secrets, migration or concurrency change -> no explicit economy/);
  assert.match(text, /frontend-worker: UX or design choice without approved design -> ui-ux-specialist first, no explicit economy/);
  assert.match(text, /unsupported tier names \(for example `complex`, `fast` or `premium`\) are refused before launch/);
  assert.doesNotMatch(text, /modelTier: "(?:complex|fast|premium)"/);
  assert.doesNotMatch(compact(policy), /modelTier: "(?:complex|fast|premium)"/);
  assert.match(compact(policy), /unsupported tier names are refused/);
});

test("usage accounting reads existing records without a collector or double-counting reasoning", () => {
  const text = compact(tokenEfficiency);
  assert.match(text, /### Usage record accounting/);
  assert.match(text, /sum unique model attempts from existing usage records across main, worker, specialist, verify and retries/);
  assert.match(text, /partial when a record is missing and name the missing attempt; do not estimate it/);
  assert.match(text, /reasoning tokens already included in reported output tokens are not added again/);
  assert.match(text, /cached input usage and cost are reported separately from uncached input and output/);
  assert.match(text, /guidance only: no collector, recorder, schema or budget/);
  assert.match(compact(manifest), /## Usage summary \(optional, complex runs\)/);
  assert.match(compact(manifest), /partial when a record is missing/);
  assert.match(compact(manifest), /cached usage and cost stay separate/);
});

// Docs-level expectations only: these pin the written policy, not whether an orchestrator chooses the tier.
test("high-risk work on economy-default roles requests configured capable; an unconfigured capable route is unresolved, never economy by omission", () => {
  const text = compact(routing);
  assert.match(text, /high-risk work on an economy-default role requests configured `capable` explicitly/i);
  assert.match(text, /omission would run economy/);
  assert.match(text, /when that role does not configure `capable`, the selection is unresolved and goes to main, never economy by omission/);
  assert.match(text, /database-worker: consequential migration or persistence change -> explicit `capable`/);
  assert.match(text, /platform-worker: consequential infrastructure change -> explicit `capable`/);
  assert.match(text, /test-engineer: data-integrity verification -> explicit `capable`/);
  assert.match(text, /scout or observability-specialist \(economy only\): high-risk task -> unresolved, main decides or a specialist route/);
  assert.match(text, /no automatic escalation or retry upgrade/);
  assert.match(compact(policy), /high-risk work on an economy-default role requests configured `capable`/i);
  assert.match(compact(runtime), /high-risk work on an economy-default role requests configured `capable`/i);
  assert.match(compact(runtime), /loads the 20 user agent definitions/);
  assert.doesNotMatch(compact(runtime), /loads the 22 user agent definitions/);
});
