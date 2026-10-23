import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
