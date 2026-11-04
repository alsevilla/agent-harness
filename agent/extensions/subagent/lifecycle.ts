// Opt-in delivery lifecycle (merge OR release -> Learn -> exact checkout, _scratch and _evidence disposal). Pure filesystem helpers: Learn proof, ignored-cache classification, no-follow manifests, external receipts and manifest-checked removal. No Git, gh or authorization decisions live here; safety-core.ts wires them. The runtime (not a shell) removes artifact paths, only after the checkout-removal child closed cleanly.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { overlaps } from "./cleanup-state.ts";

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
const same = (a: string, b: string): boolean => fold(a.replace(/\\/g, "/").replace(/\/+$/, "")) === fold(b.replace(/\\/g, "/").replace(/\/+$/, ""));
// A folder equal to or inside the target (an ancestor of a target is not a problem for its removal).
export const isInside = (child: string, target: string): boolean => same(child, target) || fold(child.replace(/\\/g, "/")).startsWith(`${fold(target.replace(/\\/g, "/").replace(/\/+$/, ""))}/`);
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const absAscii = (p: unknown): p is string => typeof p === "string" && p.length <= 240 && /^(?:[A-Za-z]:)?\/[\x20-\x7e]*$/.test(p) && !p.includes("\\") && !p.split("/").slice(1).some((s) => s === "" || s === "." || s === ".." || /~\d/.test(s) || /[. ]$/.test(s));

// ---- Learn proof: runtime verifies presence, placement, hashes and the index link, never semantic quality.
export type LearnInput = { state: "SAVED"; record: string; index: string; recordSha256: string; indexSha256: string } | { state: "NO LESSON"; reason: string };
export const LEARN_STORE = "docs/knowledge/local";
const LEARN_FILE_MAX = 65536;

function plainFile(file: string, label: string): { bytes: Buffer } | string {
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile() || st.nlink !== 1) return `${label} is not a plain single-link file`;
		if (st.size < 1 || st.size > LEARN_FILE_MAX) return `${label} size is out of bounds`;
		if (!same(fs.realpathSync.native(file), file)) return `${label} path is an alias or link`;
		return { bytes: fs.readFileSync(file) };
	} catch { return `${label} cannot be read back`; }
}

// ignored(file): true when the primary's gitignore covers it (injected; safety-core runs git check-ignore).
export function verifyLearn(input: unknown, o: { primary: string; targets: string[]; ignored(file: string): boolean; recheck?: boolean }): { ok: true; summary: Record<string, string> } | { ok: false; reason: string } {
	const no = (reason: string) => ({ ok: false as const, reason: `Learn checkpoint refused: ${reason}` });
	const v = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
	if (v.state === "NO LESSON") {
		if (Object.keys(v).sort().join() !== "reason,state" || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 300) return no("NO LESSON needs exactly a short reason");
		return { ok: true, summary: { state: "NO LESSON", reason: v.reason } };
	}
	if (v.state !== "SAVED") return no("only SAVED or NO LESSON proceeds (BLOCKED or anything else retains)");
	if (Object.keys(v).sort().join() !== "index,indexSha256,record,recordSha256,state") return no("SAVED needs exactly record, index, recordSha256 and indexSha256");
	const { record, index } = v;
	if (!absAscii(record) || !absAscii(index) || !/^[0-9a-f]{64}$/.test(String(v.recordSha256)) || !/^[0-9a-f]{64}$/.test(String(v.indexSha256))) return no("record/index must be exact absolute ASCII forward-slash paths with sha256 hashes");
	const store = `${o.primary.replace(/\\/g, "/").replace(/\/+$/, "")}/${LEARN_STORE}/`;
	for (const f of [record, index]) {
		if (!fold(f).startsWith(fold(store)) || !f.endsWith(".md")) return no(`${f} is not a .md file under the primary's ${LEARN_STORE}/`);
		if (o.targets.some((t) => overlaps(f, t))) return no(`${f} lies inside a deletion target`);
	}
	if (path.posix.basename(index) !== "README.md" || same(record, index)) return no("index must be a scope README.md distinct from the record");
	const idxDir = path.posix.dirname(index);
	if (!fold(record).startsWith(fold(`${idxDir}/`))) return no("index must be in the record's folder or an ancestor within the local store");
	const rec = plainFile(record, "record");
	const idx = plainFile(index, "index");
	if (typeof rec === "string") return no(rec);
	if (typeof idx === "string") return no(idx);
	if (sha256(rec.bytes) !== v.recordSha256) return no("record hash differs from the stated hash");
	// The shared scope index may legitimately gain other links between mint and completion: the recheck keeps the link proof but not the index hash.
	if (!o.recheck && sha256(idx.bytes) !== v.indexSha256) return no("index hash differs from the stated hash");
	const rel = record.slice(idxDir.length + 1);
	const text = idx.bytes.toString("utf8");
	if (!text.includes(`](${rel})`) && !text.includes(`](./${rel})`)) return no("index does not link to the record");
	if (!o.ignored(record) || !o.ignored(index)) return no("record and index must be gitignored local files");
	return { ok: true, summary: { state: "SAVED", record, index, recordSha256: v.recordSha256 as string, indexSha256: v.indexSha256 as string } };
}

