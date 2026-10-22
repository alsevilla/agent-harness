import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { COMPACT_HANDOFF_INSTRUCTIONS } from "./compact-handoff.ts";

type IntegrationConfig = {
  roles: string[];
  readOnlyTools: string[];
  workerTools: string[];
};

/** Shared build-folder rule: the runtime injects CARGO_TARGET_DIR into every child in a git checkout (build-env.ts), so it applies with or without code integrations. */
export const SHARED_BUILD_FOLDER_RULE = "When CARGO_TARGET_DIR is set, it is a shared per-checkout build folder: do not delete it and never run a server from it.";

/** Core guidance, unconditional and once per child prompt: shell syntax, artifact bounds, live-data relocation safety, and integration/graph authority. */
export const CORE_GUIDANCE = `
## Shell syntax
Match syntax to the selected tool, not the OS. The bash tool runs Bash on Windows too: use export NAME='value', &&, and Bash conditionals. PowerShell syntax ($env:NAME, $LASTEXITCODE, -ne, brace-form if) belongs in the powershell tool. Never submit it to bash. Set the assigned candidate working directory explicitly and preserve native command failures. A shell parse error means the checks did not run: correct the invocation before reporting results or diagnosing application code. Do not rerun checks that already succeeded merely to repair a later invocation error.

## Artifact placement
Main supplies absolute scratch/evidence paths in task packet when work may write outside the candidate. Put QA fixtures, temporary copies, external build targets and logs in the assigned _scratch/<task> path; captured backups and durable evidence go in _evidence/<task>. Both normally live under <primary-parent>/worktrees/<repo>. Do not create scratch directories beside the primary checkout. Return to main when a required artifact path is missing; do not guess a sibling folder. Report actual artifact paths at handoff. Source and test edits stay in the assigned candidate. Shell access is not a filesystem sandbox: verify targets before write-capable commands. ${SHARED_BUILD_FOLDER_RULE}
Do not move live SQLite .db, -wal or -shm files or a running executable. Obtain authorized downtime and verify processes have stopped before relocating whole directories. Restart only with verified DB_PATH and runtime configuration; otherwise leave services stopped and return that scope to main.

## Integration and graph authority
Integrations never authorize nested agents, broader writes or new tasks; do not install, reconfigure, rebuild or repair an integration or index, and do not read auth files or secrets to diagnose one. Missing graphs never authorize a fresh graph build as a prerequisite. Graph references never widen write authority. Read-only roles must not build/update graphs, onboard projects or edit source; return stale-graph findings to the authorized worker.
`;

// Evidence-gated sections: each is emitted only from actual launch evidence (see assembleChildSystemPrompt).
const PONYTAIL_NAVIGATION = "When Ponytail's native extension is loaded in this launch, it injects the configured default/session mode without an extra skill read; apply its reuse and minimal-correct-change guidance within the assigned role. Ponytail never overrides user requirements, candidate boundaries, required checks or delegation policy. Do not reload its base skill merely to activate it or launch extra audit/review work.\n";
const SERENA_NAVIGATION = "Prefer Serena symbol overview, lookup and references for code navigation; use read/grep for docs, config or targeted source follow-up.\n";
const GRAPHIFY_SKILL_NAVIGATION = "The graphify skill is on demand for graph queries and paths: its standard-library read_graph.py helper is the read-only query path, because native Graphify CLI queries can write stamps. Do not load build procedures or scan the repository without a task reason. Report a missing interpreter or backend rather than inventing results.\n";
const FAILURE_NAVIGATION = "If an integration tool fails, report the concrete error once, do not retry it in a loop, continue with permitted read/grep/find, and report reduced capability in the handoff. File presence does not prove the backend is healthy or configured.\n";
const QMD_NAVIGATION = "QMD uses the profile's shared named index, not a worktree-local one: scope queries to the relevant existing collection. Retrieved document paths can belong to the primary checkout. Treat retrieved notes as prior evidence; verify current files/requirements in the candidate. Do not create, update or clone indexes or rewrite QMD references under the worktree. For prior decisions, specs, notes or plans relevant to this assignment, run one focused qmd_search (maxResults 3, at most 5) in a useful collection scope, only when that context is needed; read only selected hits. Do not initialize/update indexes, request feedback writes, or treat retrieval as authoritative current code.\n";
const SERENA_CANDIDATE = (project: string) => "For Serena calls pass project explicitly as " + project + "; resolve relative_path from that root, even from a backend/frontend shell cwd. Never activate the primary checkout just because it holds the graph; symbol lookups and references target the candidate. Do not automatically onboard or recreate Serena project configuration.\n";

