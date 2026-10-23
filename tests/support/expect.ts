// Thin expect-style adapter over node:assert/strict so the existing assertions keep their exact shape under node:test.
// Only the matchers the suites use exist; an unknown matcher is a TypeError, never a silent pass.
import assert from "node:assert/strict";
import { inspect } from "node:util";

class Asym {
	constructor(readonly kind: "arrayContaining" | "objectContaining" | "stringMatching", readonly sample: unknown) {}
	test(actual: unknown): boolean {
		const s = this.sample as any;
		if (this.kind === "stringMatching") return typeof actual === "string" && (s instanceof RegExp ? s.test(actual) : actual.includes(String(s)));
		if (this.kind === "arrayContaining") return Array.isArray(actual) && (s as unknown[]).every((item) => actual.some((a) => looseMatch(a, item)));
		return actual !== null && typeof actual === "object" && Object.keys(s).every((k) => k in (actual as object) && looseMatch((actual as any)[k], s[k]));
	}
}

/** Recursive equality where Asym nodes match asymmetrically; everything else is strict deep equality. */
function looseMatch(actual: unknown, expected: unknown, partial = false): boolean {
	if (expected instanceof Asym) return expected.test(actual);
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => looseMatch(actual[i], e, partial));
	if (expected && typeof expected === "object" && !(expected instanceof RegExp) && !(expected instanceof Date) && !(expected instanceof Map) && !(expected instanceof Set)) {
		if (!actual || typeof actual !== "object") return false;
		const ek = Object.keys(expected), ak = Object.keys(actual);
		if (!partial && ek.length !== ak.length) return false;
		return ek.every((k) => k in (actual as object) && looseMatch((actual as any)[k], (expected as any)[k], partial));
	}
	try { assert.deepStrictEqual(actual, expected); return true; } catch { return false; }
}

const hasAsym = (v: unknown): boolean => v instanceof Asym || (!!v && typeof v === "object" && Object.values(v).some(hasAsym));
const show = (v: unknown) => inspect(v, { depth: 6, breakLength: 120 });

/** Invalid input is refused before any comparison or negation; never coerced and never a pass. */
const refuse = (why: string): never => { throw new TypeError(`expect adapter refused: ${why}`); };
const num = (v: unknown, role: string) => { if (typeof v !== "number" || Number.isNaN(v)) refuse(`${role} must be a non-NaN number, got ${show(v)}`); };
const pattern = (v: unknown) => { if (typeof v !== "string" && !(v instanceof RegExp)) refuse(`expected must be string or RegExp, got ${show(v)}`); };

function matchers(actual: unknown, message: string | undefined, negate: boolean) {
	const check = (pass: boolean, what: string) => { if (pass === negate) assert.fail(`${message ? `${message}: ` : ""}expected ${show(actual)}${negate ? " not" : ""} ${what}`); };
	const m = {
		toBe: (e: unknown) => check(Object.is(actual, e), `to be ${show(e)}`),
		toEqual: (e: unknown) => {
			if (hasAsym(e)) return check(looseMatch(actual, e), `to equal ${show(e)}`);
			let pass = true; try { assert.deepStrictEqual(actual, e); } catch { pass = false; }
			check(pass, `to equal ${show(e)}`);
		},
		toMatchObject: (e: unknown) => check(looseMatch(actual, e, true), `to match object ${show(e)}`),
		toContain: (e: unknown) => {
			if (typeof actual === "string") { if (typeof e !== "string") refuse(`toContain needle must be string, got ${show(e)}`); }
			else if (!Array.isArray(actual)) refuse(`toContain received must be string or array, got ${show(actual)}`);
			return check(typeof actual === "string" ? actual.includes(e as string) : (actual as unknown[]).includes(e), `to contain ${show(e)}`);
		},
		toMatch: (e: RegExp | string) => {
			if (typeof actual !== "string") refuse(`toMatch received must be string, got ${show(actual)}`);
			pattern(e);
			if (e instanceof RegExp) e.lastIndex = 0;
			return check(typeof e === "string" ? (actual as string).includes(e) : e.test(actual as string), `to match ${show(e)}`);
		},
		toHaveLength: (n: number) => {
			if (actual === null || actual === undefined || typeof (actual as any).length !== "number") refuse(`toHaveLength received must have numeric length, got ${show(actual)}`);
			num(n, "toHaveLength expected");
			return check((actual as any).length === n, `to have length ${n}`);
		},
		toBeTruthy: () => check(!!actual, "to be truthy"),
		toBeDefined: () => check(actual !== undefined, "to be defined"),
		toBeUndefined: () => check(actual === undefined, "to be undefined"),
		toBeNull: () => check(actual === null, "to be null"),
		toBeGreaterThan: (n: number) => { num(actual, "received"); num(n, "expected"); return check((actual as number) > n, `to be greater than ${n}`); },
		toBeLessThan: (n: number) => { num(actual, "received"); num(n, "expected"); return check((actual as number) < n, `to be less than ${n}`); },
		toThrow: (e?: RegExp | string) => {
			if (typeof actual !== "function") refuse(`toThrow received must be a function, got ${show(actual)}`);
			if (e !== undefined) pattern(e);
			let thrown: unknown, did = false;
			try { (actual as () => unknown)(); } catch (err) { did = true; thrown = err; }
			const text = thrown instanceof Error ? thrown.message : String(thrown);
			check(did && (e === undefined || (typeof e === "string" ? text.includes(e) : e.test(text))), `to throw${e === undefined ? "" : ` ${show(e)}`}`);
		},
	};
	return m;
}

export function expect(actual: unknown, message?: string) {
	return Object.assign(matchers(actual, message, false), { not: matchers(actual, message, true) });
}
expect.arrayContaining = (sample: unknown[]) => new Asym("arrayContaining", sample);
expect.objectContaining = (sample: object) => new Asym("objectContaining", sample);
expect.stringMatching = (sample: RegExp | string) => new Asym("stringMatching", sample);
