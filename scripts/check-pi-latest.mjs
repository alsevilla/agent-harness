#!/usr/bin/env node
// Read-only: compares the host release the tests loaded with the latest published release. Never installs or writes.
// Usage: node scripts/check-pi-latest.mjs [node_modules dir]  (default: NATIVE_PROBE_HOST_MODULES, else the highest installed release)
// Selection and identity checks are the ones the host tests use (hostIdentity); the registry is asked directly and uncached.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostIdentity, PLAIN_SEMVER as SEMVER } from "../agent/extensions/subagent/tests/host-modules.ts";

const PACKAGE = "@earendil-works/pi-coding-agent";

/** Validated only when the tested runtime IS the latest release; an older, newer or unknown pair is never a pass. */
export function latestVerdict(tested, latest) {
  if (typeof tested !== "string" || typeof latest !== "string" || !SEMVER.test(tested) || !SEMVER.test(latest)) return { validated: false, reason: `latest-runtime validation unavailable: tested ${tested}, latest ${latest ?? "unknown"} (registry query failed or version not plain semver)` };
  if (tested === latest) return { validated: true, reason: `tested runtime ${tested} is the latest release ${latest}` };
  return { validated: false, reason: `latest-runtime validation unavailable: tested ${tested}, latest ${latest}` };
}

const unavailable = (reason) => ({ code: 3, result: { package: PACKAGE, validated: false, reason: `latest-runtime validation unavailable: ${reason}` } });

/** Direct, uncached read of the public registry's latest record; npm offline/cache/mirror settings are deliberately not consulted. */
async function registryLatest(fetchImpl, timeoutMs) {
  const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2F")}/latest`, { cache: "no-store", headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const record = await response.json();
  if (record?.name !== PACKAGE || typeof record?.version !== "string" || !SEMVER.test(record.version)) throw new Error("registry returned another package or an invalid version");
  return record.version;
}

export async function main({ argv = process.argv, env = process.env, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let identity;
  try { identity = hostIdentity(argv[2] ?? env.NATIVE_PROBE_HOST_MODULES ?? ""); }
  catch (error) { return unavailable(`selected runtime is not a valid Pi SDK (${error.message})`); }
  let latest;
  try { latest = await registryLatest(fetchImpl, timeoutMs); }
  catch (error) { return unavailable(`registry query failed (${error.message})`); }
  const verdict = latestVerdict(identity.version, latest);
  return { code: verdict.validated ? 0 : 3, result: { package: identity.packageName, modules: identity.modules, tested: identity.version, latest, ...verdict } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, result } = await main();
  console.log(JSON.stringify(result));
  process.exit(code);
}
