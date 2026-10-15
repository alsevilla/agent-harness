// Role/shared prompt dedup contract: assembled child prompts keep every pre-dedup sentence except the listed redundant
// restatements, keep headings and frontmatter, and shrink where a restatement was removed.
import { afterAll, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Controlled "present" world: every integration file the FULL launch names exists in a temp profile; no ambient ~/.pi or ~/.graphify input.
const PROFILE = mkdtempSync(path.join(tmpdir(), "dedup-profile-"));
const EMPTY_GLOBAL = mkdtempSync(path.join(tmpdir(), "dedup-global-empty-"));
const FILES = {
	ponytailExt: path.join(PROFILE, "npm", "node_modules", "@dietrichgebert", "ponytail", "pi-extension", "index.js"),
	ponytailSkill: path.join(PROFILE, "npm", "node_modules", "@dietrichgebert", "ponytail", "skills", "ponytail-review", "SKILL.md"),
	serena: path.join(PROFILE, "npm", "node_modules", "@bacnh85", "pi-serena", "extensions", "index.ts"),
	graphifyExt: path.join(PROFILE, "npm", "node_modules", "graphify-pi", "extensions", "graphify.ts"),
	graphifySkill: path.join(PROFILE, "skills", "graphify", "SKILL.md"),
	qmd: path.join(PROFILE, "extensions", "qmd", "index.ts"),
};
for (const file of Object.values(FILES)) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "// controlled fixture\n"); }
afterAll(() => { fs.rmSync(PROFILE, { recursive: true, force: true }); fs.rmSync(EMPTY_GLOBAL, { recursive: true, force: true }); });
const FULL_LAUNCH = ["--extension", FILES.ponytailExt, "--extension", FILES.serena, "--extension", FILES.qmd, "--extension", FILES.graphifyExt, "--skill", FILES.graphifySkill, "--tools", "read,grep,find,ls,serena_find_symbol,qmd_search"];
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => PROFILE }));
const { assembleChildSystemPrompt, graphReferenceGuidance } = await import("../code-integrations.ts");

