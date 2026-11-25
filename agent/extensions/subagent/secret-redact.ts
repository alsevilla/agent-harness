// Field report: the guard refused direct access to .env, but a worker's broad search over *.env* put the local reader health key in
// the session. A command guard cannot see every file a recursive search reads (`grep -r KEY .` names none), so tool results are
// also redacted: before a result reaches the session, every value held in a protected file under the working folder is replaced.
// Values are read here, in the guard's process, and never shown; only the replacement text enters the session.
import * as fs from "node:fs";
import * as path from "node:path";
import { isSecretBasename } from "./safety-core.ts";

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", "out", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache", "coverage"]);
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MIN_VALUE = 8;
const REFRESH_MS = 30_000;
export const REDACTED = "[redacted: value from a protected file]";

/** Protected files under root, by the guard's own secret-name rule (bounded walk; build and dependency folders skipped). */
export function protectedFiles(root: string): string[] {
	const found: string[] = [];
	let entries = 0;
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH || entries > MAX_ENTRIES) return;
		let list: fs.Dirent[];
		try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of list) {
			if (++entries > MAX_ENTRIES) return;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1); }
			else if (entry.isFile() && isSecretBasename(entry.name)) found.push(full);
		}
	};
	walk(root, 0);
	return found;
}

/** The secret values in one protected file: KEY=VALUE values (dotenv, .npmrc, .netrc lines) and, for key and JSON files, long tokens. */
export function secretValues(text: string): string[] {
	const values = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		// KEY=VALUE: only the value is secret; the key name stays readable, so a worker can see which settings exist.
		// .npmrc scopes a token to a registry (`//registry.npmjs.org/:_authToken=…`): the registry part is not secret. A value never starts
		// with "=", so base64 key lines ending in "==" are not read as assignments.
		const assign = /^(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*([^=\s].*)$/.exec(line) ?? /^\S*:_[A-Za-z]+\s*=\s*([^=\s].*)$/.exec(line) ?? /^"[^"]+"\s*:\s*("[^"]*")/.exec(line);
		const value = assign?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2").replace(/,$/, "").replace(/^(['"])(.*)\1$/, "$2");
		if (value && value.length >= MIN_VALUE) values.add(value);
		// Key material and JSON: long base64-like runs are secret whatever line they are on.
		for (const token of (assign ? value ?? "" : line).match(/[A-Za-z0-9+/_\-.~]{20,}={0,2}/g) ?? []) values.add(token);
	}
	return [...values].sort((a, b) => b.length - a.length);
}

/** A redactor for results under root: values are re-read when a protected file changes or every 30 seconds. */
export function createSecretRedactor(now: () => number = Date.now) {
	let cachedRoot = "";
	let readAt = 0;
	let values: string[] = [];
	const load = (root: string) => {
		if (root === cachedRoot && now() - readAt < REFRESH_MS) return;
		const next = new Set<string>();
		for (const file of protectedFiles(root)) {
			try {
				const st = fs.statSync(file);
				if (st.size > MAX_FILE_BYTES) continue;
				for (const v of secretValues(fs.readFileSync(file, "utf8"))) next.add(v);
			} catch { /* unreadable: nothing to redact from it */ }
		}
		values = [...next].sort((a, b) => b.length - a.length);
		cachedRoot = root; readAt = now();
	};
	return {
		/** Text parts with every protected value replaced; undefined when nothing changed. */
		onResult(content: unknown, root: string): unknown[] | undefined {
			if (!Array.isArray(content)) return undefined;
			try { load(root); } catch { return undefined; }
			if (!values.length) return undefined;
			let changed = false;
			const next = content.map((part: { type?: string; text?: unknown }) => {
				if (part?.type !== "text" || typeof part.text !== "string") return part;
				let text = part.text;
				for (const v of values) if (text.includes(v)) { text = text.split(v).join(REDACTED); changed = true; }
				return text === part.text ? part : { ...part, text };
			});
			return changed ? next : undefined;
		},
	};
}
