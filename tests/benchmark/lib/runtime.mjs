// Candidate runtime identity: the measured Pi extensions are the candidate package's declared extensions. A replayed parent's
// package.json and files are task material, never the measured runtime. Fingerprint = SHA-256 over sorted per-file digests.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Every file under dir (the declared extensions import their siblings). A dir that is the candidate root itself is never walked.
function filesUnder(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full));
		else out.push(full);
	}
	return out;
}

export function candidateRuntime({ candidateRoot }) {
	const root = path.resolve(candidateRoot);
	const pkgFile = path.join(root, "package.json");
	const declared = JSON.parse(fs.readFileSync(pkgFile, "utf8")).pi?.extensions;
	if (!Array.isArray(declared) || declared.length === 0) throw new Error(`candidate package.json declares no pi.extensions: ${pkgFile}`);
	const scope = new Set([pkgFile]);
	for (const rel of declared) {
		if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel)) throw new Error(`candidate extension must be a relative path: ${JSON.stringify(rel)}`);
		const abs = path.resolve(root, rel);
		const inside = path.relative(root, abs);
		if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`candidate extension "${rel}" is outside the candidate root`);
		if (!fs.existsSync(abs)) throw new Error(`candidate extension is missing: ${rel}`);
		scope.add(abs);
		const dir = path.dirname(abs);
		if (dir !== root) for (const f of filesUnder(dir)) scope.add(f);
	}
	const entries = [...scope].map((f) => [path.relative(root, f).split(path.sep).join("/"), sha256(fs.readFileSync(f))]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const fingerprint = sha256(entries.map(([p, h]) => `${p}\0${h}\n`).join(""));
	return { root, extensions: declared.slice(), fingerprint };
}

// Absolute extension entry points for the SDK loader, always under the candidate root.
export function runtimeExtensionPaths(runtime) {
	return runtime.extensions.map((e) => path.resolve(runtime.root, e));
}

// Prompt resources the profile installation can shadow. The measured main and child sessions load AGENTS.md and skills from the profile agent
// directory (the supported loaders have no candidate-root override), and a same-named profile agents/*.md overrides the package role. The candidate's copy
// is therefore measured only when it is byte-identical to the profile's. roles.json is not here: the user overlay is legitimate and carried with provenance.
const RESOURCE_EXT = /\.md$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "tests"]);
function resourceFiles(dir, rel = "") {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) out.push(...resourceFiles(path.join(dir, entry.name), `${rel}${entry.name}/`)); }
		else if (RESOURCE_EXT.test(entry.name)) out.push(`${rel}${entry.name}`);
	}
	return out;
}

// Mode "profile-installed": the run measures what the profile loads. state: identical | differs | profile-missing. A candidate AGENTS.md or skill that
// differs from, or is absent in, the profile is shadowed (the candidate edit is not what a session would load); a missing profile agents/*.md is
// not shadowed (the package role loads). Pure read of both trees; nothing is copied or written.
export function resourceShadowing({ candidateRoot, agentDir }) {
	const base = path.join(path.resolve(candidateRoot), "agent");
	const rels = [...(fs.existsSync(path.join(base, "AGENTS.md")) ? ["AGENTS.md"] : []), ...resourceFiles(path.join(base, "skills"), "skills/"), ...resourceFiles(path.join(base, "agents"), "agents/")].sort();
	const files = rels.map((rel) => {
		const mine = sha256(fs.readFileSync(path.join(base, rel)));
		const theirs = path.join(agentDir, rel);
		const profile = fs.existsSync(theirs) ? sha256(fs.readFileSync(theirs)) : null;
		return { path: `agent/${rel}`, candidate: mine, profile, state: profile === null ? "profile-missing" : profile === mine ? "identical" : "differs" };
	});
	const shadowed = files.filter((f) => f.state === "differs" || (f.state === "profile-missing" && !f.path.startsWith("agent/agents/")));
	return { mode: "profile-installed", agentDir: path.resolve(agentDir), fingerprint: sha256(files.map((f) => `${f.path}\0${f.candidate}\0${f.profile}\n`).join("")), files: files.length, shadowed };
}

// What the loaded main session really carries: every candidate AGENTS.md/skill must appear among the loader's loaded files with the same bytes.
// loaded = { agentsFiles: [{path, content}], skills: [{name, filePath}] } as the SDK resource loader reports them. Returns the problems (empty = proven).
export function verifyLoadedResources({ candidateRoot, loaded }) {
	const base = path.join(path.resolve(candidateRoot), "agent");
	const problems = [];
	const byName = (p) => path.basename(path.dirname(p)) + "/" + path.basename(p);
	const agentsSrc = path.join(base, "AGENTS.md");
	if (fs.existsSync(agentsSrc)) {
		const want = sha256(fs.readFileSync(agentsSrc));
		if (!(loaded?.agentsFiles ?? []).some((f) => sha256(Buffer.from(f.content ?? "", "utf8")) === want)) problems.push("agent/AGENTS.md: no loaded context file carries the candidate bytes");
	}
	const skillRoot = path.join(base, "skills");
	for (const rel of resourceFiles(skillRoot).filter((r) => path.basename(r) === "SKILL.md")) {
		const want = sha256(fs.readFileSync(path.join(skillRoot, rel)));
		const hit = (loaded?.skills ?? []).find((sk) => typeof sk.filePath === "string" && byName(sk.filePath) === byName(rel));
		if (!hit || !fs.existsSync(hit.filePath) || sha256(fs.readFileSync(hit.filePath)) !== want) problems.push(`agent/skills/${rel}: ${hit ? "the loaded skill differs from the candidate" : "no loaded skill"}`);
	}
	return problems;
}