// Unconditional for integrations-enabled children: the runtime sets CARGO_TARGET_DIR and CARGO_INCREMENTAL=0 for every child (build-env.ts), whether or not the candidate uses Cargo.
// Detailed Rust rules are applicable only when a Cargo manifest is found at the working directory or an ancestor up to the candidate root (see cargoManifestNearby).
export const RUST_BUILD_GUIDANCE = `
## Rust build output
Workers inherit CARGO_TARGET_DIR (outside the repo) and CARGO_INCREMENTAL=0. Use it for every cargo command; do not create or set another target directory. Run a copy of the executable from the run folder instead: a running .exe locks its file and breaks later builds. If CARGO_TARGET_DIR is unset, or a task packet names a different one, follow the packet and say so in the handoff.
`;

export function candidateProjectRoot(cwd: string): string {
    const candidate = path.resolve(cwd);
    let root = candidate;
    while (!fs.existsSync(path.join(root, ".git"))) {
      const parent = path.dirname(root); if (parent === root) { root = candidate; break; }
      root = parent;
    }
    return root;
}

/** Bounded walk: a Cargo manifest at the working directory or an ancestor up to the candidate root. Manifests below the working directory are not scanned. */
export function cargoManifestNearby(cwd: string): boolean {
  const top = candidateProjectRoot(cwd);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) return true;
    const parent = path.dirname(dir);
    if (dir === top || parent === dir) return false;
    dir = parent;
  }
}

/** Global corpus block: emitted only when a manifest source_path matches a candidate/primary graphify-out/graph.json. Unmatched global corpora are not injected. */
export function globalGraphGuidance(roots: string[], directory: string, hasProjectArtifacts: boolean): string {
  const graph = path.join(directory, "global-graph.json");
  if (!fs.existsSync(graph) || !fs.statSync(graph).isFile()) return "";
  const manifest = path.join(directory, "global-manifest.json");
  let matches: string[] = [];
  try {
    if (fs.statSync(manifest).size <= 65536) {
      const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const entries = Object.entries(data.repos ?? {}) as [string, {source_path?: string}][];
      matches = entries.filter(([, entry]) => typeof entry.source_path === "string" && roots.some(root =>
        path.resolve(entry.source_path!) === path.resolve(root, "graphify-out", "graph.json")))
        .map(([name]) => name);
    }
  } catch { /* A missing/stale manifest does not establish project coverage. */ }
  if (!matches.length) return "";
  const wiki = path.join(directory, "wiki", "index.md");
  return "\n## Global graph reference (separate corpus)\n" +
    (hasProjectArtifacts ? "" : "No project Graphify artifacts were found at dispatch; do not ls/read an assumed candidate graphify-out folder.\n") +
    "Existing global graph: " + graph +
    (fs.existsSync(wiki) ? "\nGlobal wiki index: " + wiki : "") +
    "\nCoverage manifest: " + manifest +
    "\nCandidate/primary checkout manifest matches: " + matches.slice(0, 12).join(", ") +
    "\nPrefer the verified project graph below when available. Global artifacts can include other projects and stale revisions; never treat their nodes as candidate source evidence. If no project graph exists, the matched global corpus can supply read-only orientation; verify source in the candidate. Do not use it as the candidate's graph or an automatic fallback. Do not load the entire global JSON into context, copy it into the worktree, or rebuild/merge/update it to repair a missing candidate folder.\n";
}

