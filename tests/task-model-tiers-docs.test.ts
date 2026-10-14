import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const root = read("README.md");
const extension = read("agent/extensions/subagent/README.md");
const runtime = read("agent/skills/engineering-harness/references/runtime.md");

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
