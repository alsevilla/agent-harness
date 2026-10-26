// Reviewer contract: the candidate agent/agents/reviewer.md body is the role contract a benchmark reviewer session must carry.
// Parsed here without importing Pi. body = file text after the frontmatter, trimmed; digests cover the file bytes and the body.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function loadReviewerContract({ candidateRoot }) {
	const file = path.join(candidateRoot, "agent", "agents", "reviewer.md");
	if (!fs.existsSync(file)) throw new Error(`reviewer contract is missing: ${file}`);
	const bytes = fs.readFileSync(file);
	const text = bytes.toString("utf8");
	const m = FRONTMATTER.exec(text);
	if (!m) throw new Error(`reviewer contract has no frontmatter: ${file}`);
	const name = /^name:\s*(.+?)\s*$/m.exec(m[1])?.[1];
	if (name !== "reviewer") throw new Error(`reviewer contract name must be reviewer, got ${JSON.stringify(name ?? null)}: ${file}`);
	const body = text.slice(m[0].length).trim();
	if (body === "") throw new Error(`reviewer contract has an empty body: ${file}`);
	return { file, name, bytes: bytes.length, sha256: sha256(bytes), body, bodySha256: sha256(body) };
}