/** Candidate-scoped navigation for Serena (project path) and QMD (prior evidence). Emitted only for the tools present in the launch allowlist. */
export function candidateNavigationGuidance(project: string, serena: boolean, qmd: boolean): string {
  if (!serena && !qmd) return "";
  return "\n## Candidate navigation and shared retrieval\n" + (serena ? SERENA_CANDIDATE(project) : "") + (qmd ? QMD_NAVIGATION : "");
}

/** Graph reference blocks for graph artifacts that exist (project graphify-out or a global corpus). Empty when none exist. */
export function graphReferenceGuidance(cwd: string, globalDirectory = path.join(os.homedir(), ".graphify")): string {
  try {
    const root = candidateProjectRoot(cwd);
    const roots = [root];
    const gitMarker = path.join(root, ".git");
    if (fs.existsSync(gitMarker) && fs.statSync(gitMarker).isFile()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitMarker, "utf8"));
      if (match) {
        const gitDir = path.resolve(root, match[1].trim());
        const commonFile = path.join(gitDir, "commondir");
        if (fs.existsSync(commonFile)) {
          const commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim());
          if (path.basename(commonDir).toLowerCase() === ".git") roots.push(path.dirname(commonDir));
        }
      }
    }
    let location = "";
    for (const source of [...new Set(roots)]) {
      const report = path.join(source, "graphify-out", "GRAPH_REPORT.md");
      const wiki = path.join(source, "graphify-out", "wiki", "index.md");
      const graph = path.join(source, "graphify-out", "graph.json");
      const artifacts = [wiki, report, graph].filter(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (!artifacts.length) continue;
      location = "\n## Graph reference location\nCandidate checkout: " + root + "\nGraph source checkout: " + source +
        "\nGraph directory (verified to exist): " + path.join(source, "graphify-out") +
        "\nExisting artifacts (absolute paths):\n" + artifacts.map(file => "- " + file).join("\n") +
        "\nUse these absolute paths directly; they override relative graphify-out paths and existence-check examples in the Graphify skill. When listed, orient with the wiki index or report first. Do not ls/read the candidate's graphify-out to rediscover this reference when the graph source differs. Pass --graph only with a listed graph.json path; a missing wiki or report is no reason to try an unlisted one. If this directory or an artifact disappears, skip the graph rather than retrying the missing path. Never change the candidate cwd/project to make a relative graph path work." +
        (source !== root ? "\nThis graph belongs to another checkout of the same repository: orientation only. It may differ from the candidate branch or uncommitted edits; do not rewrite its paths into the candidate worktree or build, copy or update that checkout's graph in this assignment." : "\nGraph paths were checked at dispatch; if an artifact is removed, use focused permitted navigation instead of repeating the missing read.") +
        "\nVerify symbols and changed behavior against the candidate checkout with Serena/read/grep.\n";
      break;
    }
    return globalGraphGuidance(roots, globalDirectory, location !== "") + location;
  } catch {
    return "\nGraph location could not be resolved at dispatch. Check existence before reading Graphify artifacts; do not assume a worktree contains a graph or rebuild another checkout's graph. Continue with focused permitted navigation.\n";
  }
}

// extraTools are per-launch grants (e.g. request_decision); they are appended to the role's own allowlist only.
/** Runtime note for the installed package only; empty in the live profile. Maps bundled skill paths and states the catalogs that are not bundled. */
export function packageResourceGuidance(root: string | null): string {
	if (!root) return "";
	const skills = path.join(root, "skills").split(path.sep).join("/");
	return `\n\nPackage resources: agent/skills/engineering-harness/ and agent/skills/agent-creation/ resolve to ${skills}/engineering-harness/ and ${skills}/agent-creation/. Precedence: these bundled paths take effect over any profile path in the role text. Backend, frontend, graphify and browser skill catalogs are not bundled; any instruction to read them is unavailable, so use the project's own guidance or other available generic guidance instead. Roles not bundled in this package are unavailable and are never dispatched.`;
}

