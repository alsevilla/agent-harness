// Deterministic policy/doc consistency for automatic PR delivery. These are static text and fixture checks: they do NOT prove that a live orchestrator autonomously delegates delivery (no live LLM workflow is run here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (p: string) => readFileSync(resolve(p), 'utf8');
const compact = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');
const policy = compact(read('agent/AGENTS.md'));
const ship = compact(read('agent/skills/engineering-harness/ship/index.md'));
const routing = compact(read('agent/skills/engineering-harness/references/routing.md'));
const role = compact(read('agent/agents/release-engineer.md'));
const readme = compact(read('README.md'));
const subagent = compact(read('agent/extensions/subagent/README.md'));
const cases = JSON.parse(read('agent/skills/engineering-harness/examples/routing-cases.json')).cases as Array<any>;

test('policy: automatic PR delivery after required checks, with local-only and blocked-check suppression', () => {
  assert.match(policy, /automatic pr delivery \(user-approved\)/);
  assert.match(policy, /once every required check has passed on the exact candidate/);
  assert.match(policy, /no extra approval prompt and no `request_authorization`/);
  assert.match(policy, /local-only or no-publication instruction, a failed or blocked required check/);
  assert.match(policy, /orchestration gate: the runtime guard cannot verify checks or local-only intent/);
  assert.match(policy, /readiness does not grant commit\/push\/merge\/publish\/deploy\/destructive-operation authority/);
});

test('policy: merge and release are separate identity-bound approvals; neither authorizes the other', () => {
  for (const text of [policy, ship]) {
    assert.match(text, /exact pr and the approved candidate head sha|exact pr, version and target sha|exact pr and the approved candidate head sha/);
    assert.match(text, /neither (?:authorizes the other|is inferred)|vice versa/);
  }
  assert.match(ship, /single-use `operations` grants are refused for both/);
  assert.match(ship, /legacy combined delivery grants are rejected/);
  assert.match(role, /one never authorizes the other/);
  assert.match(role, /single-use operation grants are not accepted for them/);
  assert.match(subagent, /a merge approval never authorizes a release and a release approval never authorizes a merge/);
  assert.match(subagent, /there is no `mergedat` or time fallback/);
  assert.match(subagent, /legacy combined delivery grants are not accepted|is rejected at the tool, at the store and at the child envelope loader/);
  assert.match(readme, /each needs its own explicit approval/);
});

test('docs: automatic PR edit is same-owned, structural and metadata-only; no author lookup, no base change', () => {
  assert.match(ship, /`--title`\/`--body`\/`--body-file` on an open pr of the task feature branch/);
  assert.match(ship, /never changes the base, reviewers, labels or state/);
  assert.match(subagent, /strictly `iscrossrepository === false` \(missing or null refuses\)/);
  assert.match(subagent, /no author lookup/);
  assert.match(role, /only `--title`\/`--body`\/`--body-file`/);
});

test('docs: routing guidance names the orchestration gate and the offline fixture limits', () => {
  assert.match(routing, /a local-only\/no-publication instruction or a failed\/blocked required check means no `release-engineer` launch/);
  assert.match(routing, /not evidence of live autonomous delivery/);
});

test('orchestrator selection fixtures (deterministic, offline): delivery, local-only, blocked checks and merge without approval', () => {
  const by = Object.fromEntries(cases.map((c) => [c.id, c.expect]));
  assert.deepEqual([by.R29.routes, by.R29.roles_required], [['SHIP_AUTHORIZED'], ['release-engineer']]);
  assert.deepEqual([by.R30.routes, by.R30.roles_allowed], [['LOCAL_DONE'], []]);
  assert.deepEqual([by.R31.routes, by.R31.roles_required], [['T2_DEBUG_WORKER'], ['debugger']]);
  assert.ok(!by.R31.roles_allowed.includes('release-engineer'));
  assert.deepEqual([by.R32.routes, by.R32.roles_allowed], [['BLOCKED_NO_AUTHORITY'], []]);
});

