// Stack guidance contract (RED first): each owning role carries its selective stack notes, optional catalogs stay optional, and
// Flux is never conflated: FluxCD only when evidence names it, InfluxDB Flux is a separate query language.
import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

const read = (name: string) => fs.readFileSync(new URL(`../../../agents/${name}.md`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("backend-worker carries .NET and REST notes that do not need the optional catalog", () => {
  const text = read("backend-worker");
  assert.match(text, /\.NET/);
  assert.match(text, /ASP\.NET Core/);
  assert.match(text, /REST/);
  assert.match(text, /catalog[^\n]*(absent|not bundled)/i);
});

test("database-worker covers relational and NoSQL data access with engine-appropriate safety", () => {
  const text = read("database-worker");
  assert.match(text, /relational and NoSQL database implementation/i);
  assert.match(text, /document, key-value, wide-column and graph databases/i);
  assert.match(text, /engine-appropriate syntax and types/i);
  assert.match(text, /parameterized queries/i);
  assert.match(text, /additive, forward-only schema\/index rollouts/i);
  assert.match(text, /defer destructive changes.*explicit authority/i);
  assert.match(text, /safe typed filters\/driver constructors/i);
  assert.match(text, /untrusted operator\/query injection/i);
  assert.match(text, /bounded, resumable and idempotent/i);
  assert.match(text, /ORM mappings, repositories, data access/i);
  assert.match(text, /Do not assume NoSQL systems share consistency/i);
});

test("database-specialist covers NoSQL semantics without universalizing SQLite guidance", () => {
  const text = read("database-specialist");
  assert.match(text, /relational and NoSQL engines/i);
  assert.match(text, /document, key-value, wide-column and graph databases/i);
  assert.match(text, /engine-specific consistency\/conditional-write guarantees/i);
  assert.match(text, /partition\/shard and access-pattern fit/i);
  assert.match(text, /For NoSQL engines, use semantic fixtures/i);
  assert.match(text, /do not assume ACID, serializability, eventual consistency/i);
  assert.match(text, /only when SQLite\/SQLx is the actual stack/i);
  assert.match(text, /For SQLite\/SQLx only/i);
});

test("frontend-worker adds React and TypeScript notes while the SolidJS rules stay conditional", () => {
  const text = read("frontend-worker");
  assert.match(text, /React[^\n]*TypeScript|TypeScript[^\n]*React/);
  assert.match(text, /SolidJS rules[^\n]*conditional/i);
  assert.match(text, /## SolidJS-specific implementation/);
});

test("observability-specialist states NRQL as New Relic's query language, not SQL", () => {
  const text = read("observability-specialist");
  assert.match(text, /NRQL[^\n]*not SQL/);
});

test("api-specialist carries REST contract notes: pagination, error shape and idempotent retries", () => {
  const text = read("api-specialist");
  assert.match(text, /REST/);
  assert.match(text, /pagination/i);
  assert.match(text, /error shape|ProblemDetails/);
  assert.match(text, /idempoten/i);
});

test("general-worker separates Jira JQL from Confluence CQL and reads gh or curl before any write", () => {
  const text = read("general-worker");
  assert.match(text, /JQL[^\n]*Jira/);
  assert.match(text, /CQL[^\n]*Confluence|Confluence[^\n]*CQL/);
  assert.match(text, /not interchangeable/);
  assert.match(text, /\bgh\b/);
  assert.match(text, /\bcurl\b/);
  assert.match(text, /read-first|before any create/i);
});

test("platform-worker distinguishes FluxCD from InfluxDB Flux and names the infrastructure stack", () => {
  const text = read("platform-worker");
  for (const term of ["Terraform", "Kubernetes", "kubectl", "Azure CLI", "Helm", "FluxCD"]) assert.match(text, new RegExp(term));
  assert.match(text, /FluxCD[^\n]*only when/i);
  assert.match(text, /InfluxDB[^\n]*(out of scope|not FluxCD)/i);
});

test("platform-worker covers GitHub Actions workflows with least privilege, OIDC and no implied run or release authority", () => {
  const text = read("platform-worker");
  assert.match(text, /GitHub Actions/);
  assert.match(text, /\.github\/workflows/);
  assert.match(text, /permissions:/);
  assert.match(text, /OIDC/);
  assert.match(text, /commit SHA|pinned/i);
  assert.match(text, /environment/i);
  assert.match(text, /pull_request_target|script injection/i);
  assert.match(text, /Editing workflow files does not authorize triggering runs, publishing or deploying/);
  assert.match(text, /release-engineer[^\n]*(release|delivery)/);
});

test("observability-specialist advises Grafana and Kiali while platform-worker implements approved provisioning", () => {
  const obs = read("observability-specialist");
  assert.match(obs, /Grafana[^\n]*dashboard/i);
  assert.match(obs, /Kiali[^\n]*service[- ]mesh/i);
  assert.match(obs, /platform-worker[^\n]*provision/i);
  const platform = read("platform-worker");
  assert.match(platform, /Grafana|Kiali/);
  assert.match(platform, /approved/i);
});

test("platform-worker wires Snyk, SonarQube and Prisma Cloud gates without suppressing or inventing thresholds", () => {
  const text = read("platform-worker");
  assert.match(text, /Snyk/);
  assert.match(text, /SonarQube/);
  assert.match(text, /Prisma Cloud/);
  assert.match(text, /never[^\n]*(suppress|bypass|disable)/i);
  assert.match(text, /never[^\n]*threshold/i);
  assert.match(text, /failed scan[^\n]*not[^\n]*success|failed[^\n]*never[^\n]*success/i);
  assert.doesNotMatch(text, /Prisma ORM/);
});

test("security-specialist owns unresolved vulnerability, IAM and compliance policy advice for the scanners", () => {
  const text = read("security-specialist");
  assert.match(text, /Snyk|SonarQube|Prisma Cloud/);
  assert.match(text, /vulnerability|IAM|compliance/i);
});

test("devops-specialist stays read-only and hands accepted infrastructure file edits to platform-worker", () => {
  const text = read("devops-specialist");
  assert.match(text, /platform-worker/);
  assert.match(text, /read-only/i);
});

test("no role file or registry entry names the retired devops-worker", () => {
  const dir = new URL("../../../agents/", import.meta.url);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) assert.doesNotMatch(read(file.slice(0, -3)), /devops-worker/, file);
});

// Framework-aware frontend contract: SolidJS applies only to SolidJS projects, React is task-specific, and no frontend catalog is required.
const paragraphs = (s: string) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const section = (text: string, heading: string) => {
  const start = text.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `missing ## ${heading}`);
  const body = text.slice(start + heading.length + 4);
  const end = body.search(/\n## /);
  return end === -1 ? body : body.slice(0, end);
};
const CONDITIONAL = /\b(if|when|where)\b/i;
const AVAILABILITY = /installed|present|available|not bundled|absent/i;

test("frontend-worker names React and SolidJS as framework-conditional, not SolidJS-only, in its description and primary stack", () => {
  const text = read("frontend-worker");
  assert.match(text.match(/^description: (.*)$/m)?.[1] ?? "", /React[^\n]*SolidJS|SolidJS[^\n]*React/);
  const stack = text.slice(text.indexOf("Primary stack:"), text.indexOf("You are an implementation writer"));
  assert.match(stack, /React/);
  assert.match(stack, /SolidJS/);
});

test("frontend-worker reads the SolidJS guide only for an installed SolidJS project, with repository evidence as the fallback", () => {
  const module = section(read("frontend-worker"), "Assigned module");
  const solid = paragraphs(module).filter((p) => /solidjs-engineering/.test(p));
  assert.ok(solid.length > 0, "module section must name the SolidJS guide conditionally");
  for (const p of solid) {
    assert.match(p, /SolidJS/);
    assert.match(p, CONDITIONAL, p);
  }
  assert.match(module, /repository evidence/i);
  assert.match(module, AVAILABILITY);
});

test("frontend-worker never requires a frontend catalog: every catalog path sits in a conditional, availability-aware paragraph", () => {
  const paras = paragraphs(read("frontend-worker")).filter((p) => /skills\/frontend\//.test(p));
  assert.ok(paras.length >= 2);
  for (const p of paras) {
    assert.match(p, CONDITIONAL, p);
    assert.match(p, AVAILABILITY, p);
  }
});

test("frontend-worker scopes SolidJS reactivity rules to SolidJS projects and keeps React semantics task-specific with cleanup and SSR", () => {
  const text = read("frontend-worker");
  const solidRules = paragraphs(section(text, "SolidJS-specific implementation"))[0];
  assert.match(solidRules, /SolidJS/);
  assert.match(solidRules, CONDITIONAL);
  const react = text.slice(text.indexOf("**React and TypeScript notes"), text.indexOf("## SolidJS-specific implementation"));
  assert.match(react, /cleanup/i);
  assert.match(react, /\bSSR\b|server[- ]render/i);
  assert.match(react, /\bwhen\b[^\n]*\bReact\b/);
  const all = paragraphs(text);
  assert.ok(all.some((p) => /^On a SolidJS project/.test(p)), "SolidJS substitution rule must be scoped to SolidJS projects");
  assert.ok(all.some((p) => /^On a React project/.test(p)), "React substitution rule must be scoped to React projects");
});

test("platform-worker offline checks never name a dry-run or render that may reach a configured cluster or registry", () => {
  const text = read("platform-worker");
  const offline = section(text, "Offline checks");
  assert.doesNotMatch(offline, /--dry-run|helm template|kustomize build|flux build/);
  assert.doesNotMatch(text, /template offline/);
  assert.match(offline, /no (cluster|network|live)|cluster[^\n]*(not|no)|reach/i);
});
