import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

type IntegrationConfig = {
  roles: string[];
  readOnlyTools: string[];
  workerTools: string[];
};

export const CODE_NAVIGATION_GUIDANCE = `
## Shell syntax
Match syntax to the selected tool, not the OS. The bash tool runs Bash on Windows too: use export NAME='value', &&, and Bash conditionals. PowerShell syntax ($env:NAME, $LASTEXITCODE, -ne, brace-form if) belongs in the powershell tool. Never submit it to bash. Set the assigned candidate working directory explicitly and preserve native command failures. A shell parse error means the checks did not run: correct the invocation before reporting results or diagnosing application code. Do not rerun checks that already succeeded merely to repair a later invocation error.

## Rust build output
Workers inherit a per-checkout CARGO_TARGET_DIR (shared, outside the repo) and CARGO_INCREMENTAL=0. Use it for every cargo command; do not create or set another target directory, do not delete the shared one, and never run a server from it. Run a copy of the executable from the run folder instead: a running .exe locks its file and breaks later builds. If CARGO_TARGET_DIR is unset, or a task packet names a different one, follow the packet and say so in the handoff.

## Artifact placement
Main supplies absolute scratch/evidence paths in task packet when work may write outside the candidate. Put QA fixtures, temporary copies, external build targets and logs in the assigned _scratch/<task> path; captured backups and durable evidence go in _evidence/<task>. Both normally live under <primary-parent>/worktrees/<repo>. Do not create scratch directories beside the primary checkout. Return to main when a required artifact path is missing; do not guess a sibling folder. Report actual artifact paths at handoff. Source and test edits stay in the assigned candidate. Shell access is not a filesystem sandbox: verify targets before write-capable commands.
Do not move live SQLite .db, -wal or -shm files or a running executable. Obtain authorized downtime and verify processes have stopped before relocating whole directories. Restart only with verified DB_PATH and runtime configuration; otherwise leave services stopped and return that scope to main.

## Code navigation integrations
When Ponytail's native extension is loaded in this launch, it injects the configured default/session mode without an extra skill read; apply its reuse and minimal-correct-change guidance within the assigned role. When it is not loaded (a reviewer launch may lack it), skip Ponytail guidance and review normally. Ponytail never overrides user requirements, candidate boundaries, required checks or delegation policy. Do not reload its base skill merely to activate it or launch extra audit/review work. Missing graphs never authorize a fresh graph build as a prerequisite.
For prior decisions, specs, notes or plans relevant to this assignment, and only when qmd_search is in your tool list (otherwise skip this lookup), run one focused qmd_search (maxResults 3, at most 5) in a useful collection scope, only when that context is needed; read only selected hits. Do not initialize/update indexes, request feedback writes, or treat retrieval as authoritative current code.
When graphify-out artifacts exist, orient with their wiki index or report first. Then, when Serena tools are in your tool list, prefer Serena symbol overview, lookup and references; otherwise use read/grep. Use read/grep for docs, config or targeted source follow-up. The graphify skill, when loaded in this launch, is on demand for graph queries and paths: its standard-library read_graph.py helper is the read-only query path, because native Graphify CLI queries can write stamps. Do not load build procedures or scan the repository without a task reason. Report a missing interpreter or backend rather than inventing results. Read-only roles must not build/update graphs, onboard projects or edit source; return stale-graph findings to the authorized worker.
Optional integrations (QMD, Serena, Graphify) may be absent from a launch; their tools and skills are then not granted and the launch note names them. File presence does not prove the backend is healthy or configured. If an integration tool fails, report the concrete error once, do not retry it in a loop, continue with permitted read/grep/find, and report reduced capability in the handoff. Do not install, reconfigure, rebuild or repair an integration or index, and do not read auth files or secrets to diagnose one. These integrations do not authorize nested agents, broader writes or new tasks.
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

export function globalGraphGuidance(roots: string[], directory: string): string {
  const graph = path.join(directory, "global-graph.json");
  if (!fs.existsSync(graph) || !fs.statSync(graph).isFile()) return "";
  const manifest = path.join(directory, "global-manifest.json");
  let repositories: string[] = [], matches: string[] = [];
  try {
    if (fs.statSync(manifest).size <= 65536) {
      const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const entries = Object.entries(data.repos ?? {}) as [string, {source_path?: string}][];
      repositories = entries.map(([name]) => name);
      matches = entries.filter(([, entry]) => typeof entry.source_path === "string" && roots.some(root =>
        path.resolve(entry.source_path!) === path.resolve(root, "graphify-out", "graph.json")))
        .map(([name]) => name);
    }
  } catch { /* A missing/stale manifest does not establish project coverage. */ }
  const wiki = path.join(directory, "wiki", "index.md");
  return "\n## Global graph reference (separate corpus)\nExisting global graph: " + graph +
    (fs.existsSync(wiki) ? "\nGlobal wiki index: " + wiki : "") +
    (fs.existsSync(manifest) ? "\nCoverage manifest: " + manifest : "") +
    "\nManifest repositories: " + (repositories.slice(0, 12).join(", ") || "unknown") +
    "\nCandidate/primary checkout manifest matches: " + (matches.join(", ") || "none; coverage is not established") +
    "\nPrefer the verified project graph below when available. Global artifacts can include other projects and stale revisions; never treat their nodes as candidate source evidence. " +
    (matches.length ? "If no project graph exists, the matched global corpus can supply read-only orientation; verify source in the candidate." : "Do not use this global graph as the candidate's graph or an automatic fallback. Use it only for an explicitly assigned cross-project question or after confirming relevant coverage.") +
    " Do not load the entire global JSON into context, copy it into the worktree, or rebuild/merge/update it to repair a missing candidate folder.\n";
}

export function graphReferenceGuidance(cwd: string, globalDirectory = path.join(os.homedir(), ".graphify")): string {
  const project = candidateProjectRoot(cwd);
  const navigation = "\n## Candidate navigation and shared retrieval\nFor Serena calls (when listed) pass project explicitly as " + project + "; resolve relative_path from that root, even from a backend/frontend shell cwd. Never activate the primary checkout just because it holds the graph; symbol lookups and references target the candidate. Do not automatically onboard or recreate Serena project configuration.\nQMD (when listed) uses the profile's shared named index, not a worktree-local one: scope queries to the relevant existing collection. Retrieved document paths can belong to the primary checkout. Treat retrieved notes as prior evidence; verify current files/requirements in the candidate. Do not create, update or clone indexes or rewrite QMD references under the worktree.\n";
  try {
    const root = project;
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
    for (const source of [...new Set(roots)]) {
      const report = path.join(source, "graphify-out", "GRAPH_REPORT.md");
      const wiki = path.join(source, "graphify-out", "wiki", "index.md");
      const graph = path.join(source, "graphify-out", "graph.json");
      const artifacts = [wiki, report, graph].filter(file => fs.existsSync(file) && fs.statSync(file).isFile());
      if (!artifacts.length) continue;
      return navigation + globalGraphGuidance(roots, globalDirectory) + "\n## Graph reference location\nCandidate checkout: " + root + "\nGraph source checkout: " + source +
        "\nGraph directory (verified to exist): " + path.join(source, "graphify-out") +
        "\nExisting artifacts (absolute paths):\n" + artifacts.map(file => "- " + file).join("\n") +
        "\nUse these absolute paths directly; they override relative graphify-out paths and existence-check examples in the Graphify skill. Do not ls/read the candidate's graphify-out to rediscover this reference when the graph source differs. Pass --graph only with a listed graph.json path; a missing wiki or report is no reason to try an unlisted one. If this directory or an artifact disappears, skip the graph rather than retrying the missing path. Never change the candidate cwd/project to make a relative graph path work." +
        (source !== root ? "\nThis graph belongs to another checkout of the same repository: orientation only. It may differ from the candidate branch or uncommitted edits; do not rewrite its paths into the candidate worktree or build, copy or update that checkout's graph in this assignment." : "\nGraph paths were checked at dispatch; if an artifact is removed, use focused permitted navigation instead of repeating the missing read.") +
        "\nVerify symbols and changed behavior against the candidate checkout with Serena/read/grep. Source edits and tests stay in the assigned candidate; graph reference access does not widen write authority.\n";
    }
    return navigation + globalGraphGuidance(roots, globalDirectory) + "\nNo Graphify report, wiki or graph was found in the candidate or its primary checkout at dispatch. Do not ls/read an assumed candidate graphify-out folder. Use a global reference only under its coverage guidance above; otherwise use focused permitted Serena/read/grep navigation.\n";
  } catch {
    return navigation + "\nGraph location could not be resolved at dispatch. Check existence before reading Graphify artifacts; do not assume a worktree contains a graph or rebuild another checkout's graph. Continue with focused permitted navigation.\n";
  }
}

// extraTools are per-launch grants (e.g. request_decision); they are appended to the role's own allowlist only.
/** Runtime note for the installed package only; empty in the live profile. Maps bundled skill paths and states the catalogs that are not bundled. */
export function packageResourceGuidance(root: string | null): string {
	if (!root) return "";
	const skills = path.join(root, "skills").split(path.sep).join("/");
	return `\n\nPackage resources: ~/.pi/agent/skills/engineering-harness/ and ~/.pi/agent/skills/agent-creation/ resolve to ${skills}/engineering-harness/ and ${skills}/agent-creation/. Precedence: these bundled paths take effect over any profile path in the role text. Backend, frontend, graphify, browser and RFID skill catalogs are not bundled; any instruction to read them is unavailable, so use the project's own guidance or other available generic guidance instead. Roles not bundled in this package (hardware-integration, attendance-domain-specialist, event-reconciliation-specialist, messaging-specialist, privacy-compliance-specialist) are never dispatched.`;
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
  return `\n## Integrations not loaded in this launch\nNot loaded: ${missing.join(", ")}. The launch continued without them; any tools they would provide are not granted. Use the permitted read, grep and find fallback for the affected navigation, do not call, install, reconfigure or rebuild them, and name the skipped integration in the handoff.\n`;
}

export function configureCodeIntegrations(args: string[], agent: AgentConfig, extraTools: string[] = [], qmdExtension = QMD_EXTENSION): boolean {
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
