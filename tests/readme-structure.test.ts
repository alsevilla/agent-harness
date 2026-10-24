// Heading hierarchy, TOC structure and anchor integrity for the root README (text checks; no rendering).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const text = readFileSync(resolve("README.md"), "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");
const slug = (t: string) => t.replace(/`/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");

type Heading = { level: number; text: string; slug: string; line: number };
const headings: Heading[] = [];
let fence = false;
lines.forEach((l, i) => {
  if (/^(```|~~~)/.test(l)) { fence = !fence; return; }
  if (fence) return;
  const m = /^(#{2,3}) (.+)$/.exec(l);
  if (m) headings.push({ level: m[1].length, text: m[2], slug: slug(m[2]), line: i + 1 });
});
const h2s = headings.filter((h) => h.level === 2 && h.text !== "Table of contents");
const boundary = headings.find((h) => h.text === "Copilot CLI preview boundary");

const tocStart = lines.indexOf("## Table of contents");
const tocEnd = lines.findIndex((l, i) => i > tocStart && l.startsWith("## "));
const toc = lines.slice(tocStart + 1, tocEnd)
  .map((l) => /^(\s*)- \[(.+?)\]\(#([^)]+)\)$/.exec(l))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => ({ nested: m[1].length > 0, label: m[2], anchor: m[3] }));

test("the boundary is a level-3 subsection under Status and limits, before Installation, and no top-level copy remains", () => {
  assert.ok(boundary, "heading present");
  assert.equal(boundary!.level, 3);
  assert.equal(headings.filter((h) => h.text === "Copilot CLI preview boundary").length, 1);
  const parent = [...headings].slice(0, headings.indexOf(boundary!)).reverse().find((h) => h.level === 2);
  assert.equal(parent?.text, "Status and limits");
  const next = h2s.find((h) => h.line > boundary!.line);
  assert.equal(next?.text, "Installation");
});

test("TOC top-level entries match the h2 headings in body order", () => {
  assert.ok(tocStart >= 0 && tocEnd > tocStart, "TOC block found");
  const top = toc.filter((e) => !e.nested).map((e) => e.anchor);
  assert.deepEqual(top, h2s.map((h) => h.slug));
});

test("the boundary entry is nested directly under Status and limits, and every nested entry sits under its own h2", () => {
  const statusIdx = toc.findIndex((e) => e.anchor === "status-and-limits");
  assert.equal(toc[statusIdx + 1]?.anchor, "copilot-cli-preview-boundary");
  assert.equal(toc[statusIdx + 1]?.nested, true);
  assert.equal(toc[statusIdx + 2]?.nested, false);
  assert.equal(toc[statusIdx + 2]?.anchor, "installation");
  let parent = "";
  for (const e of toc) {
    if (!e.nested) { parent = e.anchor; continue; }
    const h = headings.find((x) => x.slug === e.anchor);
    assert.equal(h?.level, 3, `${e.anchor} is an h3`);
    const owner = [...headings].slice(0, headings.indexOf(h!)).reverse().find((x) => x.level === 2);
    assert.equal(owner?.slug, parent, `${e.anchor} is nested under ${parent}`);
  }
});

test("every in-document anchor link resolves to exactly one heading", () => {
  const counts = new Map<string, number>();
  for (const h of headings) counts.set(h.slug, (counts.get(h.slug) ?? 0) + 1);
  assert.deepEqual([...counts].filter(([, n]) => n > 1), []);
  const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 20);
  assert.deepEqual(links.filter((a) => !counts.has(a)), []);
});

test("the boundary body is intact: all seven compatibility rows and the preview limits remain under the subsection", () => {
  const start = boundary!.line - 1;
  const end = h2s.find((h) => h.line > boundary!.line)!.line - 1;
  const body = lines.slice(start, end).join("\n");
  const rows = lines.slice(start, end).filter((l) => /^\| /.test(l) && !/^\| (Asset|---)/.test(l)).map((l) => l.split("|")[1].trim());
  assert.deepEqual(rows, ["Source release", "Agents and skills", "Session startup context", "Pi-specific runtime assets", "Child context, guard and limits", "Prompts and commands", "Verification and availability"]);
  assert.match(body, /Preview with the tested local `copilot --plugin-dir \.` path/);
});

test("Optional skill catalogs lists Defuddle as an external skill and CLI, not a bundled catalog or native export", () => {
  const start = lines.indexOf("## Optional skill catalogs");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
  assert.ok(start >= 0 && end > start, "section found");
  const section = lines.slice(start, end).join("\n");
  const rows = lines.slice(start, end).filter((l) => /^\| /.test(l) && !/^\| (Catalog|---)/.test(l)).map((l) => l.split("|")[1].trim());
  assert.deepEqual(rows, ["backend", "frontend", "browser", "graphify", "defuddle (external)"]);
  const row = lines.slice(start, end).find((l) => l.startsWith("| defuddle"))!;
  assert.match(row, /external/i);
  assert.match(row, /not bundled/i);
  assert.match(row, /`defuddle parse <url> --md`/);
  assert.match(row, /agent\/skills\/engineering-harness\/references\/runtime\.md/);
  assert.match(row, /browser/i);
  assert.doesNotMatch(section, /agent\/skills\/defuddle/);
  assert.doesNotMatch(row, /[A-Za-z]:[\/]|\/Users\/|\.agents/);
  assert.match(section, /exactly two skills, `engineering-harness` and `agent-creation`/);
});

test("Copilot references use anchors rather than position, and the optional Defuddle guidance is linked to an existing runtime heading", () => {
  assert.doesNotMatch(text, /limited native preview: SessionStart loads canonical startup context as described above/);
  assert.match(text, /\[Copilot CLI preview boundary\]\(#copilot-cli-preview-boundary\)/);
  const link = "](agent/skills/engineering-harness/references/runtime.md#public-web-content-optional-defuddle)";
  assert.equal(text.split(link).length - 1, 1, "one Defuddle README link");
  const runtime = readFileSync(resolve("agent/skills/engineering-harness/references/runtime.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(runtime.split("\n").some((l) => l === "## Public web content (optional Defuddle)"));
});