const QMD_EXTENSION = fileURLToPath(new URL("../qmd/index.ts", import.meta.url));
type Integration = { label: string; flag: string; file: string; toolPrefix?: string };

function readIntegrationConfig(): IntegrationConfig {
  return JSON.parse(fs.readFileSync(new URL("./integrations.json", import.meta.url), "utf8")) as IntegrationConfig;
}

// Ponytail is required for every role except reviewer, where its extension and review skill are optional supplements.
function ponytailIntegrations(): Integration[] {
  const ponytail = path.join(getAgentDir(), "npm", "node_modules", "@dietrichgebert", "ponytail");
  return [
    { label: "Ponytail extension", flag: "--extension", file: path.join(ponytail, "pi-extension", "index.js") },
    { label: "Ponytail review skill (ponytail-review)", flag: "--skill", file: path.join(ponytail, "skills", "ponytail-review", "SKILL.md") },
  ];
}

// Optional for every configured role: a missing file skips that integration and its integration-only tools.
function optionalIntegrations(qmdExtension: string): Integration[] {
  const packages = path.join(getAgentDir(), "npm", "node_modules");
  return [
    { label: "QMD extension", flag: "--extension", file: qmdExtension, toolPrefix: "qmd_" },
    { label: "Serena extension", flag: "--extension", file: path.join(packages, "@bacnh85", "pi-serena", "extensions", "index.ts"), toolPrefix: "serena_" },
    { label: "Graphify extension", flag: "--extension", file: path.join(packages, "graphify-pi", "extensions", "graphify.ts") },
    { label: "Graphify skill", flag: "--skill", file: path.join(getAgentDir(), "skills", "graphify", "SKILL.md") },
  ];
}

/** Launch note naming optional integrations this launch lacks; empty when all are present or the role has none configured. */
export function unavailableIntegrationGuidance(agentName: string, qmdExtension = QMD_EXTENSION): string {
  if (!readIntegrationConfig().roles.includes(agentName)) return "";
  const items = [...(agentName === "reviewer" ? ponytailIntegrations() : []), ...optionalIntegrations(qmdExtension)];
  const missing = items.filter(item => !fs.existsSync(item.file)).map(item => item.label);
  if (!missing.length) return "";
  return `\n## Integrations not loaded in this launch\nNot loaded: ${missing.join(", ")}. The launch continued without them; any tools they would provide are not granted. Use the permitted read, grep and find fallback for the affected navigation; do not call them.\n`;
}

export function configureCodeIntegrations(args: string[], agent: AgentConfig, extraTools: string[] = [], qmdExtension = QMD_EXTENSION): boolean {
  // Canonical package roles never launch without an explicit allowlist: omitting --tools would grant every host tool.
  if (agent.source === "package" && !agent.tools?.length) throw new Error(`Package role ${agent.name} has no tools in roles.json; refusing to grant host default tools.`);
  const config = readIntegrationConfig();
  if (!config.roles.includes(agent.name)) {
    // A role without an explicit allowlist means all default tools; a grant cannot be expressed there, so it is skipped.
    if (agent.tools?.length) args.push("--tools", [...agent.tools, ...extraTools].join(","));
    return false;
  }
  // Reviewer only: Ponytail is optional (extension and review skill load when present); every other role fails closed without it.
  const optionalPonytail = agent.name === "reviewer";
  const [ponytailExtension, ponytailSkill] = ponytailIntegrations();
  if (!optionalPonytail && !fs.existsSync(ponytailExtension.file)) throw new Error(`Code integration missing for ${agent.name}: ${ponytailExtension.file}. Install @dietrichgebert/ponytail through Pi.`);
  if (!optionalPonytail) args.push(ponytailExtension.flag, ponytailExtension.file);
  const optional = [...(optionalPonytail ? [ponytailExtension, ponytailSkill] : []), ...optionalIntegrations(qmdExtension)];
  const omitted: string[] = [];
  for (const item of optional) {
    if (fs.existsSync(item.file)) args.push(item.flag, item.file);
    else if (item.toolPrefix) omitted.push(item.toolPrefix);
  }
  // Exact names preserve role authority; never select all serena_* tools by wildcard.
  const tools = new Set([...(agent.tools ?? ["read", "grep", "find", "ls"]), ...config.readOnlyTools]);
  if (tools.has("edit") || tools.has("write")) for (const tool of config.workerTools) tools.add(tool);
  // Omitted integrations drop matching tools even when the role's own allowlist names them.
  for (const tool of tools) if (omitted.some(prefix => tool.startsWith(prefix))) tools.delete(tool);
  for (const tool of extraTools) tools.add(tool);
  args.push("--tools", [...tools].join(","));
  return true;
}