// ---- Ignored content classification (opt-in checkout only). Conservative allowlist of genuinely disposable generated caches; everything else is retained with its reason. Never .serena, .env, dist, build, target or databases.
const DISPOSABLE_TOP = /^(?:node_modules|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.nyc_output|\.turbo|\.eslintcache)\/?$/;
export function classifyIgnored(entries: string[]): { path: string; reason: string }[] {
	const kept: { path: string; reason: string }[] = [];
	for (const raw of entries) {
		const e = raw.replace(/\\/g, "/");
		const ok = DISPOSABLE_TOP.test(e) || /(?:^|\/)__pycache__\/(?:[^/]+\.pyc)?$/.test(e) || /^[^/]+\.tsbuildinfo$/.test(e);
		if (!ok) kept.push({ path: e, reason: "not a known disposable cache; unknown ignored data is retained" });
	}
	return kept;
}

// ---- No-follow manifests of plain directories and files.
export interface ManifestEntry { rel: string; kind: "dir" | "file"; size: number; mtimeMs: number; ino: number; dev: number }
export interface Manifest { root: { ino: number; dev: number }; entries: ManifestEntry[]; digest: string }
export const MANIFEST_MAX_ENTRIES = 5000;
const MANIFEST_MAX_DEPTH = 32;
const SIDECAR = /(?:\.(?:db|sqlite3?)|-(?:wal|shm|journal))$/i;
const SECRET = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|pfx|p12))$/i;

