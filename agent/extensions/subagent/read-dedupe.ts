// Duplicate-read skip for workers (after Ledger, arXiv 2608.00808, and CORVUS, arXiv 2607.22711: redundant re-reads of unchanged
// files are a large share of coding-agent cost). When a worker reads the same file and range again in one run and the read returns
// exactly the text it returned before, the new result is replaced by a one-line note pointing at the earlier copy. The note is the
// newest tool result, so the cached prompt prefix is untouched. Anything else passes through: changed content, another range, errors,
// images and other tools. An edit or write of the file, or a compaction (which may drop the earlier copy), forgets what was seen.
import { createHash } from "node:crypto";
import * as path from "node:path";
import { foldCase } from "./path-case.ts";

type Part = { type: string; text?: string };
type ReadInput = { path?: unknown; offset?: unknown; limit?: unknown };

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fileKey = (cwd: string, p: string) => foldCase(path.resolve(cwd, p.replace(/^@/, "")));

export function duplicateReadNote(file: string): string {
	return `[unchanged: this read returned exactly what it returned earlier in this run for ${file} (same range); use that earlier copy. Read again with a different offset or limit for another part.]`;
}

export function createReadDedupe() {
	// file key -> (range key -> hash of the text the read returned)
	const seen = new Map<string, Map<string, string>>();
	return {
		/** A replacement content array for a duplicate read, or undefined to keep the result as is. */
		onResult(toolName: string, input: unknown, content: unknown, isError: boolean, cwd: string): Part[] | undefined {
			const args = (input ?? {}) as ReadInput;
			if (typeof args.path !== "string" || !args.path) return undefined;
			const file = fileKey(cwd, args.path);
			if (toolName === "edit" || toolName === "write") { seen.delete(file); return undefined; }
			if (toolName !== "read" || isError || !Array.isArray(content) || content.length === 0) return undefined;
			if (!content.every((part: Part) => part?.type === "text" && typeof part.text === "string")) return undefined; // images and mixed results pass
			const text = (content as Part[]).map((part) => part.text).join("\n");
			const note = duplicateReadNote(args.path);
			const range = JSON.stringify([args.offset ?? null, args.limit ?? null]);
			const ranges = seen.get(file) ?? new Map<string, string>();
			// Match handoff collapsing: a reference must at least halve the output it replaces. A read too small for that is still the
			// latest copy of the range, so forget the earlier one: otherwise a later read that matches the earlier text would be called
			// unchanged although the copy just before it showed different text.
			if (note.length * 2 > text.length) { ranges.delete(range); return undefined; }
			const digest = hash(text);
			if (ranges.get(range) === digest) return [{ type: "text", text: note }];
			ranges.set(range, digest);
			seen.set(file, ranges);
			return undefined;
		},
		/** Forget every earlier read: compaction may have removed those copies. Shell changes need nothing, since only the read text decides. */
		reset(): void { seen.clear(); },
	};
}