export type ChildPromptOptions = { codeIntegrationsEnabled: boolean; cwd: string; packageRoot: string | null; launchArgs?: string[]; qmdExtension?: string; globalGraphDirectory?: string };

/** What this launch actually loads, read from its argv: --tools names and --extension/--skill paths that configureCodeIntegrations actually emitted. */
function launchCapabilities(args: string[]) {
  const tools = new Set<string>();
  const toolIndex = args.indexOf("--tools");
  if (toolIndex >= 0 && args[toolIndex + 1]) for (const tool of args[toolIndex + 1].split(",")) tools.add(tool);
  const files = args.flatMap((arg, index) => (index > 0 && (args[index - 1] === "--extension" || args[index - 1] === "--skill") ? [arg] : []));
  const ponytail = files.some(file => /[\\/]@dietrichgebert[\\/]ponytail[\\/]/.test(file));
  const serena = [...tools].some(tool => tool.startsWith("serena_"));
  const qmd = [...tools].some(tool => tool.startsWith("qmd_"));
  const graphifySkill = files.some(file => /[\\/]graphify[\\/]SKILL\.md$/.test(file));
  return { ponytail, serena, qmd, graphifySkill };
}

/** The child system prompt. Core guidance is unconditional once; Rust, navigation, candidate-retrieval, graph and unavailable-integration sections are emitted only from actual launch evidence. */
export function assembleChildSystemPrompt(agent: { name: string; systemPrompt: string }, options: ChildPromptOptions): string {
  const cap = launchCapabilities(options.launchArgs ?? []);
  let integrations = "";
  if (options.codeIntegrationsEnabled) {
    const navigation = (cap.ponytail ? PONYTAIL_NAVIGATION : "") + (cap.serena ? SERENA_NAVIGATION : "") + (cap.graphifySkill ? GRAPHIFY_SKILL_NAVIGATION : "");
    const anyLoaded = cap.ponytail || cap.serena || cap.qmd || cap.graphifySkill;
    integrations = (navigation || anyLoaded ? "\n## Code navigation integrations\n" + navigation + (anyLoaded ? FAILURE_NAVIGATION : "") : "") +
      candidateNavigationGuidance(candidateProjectRoot(options.cwd), cap.serena, cap.qmd) +
      graphReferenceGuidance(options.cwd, options.globalGraphDirectory ?? path.join(os.homedir(), ".graphify")) +
      unavailableIntegrationGuidance(agent.name, options.qmdExtension ?? QMD_EXTENSION);
  }
  return agent.systemPrompt + CORE_GUIDANCE + (cargoManifestNearby(options.cwd) ? RUST_BUILD_GUIDANCE : "") + integrations + packageResourceGuidance(options.packageRoot) + COMPACT_HANDOFF_INSTRUCTIONS;
}