export function buildManifest(root: string): { ok: true; manifest: Manifest } | { ok: false; reason: string } {
	try {
		const rst = fs.lstatSync(root);
		if (!rst.isDirectory() || rst.isSymbolicLink()) return { ok: false, reason: "target is not a plain directory" };
		if (!same(fs.realpathSync.native(root), root)) return { ok: false, reason: "target path is an alias or link" };
		const entries: ManifestEntry[] = [];
		const stack: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
		while (stack.length) {
			const { dir, rel, depth } = stack.pop()!;
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const r = rel ? `${rel}/${e.name}` : e.name;
				if (entries.length >= MANIFEST_MAX_ENTRIES) return { ok: false, reason: `more than ${MANIFEST_MAX_ENTRIES} entries; too large to verify` };
				if (e.name === ".git" || e.name === ".retain") return { ok: false, reason: `${r}: nested repository or retention marker` };
				if (SIDECAR.test(e.name) || SECRET.test(e.name)) return { ok: false, reason: `${r}: database or secret-like name` };
				const full = path.join(dir, e.name);
				const st = fs.lstatSync(full);
				if (st.isSymbolicLink()) return { ok: false, reason: `${r}: link` };
				if (st.isDirectory()) {
					if (depth + 1 > MANIFEST_MAX_DEPTH) return { ok: false, reason: `${r}: too deep` };
					entries.push({ rel: r, kind: "dir", size: 0, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
					stack.push({ dir: full, rel: r, depth: depth + 1 });
				} else if (st.isFile()) {
					if (st.nlink !== 1) return { ok: false, reason: `${r}: hard link` };
					entries.push({ rel: r, kind: "file", size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
				} else return { ok: false, reason: `${r}: special file` };
			}
		}
		entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
		const rootId = { ino: rst.ino, dev: rst.dev };
		return { ok: true, manifest: { root: rootId, entries, digest: sha256(JSON.stringify([rootId, entries])) } };
	} catch (error) {
		return { ok: false, reason: `manifest could not be built: ${(error as NodeJS.ErrnoException).code ?? "read error"}` };
	}
}

// Removes exactly the approved manifest: freshness recheck first, then identity-checked unlink/rmdir bottom-up. Stops at the first problem; reports partial deletion; no retry or rollback. An unexpected new entry makes rmdir fail, never recursive deletion.
export function removeApproved(root: string, approved: Manifest): { state: "REMOVED" | "RETAINED" | "PARTIAL"; reason?: string; removed: number } {
	const now = buildManifest(root);
	if (!now.ok) return { state: "RETAINED", reason: now.reason, removed: 0 };
	if (now.manifest.digest !== approved.digest) return { state: "RETAINED", reason: "contents changed since approval (race or new data); retained", removed: 0 };
	let removed = 0;
	const depth = (e: ManifestEntry) => e.rel.split("/").length;
	const order = [...approved.entries.filter((e) => e.kind === "file"), ...approved.entries.filter((e) => e.kind === "dir").sort((a, b) => depth(b) - depth(a))];
	try {
		for (const e of order) {
			const full = path.join(root, ...e.rel.split("/"));
			const st = fs.lstatSync(full);
			if (st.ino !== e.ino || st.dev !== e.dev || (e.kind === "file" ? !st.isFile() || st.nlink !== 1 || st.size !== e.size : !st.isDirectory())) throw new Error(`${e.rel}: identity changed during removal`);
			if (e.kind === "file") fs.unlinkSync(full); else fs.rmdirSync(full);
			removed++;
		}
		const st = fs.lstatSync(root);
		if (st.ino !== approved.root.ino || st.dev !== approved.root.dev || !st.isDirectory()) throw new Error("root identity changed during removal");
		fs.rmdirSync(root);
		return { state: "REMOVED", removed: removed + 1 };
	} catch (error) {
		return { state: "PARTIAL", reason: `${(error as Error).message}; ${removed} of ${order.length + 1} entries removed, no retry or rollback`, removed };
	}
}

// ---- External receipts: outside all three targets, exclusive create (never overwritten), small facts only.
export function receiptDirOf(candidate: string): string {
	const c = candidate.replace(/\\/g, "/");
	return `${path.posix.dirname(c)}/_receipts/${path.posix.basename(c)}`;
}
export function writeReceipt(dir: string, name: string, data: unknown, targets: string[]): void {
	if (targets.some((t) => overlaps(dir, t))) throw new Error("receipt directory overlaps a deletion target");
	const group = path.posix.dirname(dir.replace(/\\/g, "/"));
	const gst = fs.lstatSync(path.posix.dirname(group));
	if (!gst.isDirectory() || !same(fs.realpathSync.native(path.posix.dirname(group)), path.posix.dirname(group))) throw new Error("receipt parent is not a canonical directory");
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.lstatSync(dir).isDirectory() || !same(fs.realpathSync.native(dir), dir)) throw new Error("receipt directory is an alias or link");
	fs.writeFileSync(path.join(dir, name), `${JSON.stringify(data, null, 1)}\n`, { flag: "wx" });
}

// ---- Plan carried by the parent (memory only) from mint to the cleanup child's confirmed close.
export interface LifecyclePlan {
	id: string; action: "merge" | "release"; version?: string; pr: number; branch: string; headSha: string; mergeCommit: string;
	primary: string; candidate: string; evidence: string; scratch: string; receiptDir: string; learnInput: unknown; learn: Record<string, string>;
	manifests: { scratch: Manifest; evidence: Manifest };
}
export interface LifecycleDeps {
	cleanExit: boolean;
	busy(target: string): string | undefined; // active owner worker/job overlapping the path
	checkoutGone(): string | undefined; // refusal reason, undefined when absent and unregistered
	learnRecheck(): string | undefined;
	cwds: string[]; // main and process cwd: never inside a target
	now(): number;
}
export interface LifecycleOutcome { state: "COMPLETE" | "PARTIAL" | "RETAINED"; checkout: { state: string; reason?: string }; scratch: { state: string; reason?: string; removed?: number }; evidence: { state: string; reason?: string; removed?: number }; receipt?: string; receiptError?: string }

export function completeLifecycle(plan: LifecyclePlan, deps: LifecycleDeps): LifecycleOutcome {
	const targets = [plan.candidate, plan.evidence, plan.scratch];
	const retain = (reason: string) => ({ state: "RETAINED", reason });
	let checkout: LifecycleOutcome["checkout"];
	let scratch: LifecycleOutcome["scratch"] = retain("not attempted");
	let evidence: LifecycleOutcome["evidence"] = retain("not attempted");
	const unclean = "the checkout-removal child did not close successfully";
	const gone = deps.checkoutGone();
	// An unclean close never authorizes artifact removal, but a checkout that is already gone is reported as gone (it cannot be retained).
	checkout = gone === undefined ? (deps.cleanExit ? { state: "REMOVED" } : { state: "REMOVED", reason: `already gone; ${unclean}` }) : retain(deps.cleanExit ? gone : unclean);
	const gate = !deps.cleanExit ? unclean : gone !== undefined ? `checkout not removed (${gone})` : deps.learnRecheck() ?? targets.map((t) => deps.busy(t)).find((r) => r !== undefined) ?? (deps.cwds.some((c) => targets.some((t) => isInside(c, t))) ? "a session folder lies inside a target" : undefined);
	if (gate !== undefined) { scratch = retain(gate); evidence = retain(gate); } else {
		scratch = removeApproved(plan.scratch, plan.manifests.scratch);
		evidence = scratch.state === "REMOVED" ? removeApproved(plan.evidence, plan.manifests.evidence) : retain("scratch stage did not succeed; evidence retained");
	}
	const state = checkout.state === "REMOVED" && scratch.state === "REMOVED" && evidence.state === "REMOVED" ? "COMPLETE" : [scratch, evidence].some((s) => s.state === "PARTIAL") ? "PARTIAL" : "RETAINED";
	const out: LifecycleOutcome = { state, checkout, scratch, evidence };
	try {
		writeReceipt(plan.receiptDir, `final-${plan.id}.json`, { v: 1, id: plan.id, action: plan.action, version: plan.version, pr: plan.pr, branch: plan.branch, headSha: plan.headSha, mergeCommit: plan.mergeCommit, learn: plan.learn, manifests: { scratch: plan.manifests.scratch.digest, evidence: plan.manifests.evidence.digest }, outcome: { state, checkout, scratch, evidence }, finishedAt: new Date(deps.now()).toISOString() }, targets);
		out.receipt = path.join(plan.receiptDir, `final-${plan.id}.json`);
	} catch (error) { out.receiptError = (error as Error).message; }
	return out;
}

export function formatOutcome(o: LifecycleOutcome, plan: LifecyclePlan): string {
	const f = (n: string, s: { state: string; reason?: string }) => `${n}: ${s.state}${s.reason ? ` (${s.reason})` : ""}`;
	return `LIFECYCLE ${o.state} for ${plan.action} of PR #${plan.pr} (runtime-verified outcome; metadata only, not delivery proof). ${f("checkout", o.checkout)}; ${f("scratch", o.scratch)}; ${f("evidence", o.evidence)}. Learn: ${plan.learn.state}. Receipt: ${o.receipt ?? `NOT WRITTEN (${o.receiptError})`}. Branches and commits preserved; no automatic retry, rollback or replay: a PARTIAL or RETAINED target needs operator disposition.`;
}
