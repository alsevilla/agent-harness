// Temp-tree fixtures for the agent topology tests. Everything is created under os.tmpdir(); the candidate and the profile are only ever READ
// (copied from, never linked to, never written), so no mutable alias of a real file exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CANDIDATE = path.resolve(HERE, "..", "..", "..");
// The installed Pi SDK package (explicit, as the CLI's --pi-package-root). A missing root FAILS the real tests loudly; nothing skips.
export const PI_ROOT = process.env.PI_BENCHMARK_PI_ROOT ?? path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.4.0", "node_modules", "@earendil-works", "pi-coding-agent");
export const EXT_FILES = ["agents.ts", "model-routing.ts", "provider-cooldown.ts"];
export const mkTmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bench-topo-${name}-`));
export const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
export const copyDir = (from, to, filter = () => true) => { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) if (filter(f)) fs.copyFileSync(path.join(from, f), path.join(to, f)); };

// A package copy with the REAL native discovery code (agents.ts, model-routing.ts) beside its own roles.json and role definitions.
export function packageFixture(base) {
	const root = path.join(base, "pkg");
	fs.mkdirSync(root, { recursive: true });
	write(path.join(root, "package.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(CANDIDATE, "package.json"), "utf8")), type: "module", pi: { extensions: ["./agent/extensions/subagent/index.ts"] } }));
	write(path.join(root, "agent", "roles.json"), fs.readFileSync(path.join(CANDIDATE, "agent", "roles.json"), "utf8"));
	copyDir(path.join(CANDIDATE, "agent", "agents"), path.join(root, "agent", "agents"), (f) => f.endsWith(".md"));
	const ext = path.join(root, "agent", "extensions", "subagent");
	for (const f of EXT_FILES) write(path.join(ext, f), fs.readFileSync(path.join(CANDIDATE, "agent", "extensions", "subagent", f), "utf8"));
	write(path.join(ext, "index.ts"), "export default function () {}\n");
	return { root, agents: path.join(root, "agent", "agents"), runtime: { root, extensions: ["./agent/extensions/subagent/index.ts"], fingerprint: "fixture-runtime" }, names: fs.readdirSync(path.join(root, "agent", "agents")).map((f) => f.slice(0, -3)) };
}

// Run fn with the SDK's ambient agent directory pointed at dir (the same variable the SDK reads), restoring it afterwards.
export async function withAgentDir(dir, fn) {
	const key = "PI_CODING_AGENT_DIR"; const had = Object.hasOwn(process.env, key); const old = process.env[key];
	process.env[key] = dir;
	try { return await fn(); } finally { if (had) process.env[key] = old; else delete process.env[key]; }
}

// A passing topology proof as the real check records it (fixture value for configs and adapters that must not run the real loader).
export const fixtureTopology = (over = {}) => ({ method: "agent-topology/1", ok: true, scopes: ["user", "both"], effectiveAgentDir: "fixture-agent-dir", envOverride: { present: false, names: [] }, cwd: "fixture-cwd", projectAgentDir: null, extensionEntry: "fixture-extension.ts", canonical: [], problems: [], fingerprint: "fixture-topology-1", ...over });
export const okTopology = async () => fixtureTopology();
