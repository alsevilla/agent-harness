// Root README: the table of contents matches the headings and every in-document link resolves (text checks; no rendering).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const text = readFileSync(resolve("README.md"), "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");
const slug = (t: string) => t.replace(/`/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
const headings: { level: number; slug: string }[] = [];
let fence = false;
for (const l of lines) {
  if (/^(```|~~~)/.test(l)) { fence = !fence; continue; }
  const m = !fence && /^(#{2,3}) (.+)$/.exec(l);
  if (m) headings.push({ level: m[1].length, slug: slug(m[2]) });
}
const tocStart = lines.indexOf("## Table of contents");
const tocEnd = lines.findIndex((l, i) => i > tocStart && l.startsWith("## "));
const toc = lines.slice(tocStart + 1, tocEnd).map((l) => /^(\s*)- \[(.+?)\]\(#([^)]+)\)$/.exec(l)).filter((m): m is RegExpExecArray => m !== null);

test("the table of contents lists every h2 in order", () => {
  assert.ok(tocStart >= 0 && tocEnd > tocStart, "TOC block found");
  assert.deepEqual(toc.filter((m) => m[1] === "").map((m) => m[3]), headings.filter((h) => h.level === 2 && h.slug !== "table-of-contents").map((h) => h.slug));
});

test("every in-document anchor resolves to exactly one heading", () => {
  const counts = new Map<string, number>();
  for (const h of headings) counts.set(h.slug, (counts.get(h.slug) ?? 0) + 1);
  assert.deepEqual([...counts].filter(([, n]) => n > 1), []);
  const anchors = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.deepEqual(anchors.filter((a) => !counts.has(a)), []);
});

test("every relative file link points at an existing path", () => {
  const targets = [...text.matchAll(/\]\(((?!https?:|#)[^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  assert.ok(targets.length > 10);
  assert.deepEqual(targets.filter((t) => !existsSync(resolve(t))), []);
});
