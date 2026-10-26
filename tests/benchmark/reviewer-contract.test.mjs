// Reviewer contract loader: the candidate agent/agents/reviewer.md is the executable contract; body and digests are recorded.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadReviewerContract } from "./lib/reviewer-contract.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function rootWith(text) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
	fs.mkdirSync(path.join(root, "agent", "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, "agent", "agents", "reviewer.md"), text);
	return root;
}

test("the real candidate reviewer contract: body is the file after frontmatter and both digests cover the exact bytes", () => {
	const file = path.join(REPO, "agent", "agents", "reviewer.md");
	const bytes = fs.readFileSync(file);
	const c = loadReviewerContract({ candidateRoot: REPO });
	assert.equal(c.file, file);
	assert.equal(c.name, "reviewer");
	assert.ok(c.body.startsWith("## Assigned module"), "the role body begins after the frontmatter");
	assert.ok(c.body.includes("You are the senior adversarial code reviewer."), "the contract's role text is in the body");
	assert.ok(!c.body.includes("tools: read, search, execute"), "no frontmatter in the body");
	assert.ok(bytes.toString("utf8").trimEnd().endsWith(c.body), "the body is the file tail, not a paraphrase");
	assert.equal(c.sha256, sha(bytes));
	assert.equal(c.bodySha256, sha(c.body));
	assert.equal(c.bytes, bytes.length);
});

test("CRLF line endings are read the same way and the body keeps the contract text", () => {
	const root = rootWith("---\r\nname: reviewer\r\ndescription: x\r\n---\r\n\r\nLine one.\r\nLine two.\r\n");
	const c = loadReviewerContract({ candidateRoot: root });
	assert.equal(c.body, "Line one.\r\nLine two.");
});

test("a contract whose name is not reviewer, that has no frontmatter, or that has an empty body is refused", () => {
	assert.throws(() => loadReviewerContract({ candidateRoot: rootWith("---\nname: general-worker\ndescription: x\n---\nBody\n") }), /name must be reviewer/);
	assert.throws(() => loadReviewerContract({ candidateRoot: rootWith("No frontmatter here.\n") }), /no frontmatter/);
	assert.throws(() => loadReviewerContract({ candidateRoot: rootWith("---\nname: reviewer\ndescription: x\n---\n\n   \n") }), /empty body/);
});

test("a missing candidate contract is refused, never replaced by an identity line", () => {
	assert.throws(() => loadReviewerContract({ candidateRoot: path.join(os.tmpdir(), "rc-absent-root") }), /reviewer contract is missing/);
});