const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\\/g, "/").split(repo).join("<CANDIDATE>");
const sentences = (text: string) => normalize(text).split(/\n+|(?<=\.) /).map((s) => s.trim()).filter((s) => s.length >= 20);
const sentenceHashes = (text: string) => new Set(sentences(text).map((s) => sha(s).slice(0, 8)));
const frontmatterSha = (text: string) => sha(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1] ?? "");
// Exact [approved current value, original HEAD/golden value]; never consult roles.json while hashing.
const DECLARATION_CHANGES: Record<string, Partial<Record<string, readonly [string, string]>>> = {
	"api-specialist": { model: ["openai-codex/gpt-6.1-sol","anthropic/claude-haiku-5-5"], fallbackModel: ["anthropic/claude-sonnet-5-5","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"], thinking: ["high","medium"] },
	"architecture-specialist": { model: ["openai-codex/gpt-6.1-sol","anthropic/claude-haiku-5-5"], fallbackModel: ["anthropic/claude-sonnet-5-5","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"], thinking: ["high","medium"] },
	"concurrency-specialist": { model: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6-luna"], fallbackModel: ["anthropic/claude-sonnet-5-5","github-copilot/gpt-6-luna"], thinking: ["high","medium"] },
	"debugger": { fallbackModel: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6.1-sol || github-copilot/claude-sonnet-5"], thinking: ["high","medium"] },
	"devops-specialist": { model: ["anthropic/claude-sonnet-5-5","openai-codex/gpt-6-luna"], fallbackModel: ["openai-codex/gpt-6.1-sol","github-copilot/gpt-6-luna"] },
	"frontend-worker": { model: ["anthropic/claude-sonnet-5-5","anthropic/claude-haiku-5-5"], fallbackModel: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"], thinking: ["medium","low"] },
	"observability-specialist": { model: ["anthropic/claude-haiku-5-5","openai-codex/gpt-6-luna"], fallbackModel: ["openai-codex/gpt-6-luna","github-copilot/gpt-6-luna"] },
	"performance-specialist": { model: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6-luna"], fallbackModel: ["anthropic/claude-sonnet-5-5","github-copilot/gpt-6-luna"], thinking: ["high","medium"] },
	"reviewer": { fallbackModel: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6.1-sol || github-copilot/claude-sonnet-5"], thinking: ["high","medium"] },
	"general-worker": { fallbackModel: ["openai-codex/gpt-6-luna","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"], thinking: ["medium","low"] },
	"platform-worker": { fallbackModel: ["openai-codex/gpt-6-luna","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"] },
	"backend-worker": { model: ["anthropic/claude-sonnet-5-5","anthropic/claude-haiku-5-5"], fallbackModel: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"], thinking: ["medium","low"] },
	"scout": { fallbackModel: ["openai-codex/gpt-6-luna","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"] },
	"security-specialist": { model: ["openai-codex/gpt-6.1-sol","anthropic/claude-sonnet-5-5"], fallbackModel: ["anthropic/claude-sonnet-5-5","openai-codex/gpt-6.1-sol || github-copilot/claude-sonnet-5"], thinking: ["high","medium"] },
	"database-specialist": { model: ["openai-codex/gpt-6.1-sol","anthropic/claude-haiku-5-5"], fallbackModel: ["anthropic/claude-sonnet-5-5","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"], thinking: ["high","medium"] },
	"database-worker": { fallbackModel: ["openai-codex/gpt-6-luna","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"] },
	"test-engineer": { fallbackModel: ["openai-codex/gpt-6-luna","openai-codex/gpt-6-luna || github-copilot/gpt-6-luna"] },
	"ui-ux-specialist": { fallbackModel: ["openai-codex/gpt-6.1-sol","github-copilot/claude-sonnet-5"], thinking: ["high","medium"] },
	"release-engineer": { model: ["openai-codex/gpt-6.1-sol","openai-codex/gpt-6-luna"], fallbackModel: ["anthropic/claude-sonnet-5-5","github-copilot/gpt-6-luna"], tools: ["read, grep, find, ls, bash, powershell, edit, write","read, grep, find, ls, bash, powershell, edit"] },
};
const effectiveLegacyHeaderSha = (text: string) => {
	const normalized = text.replace(/\r\n/g, "\n");
	const header = /^---\n([\s\S]*?)\n---/.exec(normalized)?.[1];
	assert.ok(header, "live role must have a YAML header");
	const lines = header.split("\n");
	const metadata = new Map<string, string>();
	let inMetadata = false;
	for (const line of lines) {
		if (line === "metadata:") { inMetadata = true; continue; }
		if (inMetadata && /^  pi\.(model|fallbackModel|thinking|tools): /.test(line)) {
			const match = /^  pi\.(model|fallbackModel|thinking|tools): (.*)$/.exec(line)!;
			metadata.set(match[1], match[2].replace(/^['\"]|['\"]$/g, ""));
		} else if (inMetadata && !line.startsWith("  ")) inMetadata = false;
	}
	for (const field of ["model", "fallbackModel", "thinking", "tools"] as const) {
		assert.ok(metadata.has(field), `live role missing metadata pi.${field}`);
		const value = metadata.get(field)!;
		if (field === "fallbackModel") assert.ok(value.length > 0 || /^['\"]{2}$/.test(lines.find((line) => line.startsWith("  pi.fallbackModel: "))!.split(": ")[1]), "pi.fallbackModel must be a string");
		else assert.ok(value.trim().length > 0, `metadata pi.${field} must be nonempty`);
	}
	const identity = lines.filter((line) => /^(name|description): /.test(line));
	assert.deepEqual(identity.map((line) => line.split(":", 1)[0]), ["name", "description"]);
	const legacy = [...identity, ...["model", "fallbackModel", "thinking", "tools"].map((field) => {
		let value = metadata.get(field)!;
		const role = /^name: (.+)$/m.exec(header)?.[1];
		const approved = DECLARATION_CHANGES[role ?? ""]?.[field];
		if (approved) {
			assert.equal(value, approved[0], `${role} approved pi.${field} value changed`);
			value = approved[1];
		}
		return `${field}: ${value === "" ? '""' : value}`;
	})].join("\n");
	return sha(legacy);
};
const bodyOf = (text: string) => text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");

// Redundant restatements removed by the dedup. Each is already stated by the Leaf boundary paragraph of the same prompt.
const REDUNDANT = ["Never spawn another agent.", "Never spawn helpers."];
const REDUNDANT_HASHES = new Set(REDUNDANT.flatMap((s) => [...sentenceHashes(s)]));
// Privacy neutralization of pinned live role sentences (source wording, checked against the pre-change HEAD sentences): `from` is the pre-change sentence hash, `to` the generic replacement. Exempt only these exact role/hash pairs.
const PRIVACY_NEUTRALIZED = [
	{ role: "observability-specialist", from: "014b3dd7", to: "Never log device identifiers, account or contact data merely for convenience." },
	{ role: "performance-specialist", from: "e7084086", to: "- external notification/network latency." },
	{ role: "performance-specialist", from: "3e3eb18f", to: "For externally driven bursts such as device taps, open arrival-rate testing is" },
	{ role: "backend-worker", from: "741e9d34", to: "- `concurrency-specialist`;" },
	{ role: "observability-specialist", from: "741e9d34", to: "- `concurrency-specialist`;" },
	{ role: "release-engineer", from: "c503145c", to: 'gh pr create --repo acme/widgets --base main --head feat/x --title "Add delivery grant" --body-file "D:/work/worktrees/app/_evidence/task/pr.md"' },
	{ role: "release-engineer", from: "5deee955", to: 'gh pr merge 12 --repo acme/widgets --squash --match-head-commit 0123456789abcdef0123456789abcdef01234567 --subject "Add delivery grant" --body-file "D:/work/worktrees/app/_evidence/task/pr.md"' },
	{ role: "release-engineer", from: "08b235a8", to: 'gh release create v1.2.3 --repo acme/widgets --target 0123456789abcdef0123456789abcdef01234567 --title "v1.2.3" --notes-file "D:/work/worktrees/app/_evidence/task/notes.md" --latest' },
];

// Reviewed closed-world disposition of every BEFORE sentence hash that is not kept verbatim, for the controlled world (FULL launch, cwd = candidate root with no Cargo manifest, empty global corpus).
// relocated: `after` hash must be present. conditional: present only under a launch/state this world lacks, so absent here. design: the ambient ~/.graphify corpus is no longer injected; the text appears only on a manifest coverage match.
// BEFORE presence is asserted from the fixture for each live role; AFTER presence/absence is asserted per role.
type Disposition = { before: string; after?: string; status: "relocated" | "conditional" | "design"; note: string };
const DISPOSITIONS: Disposition[] = [
	{ before: "20dcff88", status: "conditional", note: "reviewer-only Ponytail skip; the Not-loaded note carries it when Ponytail is absent" },
	{ before: "69c6fb7f", after: "6a79e63f", status: "relocated", note: "qmd_search lookup, gated on the qmd capability" },
	{ before: "832b5c7c", status: "conditional", note: "graphify-out orientation; graph block emits it only when project artifacts exist" },
	{ before: "915411cd", after: "056902e3", status: "relocated", note: "Serena navigation, gated on the serena capability" },
	{ before: "ea758c07", after: "056902e3", status: "relocated", note: "read/grep fallback merged into the Serena navigation sentence" },
	{ before: "ae3b6e3b", after: "f12c81e6", status: "relocated", note: "graphify skill navigation, gated on the graphify skill argv" },
	{ before: "34627530", status: "conditional", note: "optional-integration absence; carried only by the Not-loaded note when an integration file is missing" },
	{ before: "074e5831", after: "01353c38", status: "relocated", note: "integration authority, merged into the core Integration and graph authority section" },
	{ before: "be8cca50", after: "01353c38", status: "relocated", note: "same core sentence" },
	{ before: "360b7d6a", status: "conditional", note: "Rust detail; emitted only when a Cargo manifest is structurally near cwd" },
	{ before: "2a809068", status: "conditional", note: "Rust detail (Cargo-gated)" },
	{ before: "2125e9c4", status: "conditional", note: "Rust detail (Cargo-gated)" },
	{ before: "f3658a1a", status: "conditional", note: "Rust detail (Cargo-gated)" },
	{ before: "ec635c7d", status: "conditional", note: "heading ## Rust build output (Cargo-gated)" },
	{ before: "214ea5bb", after: "413b33e3", status: "relocated", note: "Serena candidate-project rule, gated on the serena capability" },
	{ before: "c9a4d289", after: "09792437", status: "relocated", note: "QMD shared-index rule, gated on the qmd capability" },
	{ before: "0756fda6", status: "design", note: "heading ## Global graph reference; manifest coverage match only" },
	{ before: "b7bbed84", status: "design", note: "ambient ~/.graphify path; matched block only" },
	{ before: "559d0391", status: "design", note: "ambient ~/.graphify wiki path; matched block only" },
	{ before: "bbad72ba", status: "design", note: "ambient coverage manifest path; matched block only" },
	{ before: "d4992c7c", status: "design", note: "ambient manifest repository list; only matched repository names are listed" },
	{ before: "a01e3c84", status: "design", note: "unmatched 'coverage is not established' text; unmatched corpus is not injected" },
	{ before: "ccf6ce1d", status: "design", note: "no-artifact graph text; unmatched branch removed" },
	{ before: "c0fbf21b", status: "design", note: "matched global block preface" },
	{ before: "a52f15e1", status: "design", note: "matched global block" },
	{ before: "1e785f42", status: "design", note: "matched global block: 'Do not use it as the candidate's graph or an automatic fallback.'" },
	{ before: "06a13f49", status: "design", note: "matched global block" },
	{ before: "6f9dd750", status: "design", note: "unmatched-only sentence; removed" },
	{ before: "7421c3a3", status: "design", note: "matched global block only ('No project Graphify artifacts were found at dispatch...')" },
	{ before: "1cc8e17d", status: "design", note: "unmatched-only sentence; removed" },
];
// AFTER-only sentences that are not relocation targets: the core graph write-authority sentence (stated once) and the core heading.
const NEW_AFTER = ["c708d8e8", "33322dbf"];
// Reviewed F1 rewrite of frontend-worker (framework-aware role). The BEFORE fixture is unchanged; these are the reviewed post-change frontmatter sha and sentence hashes for that one role only.
// REPAIR_REMOVED: pre-change sentences replaced by the rewrite. REPAIR_ADDED: the rewrite's new sentences and the cleanup/SSR bullet. Texts are recorded in REPORT-repairs.md.
const FRONTMATTER_REVIEWED: Record<string, string> = { "live/frontend-worker": "8d0b2d833e11d4f0ac00b282808a981371f1e566ae5c51f718eac3d997635ae5", "live/backend-worker": "413f9b80a968b35c772de6e61e90677566c5adcc82a53fd7483d51cfefa2b0b8" };
const REPAIR_REMOVED: Record<string, string[]> = { "release-engineer": ["f699bace", "2e241d33", "ca7fc9b0", "4a288cfa", "eb933c8b", "24903de1"], "observability-specialist": ["352cefa2"], "performance-specialist": ["4eaee567"], "frontend-worker": ["ef6bfdd1", "809e0349", "81f68bf7", "7a05c296", "ba078546", "b8738a30", "9cfb3248", "8dedf6b8"], "backend-worker": ["d6f02acf", "809e0349", "34a6b7f8", "0dd2503e", "8c068932", "5a521f05", "352cefa2", "39505c25", "983bc1d2", "ac1eeda5", "fef43aea", "8446cd4c"] };
const REPAIR_ADDED: Record<string, string[]> = { "release-engineer": ["b42adbaf", "bb06c5da", "e5faf136", "d74bada9", "be39a328", "0664b001", "fb0ca904", "cbfbbd34", "783eb494", "837d4d6e", "640c0eec", "ef50b27a", "eece1ded", "01c6f29a", "33e831fb", "343cb215", "8a5de7bc", "83fd4fcc", "b002e4da", "3071e855", "9c5c7203", "4e315760", "9056f070", "14027cde", "4902dcff", "b347025f", "b599e61b", "d24b80df", "020610b4", "3f459c5e", "5b9429cd", "5bd5093c", "76d48a37"], "observability-specialist": ["269b2e9c"], "performance-specialist": ["a28096a2"], "frontend-worker": ["23526e31", "eec9fd3e", "8ba06bdf", "36abc239", "7d96f658", "e8bd257a", "3de47273", "9e95f556", "71b76b07", "b773fe52", "a2b4909c", "41d10c28"], "backend-worker": ["ba103e70", "7dfc5144", "bdf4c6d5", "d429435b", "432e1f2a", "269b2e9c", "ec086136", "18b9b701", "e28b3bcf", "0a137b78", "1afbaf10", "6b53e3dd"] };
// Reviewed stack-guidance additions of this change: exact lines added at paragraph boundaries of the owning live role bodies (no existing sentence or heading changed).
// Only lines of 20+ characters are hashed as sentences, matching sentences() above.
const STACK_ADDED: Record<string, string[]> = {
	"backend-worker": [
		"- For C# and ASP.NET Core, use the SDK pinned by the project, async APIs end to end, and pass CancellationToken through I/O.",
		"- Keep ASP.NET Core endpoints thin: validate input at the boundary, map failures to ProblemDetails and never leak exception text.",
		"- Use parameterized SQL only (ADO.NET parameters, Dapper or EF Core parameters); never concatenate caller input into SQL text.",
		"- Migrations are safe by default: additive and forward-only first, batched backfill, and destructive drops only in a later reviewed change.",
		"- REST behaviour follows the accepted API contract; status codes, resource names and pagination changes go to api-specialist first.",
	],
	"frontend-worker": [
		"**React and TypeScript notes (apply when the project uses React; the SolidJS rules below stay conditional on SolidJS):**",
		"- Use function components and hooks; keep effects for synchronizing with external systems, not for derived state.",
		"- Type props, events and API responses explicitly; avoid any and unchecked casts.",
		"- Derive values during render and memoize only when a measured cost justifies it.",
		"- Keep server data fetching behind the project's existing data or query layer, not ad hoc fetch calls in components.",
		"- Test behaviour with the project's existing runner and React Testing Library queries, not implementation details.",
	],
	"observability-specialist": [
		"**NRQL notes:**",
		"- NRQL is New Relic's query language and is not SQL, so do not carry SQL idioms into it.",
		"- Bound every query with SINCE and UNTIL and facet deliberately, because unbounded queries cost time and money.",
		"- Dashboard, alert and workload changes alter shared observability state and need explicit authority before any write.",
		"- Analysis queries stay read-only; NerdGraph or New Relic API writes are never implied by query design.",
		"**Grafana and Kiali notes:**",
		"- Grafana dashboards, queries and alert rules: advise on panels, queries and alert conditions; `platform-worker` implements approved provisioning or configuration changes.",
		"- Kiali: diagnose service-mesh traffic, routing and mTLS behaviour from evidence; mesh configuration changes go to `platform-worker` once approved.",
		"- Alert thresholds and severities come from the team's approved policy; never invent them.",
		"- Diagnosis stays read-only; no Grafana or Kiali write is implied by it.",
	],
	"api-specialist": [
		"**REST contract notes:**",
		"- Name resources as nouns, use HTTP methods for their meaning, and keep status codes consistent across endpoints.",
		"- Define pagination, filtering and the error shape (ProblemDetails or the project's existing format) before implementation starts.",
		"- Version breaking changes explicitly and record what each consumer must change.",
		"- Unsafe retries that change state need an idempotency key or a conditional request such as If-Match.",
	],
	"general-worker": [
		"**Jira JQL, Confluence CQL and gh or curl automation:**",
		"- JQL is the Jira Query Language; Confluence search uses CQL, and the two are not interchangeable.",
		"- Use bounded JQL and CQL queries with explicit project keys, space keys and date ranges; avoid unbounded scans.",
		"- Automate gh and curl read-first: list and view before any create, edit, merge, comment or transition.",
		"- Writes to Jira, Confluence or GitHub need explicit authority for the exact target; a missing or failed grant stops that step.",
		"- Never place tokens on the command line or print them; read credentials from the environment without echoing them.",
	],
	"security-specialist": [
		"**Scanner policy (Snyk, SonarQube, Prisma Cloud):** you own unresolved vulnerability, IAM and compliance policy questions these scanners raise. Advise on accepted risk, exceptions and policy; never suppress findings or set thresholds yourself. `platform-worker` wires the CI gates to the policy that main or the user approves.",
	],
	"devops-specialist": [
		"**Platform handoff:** accepted infrastructure file changes (Terraform, Kubernetes, Helm, Azure CLI, FluxCD) go to `platform-worker` for editing; this role stays read-only and never applies them.",
	],
};

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/role-prompt-dedup.before.json", import.meta.url), "utf8")) as {
	entries: Record<string, { chars: number; frontmatterSha: string; headings: string[]; sentenceHashes: string[] }>;
};
// Only live (agent/) shapes remain: the retired pi-package defaults shape was removed with the pi-package layout.
function assembled(shape: string, role: string): { text: string; sourceText: string } {
	assert.equal(shape, "live");
	assert.notEqual(role, "sqlite-specialist", "retired role fixture must not be assembled as a live role");
	const sourceText = fs.readFileSync(new URL(`../../../agents/${role}.md`, import.meta.url), "utf8");
	const agent = { name: role, systemPrompt: bodyOf(sourceText), source: "user", filePath: "", description: role, tools: [] };
	return { text: assembleChildSystemPrompt(agent as never, { codeIntegrationsEnabled: true, cwd: repo, packageRoot: null, launchArgs: FULL_LAUNCH, qmdExtension: FILES.qmd, globalGraphDirectory: EMPTY_GLOBAL }), sourceText };
}

test("release cleanup policy assigns only safe post-merge task-owned removal to release engineer", () => {
	const release = fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
	const ship = fs.readFileSync(new URL("../../../skills/engineering-harness/ship/index.md", import.meta.url), "utf8");
	const worktree = fs.readFileSync(new URL("../../../skills/engineering-harness/worktree/index.md", import.meta.url), "utf8");
	const learn = fs.readFileSync(new URL("../../../skills/engineering-harness/learn/index.md", import.meta.url), "utf8");
	assert.match(release, /release engineer owns\s+safe cleanup of explicitly named task-owned worktrees/i);
	assert.match(ship, /release engineer owns\s+safe cleanup of explicitly named task-owned worktrees/i);
	assert.match(worktree, /release engineer owns\s+safe cleanup of explicitly named task-owned worktrees/i);
	for (const text of [release, ship, worktree, learn]) {
		assert.match(text, /knowledge-disposition checkpoint/i);
		assert.match(text, /SAVED/);
		assert.match(text, /NO LESSON/);
		assert.match(text, /BLOCKED/);
		assert.match(text, /archive|report/i);
	}
	for (const text of [release, worktree]) {
		assert.match(text, /git worktree remove/);
		assert.match(text, /(?:without|no)\s+`?--force`?/);
		assert.match(text, /CLEANUP_PENDING/);
		assert.match(text, /(?:missing terminal or quiescence|quiescence evidence)/i);
	}
});

const skillText = (rel: string) => fs.readFileSync(new URL(`../../../skills/engineering-harness/${rel}`, import.meta.url), "utf8");

test("post-merge cleanup removes exactly three named targets and never bulk-copies, archives, sweeps or forces", () => {
	const worktree = skillText("worktree/index.md");
	assert.ok(worktree.includes("The cleanup set is exactly three targets"), "exactly three targets");
	assert.match(worktree, /`git worktree remove <exact absolute path>`[^\n]{0,40}no `--force`/);
	assert.ok(worktree.includes("exact `_evidence/<task>` directory"), "exact evidence target");
	assert.ok(worktree.includes("exact `_scratch/<task>` directory"), "exact scratch target");
	assert.ok(worktree.includes("host-appropriate removal operation"), "packet supplies exact removal operation per target");
	assert.ok(worktree.includes("one exact path at a time"), "artifact directories removed one exact path at a time");
	assert.ok(!worktree.includes("The cleanup set is exactly three paths"), "old three-paths wording removed");
	assert.ok(!worktree.includes("unique evidence is preserved outside every deletion target"), "contradictory unique-evidence wording removed");
	for (const term of ["no archive-by-default", "no bulk copy", "no sweep", "no wildcard", "no parent-directory removal", "no prune", "no branch deletion"]) assert.ok(worktree.includes(term), term);
});

test("post-merge cleanup waits for the knowledge checkpoint; a BLOCKED checkpoint retains the target and never rolls back the merge", () => {
	assert.ok(skillText("worktree/index.md").includes("runs once the knowledge checkpoint is SAVED"), "worktree: canonical knowledge gate before cleanup");
	assert.ok(skillText("worktree/index.md").includes("or after a NO LESSON checkpoint"), "worktree: NO LESSON alternative");
	assert.ok(skillText("ship/index.md").includes("worktree/index.md"), "ship points to the canonical knowledge gate");
	assert.ok(!skillText("ship/index.md").includes("merged state includes"), "ship does not duplicate the gate paragraph");
	const worktree = skillText("worktree/index.md");
	assert.ok(worktree.includes("BLOCKED knowledge checkpoint"), "BLOCKED retention");
	assert.ok(worktree.includes("never rolls back the merge"), "no rollback of merge");
	assert.ok(worktree.includes("may be saved locally outside the deletion targets"), "late local lesson stays outside targets");
	assert.ok(worktree.includes("cannot be claimed as already published"), "shared copy is not claimed as published");
});

test("shared publication is verified from a freshly fetched base by blob id, never by squash-prone commit ancestry; a destination inside a deletion target is never durable", () => {
	const worktree = skillText("worktree/index.md");
	for (const term of ["freshly fetched remote base", "git fetch", "git rev-parse", "git -C <exact checkout path> hash-object", "not commit ancestry", "A destination inside any of the three deletion targets is not durable"]) assert.ok(worktree.includes(term), term);
	const release = fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
	assert.match(release, /worktree\/index\.md/, "release-engineer points to the canonical cleanup gate");
	assert.match(release, /local SAVED[\s\S]{0,160}outside every cleanup target/);
});

test("cleanup retains a target with unique or unreproduced required evidence or user data; no default archive or bulk copy", () => {
	assert.match(skillText("worktree/index.md"), /unique or unreproduced[^.]{0,120}RETAINED/);
	assert.ok(skillText("worktree/index.md").includes("not copied or archived by default"), "no default archive or bulk copy");
});

test("release-engineer body mirrors the exact three-target cleanup and keeps arbitrary directory deletion forbidden", () => {
	const release = fs.readFileSync(new URL("../../../agents/release-engineer.md", import.meta.url), "utf8");
	assert.match(release, /exact `_evidence\/<task>` and `_scratch\/<task>` directories the packet names/);
	assert.match(release, /arbitrary directory deletion/);
	assert.match(release, /wildcard, sweep/);
});

test("public README cleanup section distinguishes authorized exact task artifact deletion from arbitrary directories", () => {
	const readme = fs.readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
	const section = /## Worktree placement and disposition\r?\n([\s\S]*?)\r?\n## /.exec(readme)?.[1] ?? "";
	assert.ok(section.length > 0, "cleanup section present");
	assert.ok(section.includes("exact `_evidence/<task>` and `_scratch/<task>` directories"), "exact artifact targets");
	assert.ok(section.includes("arbitrary directories are never deleted"), "arbitrary directories forbidden");
	assert.ok(!section.includes("Main performs disposition"), "release engineer performs; main schedules");
});

test("post-merge cleanup retains active, paused, service, database, shared, unique, unauthorized and unmerged targets with a concrete reason", () => {
	const worktree = skillText("worktree/index.md");
	for (const term of ["active or paused job", "-wal", "-shm", "explicit retention", "missing authority", "shared or uniquely owned data", "user data", "Unmerged or PR-only candidates are retained"]) assert.ok(worktree.includes(term), term);
});

test("post-merge cleanup keeps temp, log and report destinations outside every deletion target; no file is recreated after delete", () => {
	const worktree = skillText("worktree/index.md");
	for (const term of ["temp, log and report destinations lie outside all three deletion targets", "inline or approved external report", "no file is recreated in a removed target"]) assert.ok(worktree.includes(term), term);
});

test("legacy worktree, ship and learn guide.md files are tiny pointers to the same-folder canonical index.md, not independent procedures", () => {
	for (const mod of ["worktree", "ship", "learn"]) {
		const guide = skillText(`${mod}/guide.md`);
		const lines = guide.split(/\r?\n/).filter((line) => line.trim() !== "");
		assert.ok(guide.length <= 500 && lines.length <= 4, `${mod}/guide.md: pointer-only, got ${guide.length} chars / ${lines.length} lines`);
		assert.equal(lines.filter((line) => /^#{1,6} /.test(line)).length, 1, `${mod}/guide.md: at most one heading`);
		assert.match(guide, /`index\.md`/, `${mod}/guide.md: names the same-folder canonical index.md`);
		assert.match(guide, /canonical/i, `${mod}/guide.md: states canonical authority`);
		for (const old of [/Before mutation|Before an authorized commit|Confirm:|Placement|relocation|Completion and cleanup|Optional retrospective|Three-incident|git worktree remove|CLEANUP_PENDING|Do not run SHIP|Capture only stable|\bLEARN\b|\bSHIP\b/]) assert.doesNotMatch(guide, old, `${mod}/guide.md: restates the old procedure`);
		assert.ok(skillText(`${mod}/index.md`).includes("## "), `${mod}/index.md: canonical procedure exists`);
	}
});

test("declaration normalization rejects unapproved identity, tool and approved-field changes", () => {
	const source = fs.readFileSync(new URL("../../../agents/api-specialist.md", import.meta.url), "utf8");
	const changed = (from: string, to: string) => {
		const result = source.replace(from, to);
		assert.notEqual(result, source, "negative control must mutate the current header");
		return result;
	};
	const currentHeader = effectiveLegacyHeaderSha(source);
	assert.notEqual(effectiveLegacyHeaderSha(changed('pi.tools: "read, grep', 'pi.tools: "write, grep')), currentHeader);
	assert.notEqual(effectiveLegacyHeaderSha(changed("name: api-specialist", "name: changed-role")), currentHeader);
	assert.notEqual(effectiveLegacyHeaderSha(changed("description: Read-only", "description: Changed")), currentHeader);
	for (const field of ["model", "fallbackModel", "thinking"]) {
		const current = DECLARATION_CHANGES["api-specialist"][field]![0];
		assert.throws(() => effectiveLegacyHeaderSha(changed('pi.' + field + ': "' + current + '"', 'pi.' + field + ': "unauthorized/value"')), /approved pi\./);
	}
});

// Closed world: every BEFORE hash that is missing AFTER, and every AFTER hash that is new, must be a reviewed disposition for that role. Nothing else may change.
const HEADINGS_ABSENT_HERE = ["## Rust build output", "## Global graph reference (separate corpus)"];
const HEADINGS_NEW_HERE = ["## Integration and graph authority"];
test("every role/profile keeps frontmatter; sentences and headings change only by the reviewed closed-world mapping", () => {
	for (const [key, before] of Object.entries(fixture.entries)) {
		const [shape, role] = key.split("/");
		if (key === "live/sqlite-specialist") continue; // Historical fixture retained; explicitly retired live role.
		const { text, sourceText } = assembled(shape, role);
		assert.equal(effectiveLegacyHeaderSha(sourceText), FRONTMATTER_REVIEWED[key] ?? before.frontmatterSha, `${key} effective Pi declarations changed`);
		const heads = [...text.matchAll(/^## .*$/gm)].map((m) => m[0]);
		for (const h of HEADINGS_ABSENT_HERE) assert.ok(before.headings.includes(h), `${key}: BEFORE presence proof missing for ${h}`);
		assert.deepEqual(before.headings.filter((h) => !heads.includes(h)).sort(), HEADINGS_ABSENT_HERE.slice().sort(), `${key} headings lost`);
		assert.deepEqual(heads.filter((h) => !before.headings.includes(h)).sort(), HEADINGS_NEW_HERE, `${key} headings added`);

		const after = sentenceHashes(text);
		const beforeSet = new Set(before.sentenceHashes);
		for (const d of DISPOSITIONS) assert.ok(beforeSet.has(d.before), `${key}: BEFORE presence proof missing for ${d.before} (${d.note})`);
		const privacy = PRIVACY_NEUTRALIZED.filter((p) => p.role === role);
		for (const p of privacy) assert.ok(beforeSet.has(p.from), `${key}: BEFORE presence proof missing for privacy ${p.from}`);
		const redundantHere = [...REDUNDANT_HASHES].filter((h) => beforeSet.has(h));
		assert.equal(redundantHere.length, 1, `${key}: exactly one redundant restatement expected before`);

		const expectedMissing = [...DISPOSITIONS.map((d) => d.before), ...privacy.map((p) => p.from), ...redundantHere, ...(REPAIR_REMOVED[role] ?? [])].sort();
		const actualMissing = before.sentenceHashes.filter((h) => !after.has(h)).sort();
		assert.deepEqual(actualMissing, expectedMissing, `${key}: sentences lost outside the reviewed mapping`);

		for (const d of DISPOSITIONS) {
			if (d.after) assert.ok(after.has(d.after), `${key}: relocated target ${d.after} for ${d.before} missing`);
			else assert.equal(after.has(d.before), false, `${key}: ${d.before} (${d.status}) should be absent in this world`);
		}

		const expectedAdded = [...DISPOSITIONS.flatMap((d) => (d.after ? [d.after] : [])), ...NEW_AFTER, ...(REPAIR_ADDED[role] ?? []), ...privacy.map((p) => sha(p.to).slice(0, 8)), ...(STACK_ADDED[role] ?? []).flatMap((s) => sentences(s)).map((s) => sha(s).slice(0, 8))].filter((h) => !beforeSet.has(h));
		const actualAdded = [...after].filter((h) => !beforeSet.has(h));
		assert.deepEqual([...new Set(actualAdded)].sort(), [...new Set(expectedAdded)].sort(), `${key}: sentences added outside the reviewed mapping`);
	}
});

// Structural applicability: the Rust detail follows a Cargo manifest near the working directory, not the role name.
test("Rust build detail is emitted only when a Cargo manifest is structurally near the working directory", () => {
	const withCargo = mkdtempSync(path.join(tmpdir(), "dedup-cargo-"));
	mkdirSync(path.join(withCargo, ".git"));
	writeFileSync(path.join(withCargo, "Cargo.toml"), "[package]\nname = \"x\"\n");
	const withoutCargo = mkdtempSync(path.join(tmpdir(), "dedup-nocargo-"));
	mkdirSync(path.join(withoutCargo, ".git"));
	const agent = { name: "general-worker", systemPrompt: "ROLE BODY" } as never;
	const options = { codeIntegrationsEnabled: true, packageRoot: null, launchArgs: FULL_LAUNCH, qmdExtension: FILES.qmd, globalGraphDirectory: EMPTY_GLOBAL };
	assert.match(assembleChildSystemPrompt(agent, { ...options, cwd: withCargo }), /## Rust build output/);
	assert.doesNotMatch(assembleChildSystemPrompt(agent, { ...options, cwd: withoutCargo }), /## Rust build output/);
});

test("the historical sqlite-specialist fixture is explicitly retired and has no live prompt source", () => {
	assert.ok(fixture.entries["live/sqlite-specialist"], "preserve immutable historical baseline");
	assert.ok(!fs.existsSync(new URL("../../../agents/sqlite-specialist.md", import.meta.url)));
	assert.ok(fs.existsSync(new URL("../../../agents/database-specialist.md", import.meta.url)));
});

test("the redundant no-helper restatements are absent from every assembled prompt that stated them", () => {
	const offenders: string[] = [];
	for (const [key, before] of Object.entries(fixture.entries)) {
		const [shape, role] = key.split("/");
		if (role === "sqlite-specialist") continue; // Historical fixture retained; role retired in favor of database-specialist.
		const after = sentenceHashes(assembled(shape, role).text);
		if (before.sentenceHashes.some((h) => REDUNDANT_HASHES.has(h))) for (const h of REDUNDANT_HASHES) if (after.has(h)) offenders.push(key);
	}
	assert.deepEqual([...new Set(offenders)], [], "redundant no-helper restatement still present");
});

test("assembled prompts shrink where a redundant restatement was removed", () => {
	const unchanged: string[] = [];
	for (const [key, before] of Object.entries(fixture.entries)) {
		if (!before.sentenceHashes.some((h) => REDUNDANT_HASHES.has(h)) || key === "live/sqlite-specialist" || key === "live/release-engineer") continue;
		const [shape, role] = key.split("/");
		if (assembled(shape, role).text.length >= before.chars) unchanged.push(key);
	}
	assert.deepEqual(unchanged, [], "prompts with a removed restatement did not shrink");
});

test("privacy-neutralized role sentences: each original was in the pre-change fixture and is replaced exactly by its generic wording", () => {
	for (const p of PRIVACY_NEUTRALIZED) {
		const before = fixture.entries[`live/${p.role}`];
		assert.ok(before?.sentenceHashes.includes(p.from), `${p.role}: pre-change sentence ${p.from} missing from fixture`);
		const after = sentenceHashes(assembled("live", p.role).text);
		assert.ok(after.has(sha(p.to).slice(0, 8)), `${p.role}: generic wording missing`);
		assert.ok(!after.has(p.from), `${p.role}: original sentence still present`);
	}
});

test("the graph reference paragraph states the write-authority limit once, without repeating the artifact-placement candidate rule", () => {
	const root = mkdtempSync(path.join(tmpdir(), "dedup-graph-"));
	mkdirSync(path.join(root, ".git"));
	mkdirSync(path.join(root, "graphify-out"));
	writeFileSync(path.join(root, "graphify-out", "GRAPH_REPORT.md"), "# report\n");
	const globalDir = mkdtempSync(path.join(tmpdir(), "dedup-global-"));
	const text = graphReferenceGuidance(root, globalDir);
	assert.doesNotMatch(text, /widen write authority/, "authority is stated once, in core");
	const prompt = assembleChildSystemPrompt({ name: "general-worker", systemPrompt: "ROLE BODY" } as never, { codeIntegrationsEnabled: true, cwd: root, packageRoot: null, launchArgs: [], globalGraphDirectory: globalDir });
	assert.equal(prompt.split("Graph references never widen write authority.").length - 1, 1);
	assert.doesNotMatch(text, /Source edits and tests stay in the assigned candidate; graph/);
});

test("variant requirements survive dedup: oracle subscription guard, release-engineer integrations, reviewer verdict contract", () => {
	assert.match(assembled("live", "oracle").text, /Claude subscription guard/);
	assert.match(assembled("live", "release-engineer").text, /QMD\/Ponytail integrations/);
	assert.match(assembled("live", "reviewer").text, /APPROVE WITH NOTES/);
	assert.match(assembled("live", "scout").text, /Pi thinking levels control GPT reasoning directly/);
});

// Essential no-helper boundary for all 19 live roles (the fixture covers the 18 pre-platform generic roles): the leaf prohibition, the no-subagent-tool statement and the shell-launch prohibition remain, and the removed restatements stay absent.
test("every live role keeps the no-helper boundary and no longer restates the removed phrases", () => {
	const names = fs.readdirSync(new URL("../../../agents/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
	assert.equal(names.length, 20, "live role count");
	const missing: string[] = [];
	for (const role of names) {
		const text = assembled("live", role).text;
		if (!/Never launch\/delegate\/supervise helpers/.test(text)) missing.push(`${role}: leaf prohibition`);
		if (!/this leaf has no subagent tool/.test(text)) missing.push(`${role}: no-subagent-tool statement`);
		if (!/Do not use shell commands to launch Pi or other agents/.test(text)) missing.push(`${role}: shell-launch prohibition`);
		for (const phrase of REDUNDANT) if (text.includes(phrase)) missing.push(`${role}: restated "${phrase}"`);
	}
	assert.deepEqual(missing, []);
});
