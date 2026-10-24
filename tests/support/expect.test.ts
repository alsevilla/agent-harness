import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverTests } from "../../scripts/run-node-tests.mjs";
import { expect } from "./expect.ts";

const REFUSED = /expect adapter refused/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("valid positive and negative matchers pass", () => {
	expect("abc").toMatch(/b/); expect("abc").not.toMatch(/x/);
	expect("abc").toContain("b"); expect("abc").not.toContain("x");
	expect([1, 2]).toContain(2); expect([1, 2]).not.toContain(3);
	expect([1, 2]).toHaveLength(2); expect([1, 2]).not.toHaveLength(3);
	expect(2).toBeGreaterThan(1); expect(2).not.toBeGreaterThan(3);
	expect(1).toBeLessThan(2); expect(2).not.toBeLessThan(1);
	expect(() => { throw new Error("boom"); }).toThrow("boom");
	expect(() => 1).not.toThrow();
	expect(undefined).toBeUndefined(); expect(1).toBe(1); expect({ a: 1 }).toEqual({ a: 1 });
});

test("nested asymmetric matchers work and unknown matchers fail", () => {
	expect({ a: [1, "xyz"], b: 2 }).toEqual({ a: expect.arrayContaining([expect.stringMatching(/y/)]), b: 2 });
	expect({ a: { c: 1, d: 2 } }).toEqual({ a: expect.objectContaining({ c: 1 }) });
	assert.throws(() => expect({ a: 1 }).toEqual({ a: expect.objectContaining({ a: 2 }) }));
	assert.throws(() => (expect(1) as any).toBeFoo(), TypeError);
});

test("valid mismatches are ordinary assertion failures, not refusals", () => {
	for (const fn of [() => expect("abc").toMatch(/x/), () => expect("abc").not.toMatch(/b/), () => expect([1]).toContain(2), () => expect([1]).toHaveLength(2),
		() => expect(1).toBeGreaterThan(2), () => expect(() => 1).toThrow(), () => expect(() => { throw new Error("a"); }).toThrow("b")]) {
		assert.throws(fn, (e: Error) => e instanceof assert.AssertionError && !REFUSED.test(e.message));
	}
});

test("invalid shapes are refused for positive and negated forms", () => {
	const cases: Array<(x: any) => void> = [
		(x) => x.toThrow(), (x) => x.toMatch(/x/), (x) => x.toContain("a"), (x) => x.toHaveLength(1), (x) => x.toBeGreaterThan(1),
	];
	const bad = [undefined, null, "2", 5, {}];
	const usable = (i: number, v: unknown) => !(i === 1 && typeof v === "string") && !(i === 2 && typeof v === "string") && !(i === 3 && typeof v === "string") && !(i === 4 && typeof v === "number");
	cases.forEach((run, i) => bad.forEach((v) => {
		if (!usable(i, v)) return;
		if (i === 3 && v === undefined) { assert.throws(() => run(expect(v)), REFUSED); }
		assert.throws(() => run(expect(v)), REFUSED);
		assert.throws(() => run(expect(v).not), REFUSED);
	}));
	assert.throws(() => expect("2").toBeGreaterThan(1), REFUSED);
	assert.throws(() => expect(2).toBeGreaterThan("1" as any), REFUSED);
	assert.throws(() => expect(NaN).not.toBeLessThan(1), REFUSED);
	assert.throws(() => expect(undefined).not.toMatch(/x/), REFUSED);
	assert.throws(() => expect(undefined).not.toContain("x"), REFUSED);
	assert.throws(() => expect(null).not.toHaveLength(1), REFUSED);
	assert.throws(() => expect("abc").toContain(1 as any), REFUSED);
	assert.throws(() => expect("abc").toMatch(1 as any), REFUSED);
	assert.throws(() => expect(() => 1).toThrow(1 as any), REFUSED);
	assert.throws(() => expect(1).toThrow("x"), REFUSED);
});

test("no test file passes a bare numeric timeout as the third test() argument", () => {
	const bare = /\btest\([^\n]*,\s*\d[\d_]*\)\s*;?\s*$/;
	const offenders = discoverTests(ROOT).filter((f) => fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").some((l) => bare.test(l) && !l.includes("timeout:")));
	assert.deepEqual(offenders, []);
});
