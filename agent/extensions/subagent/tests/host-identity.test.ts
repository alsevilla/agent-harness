import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { hostIdentity, hostModules } from "./host-modules.ts";
import { execFileSync } from "node:child_process";
import { latestVerdict, main } from "../../../../scripts/check-pi-latest.mjs";

const roots: string[] = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const PEERS = Object.keys(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "..", "package.json"), "utf8")).peerDependencies).sort();
/** One complete valid peer tree: every declared runtime peer, with the entry file and package.json hostIdentity requires. */
function installSdk(modules: string, version: unknown, skip: string[] = []) {
  for (const pkg of PEERS) {
    if (skip.includes(pkg)) continue;
    const base = path.join(modules, ...pkg.split("/"));
    const entry = pkg === "typebox" ? path.join("build", "index.mjs") : path.join("dist", "index.js");
    fs.mkdirSync(path.dirname(path.join(base, entry)), { recursive: true }); fs.writeFileSync(path.join(base, entry), "");
    fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({ name: pkg, version: pkg === "@earendil-works/pi-coding-agent" ? version : "1.0.0" }));
  }
}

function fakeHome(versions: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-identity-")); roots.push(root);
  const releases = path.join(root, ".pi", "agent", "install", "releases");
  for (const [dir, packageVersion] of Object.entries(versions)) installSdk(path.join(releases, dir, "node_modules"), packageVersion);
  return { root, releases };
}
function withEnv(env: Record<string, string | undefined>, body: () => void) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { body(); } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("identity reports the selected package name, version, path and how it was selected", () => {
  const { root, releases } = fakeHome({ "1.9.0": "1.9.0", "1.10.0": "1.10.0" });
  withEnv({ HOME: root, USERPROFILE: root, NATIVE_PROBE_HOST_MODULES: undefined }, () => {
    const id = hostIdentity();
    assert.equal(id.packageName, "@earendil-works/pi-coding-agent");
    assert.equal(id.version, "1.10.0");
    assert.equal(id.modules, path.join(releases, "1.10.0", "node_modules"));
    assert.equal(id.selection, "latest-installed");
    assert.equal(id.isLatestInstalled, true);
  });
});

test("an explicit older tree is reported as explicit and not the latest installed release", () => {
  const { root, releases } = fakeHome({ "1.9.0": "1.9.0", "1.10.0": "1.10.0" });
  withEnv({ HOME: root, USERPROFILE: root, NATIVE_PROBE_HOST_MODULES: path.join(releases, "1.9.0", "node_modules") }, () => {
    const id = hostIdentity();
    assert.equal(id.version, "1.9.0");
    assert.equal(id.selection, "NATIVE_PROBE_HOST_MODULES");
    assert.equal(id.isLatestInstalled, false);
  });
});

test("a release directory whose package.json version disagrees fails closed", () => {
  const { root } = fakeHome({ "1.10.0": "1.9.9" });
  withEnv({ HOME: root, USERPROFILE: root, NATIVE_PROBE_HOST_MODULES: undefined }, () => {
    assert.throws(() => hostIdentity(), /release 1\.10\.0 .* package\.json reports 1\.9\.9/);
  });
});

test("latest verdict compares numerically and never passes an older or unknown runtime", () => {
  assert.deepEqual(latestVerdict("1.10.0", "1.10.0"), { validated: true, reason: "tested runtime 1.10.0 is the latest release 1.10.0" });
  const older = latestVerdict("1.9.0", "1.10.0");
  assert.equal(older.validated, false);
  assert.match(older.reason, /latest-runtime validation unavailable: tested 1\.9\.0, latest 1\.10\.0/);
  assert.equal(latestVerdict("1.4.0", undefined).validated, false);
  assert.match(latestVerdict("1.4.0", "not-a-version").reason, /latest-runtime validation unavailable/);
  assert.equal(latestVerdict("2.0.0", "1.10.0").validated, false);
});

test(`actual host identity [${hostIdentity().version}] is a complete Pi release`, () => {
  const id = hostIdentity();
  assert.equal(id.packageName, "@earendil-works/pi-coding-agent");
  assert.match(id.version, /^\d+\.\d+\.\d+$/);
  assert.equal(id.modules, hostModules());
});

// CLI-level (offline): main() is the executable's whole logic with the registry request injected.
const REGISTRY = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest";
const latest = (version: string, name = "@earendil-works/pi-coding-agent") => async () => new Response(JSON.stringify({ name, version }), { status: 200 });
function cli(selected: string | undefined, fetchImpl: any, extra: Record<string, unknown> = {}) {
  return main({ argv: selected ? ["node", "check", selected] : ["node", "check"], env: {}, fetchImpl, ...extra });
}
const pkgJson = (modules: string) => path.join(modules, "@earendil-works", "pi-coding-agent", "package.json");

test("CLI passes only a complete, correctly named, consistent latest release (explicit and default selection)", async () => {
  const { root, releases } = fakeHome({ "1.9.0": "1.9.0", "1.10.0": "1.10.0" });
  const ok = await cli(path.join(releases, "1.10.0", "node_modules"), latest("1.10.0"));
  assert.equal(ok.code, 0); assert.equal(ok.result.validated, true);
  assert.equal((await cli(path.join(releases, "1.9.0", "node_modules"), latest("1.10.0"))).code, 3);
  const prev = [process.env.HOME, process.env.USERPROFILE]; process.env.HOME = process.env.USERPROFILE = root;
  try { assert.equal((await cli(undefined, latest("1.10.0"))).code, 0); } finally { [process.env.HOME, process.env.USERPROFILE] = prev as [string, string]; }
});

test("CLI rejects wrong package name, release-path/version mismatch, incomplete SDK, invalid or malformed metadata", async () => {
  const { releases } = fakeHome({ "1.4.0": "1.4.0", "1.3.0": "1.4.0", "1.5.0": "1.5.0", "1.6.0": "1.6.0", "1.7.0": "1.7.0" });
  const dir = (v: string) => path.join(releases, v, "node_modules");
  fs.writeFileSync(pkgJson(dir("1.4.0")), JSON.stringify({ name: "not-the-pi-sdk", version: "1.4.0" }));
  fs.rmSync(path.join(dir("1.5.0"), "@earendil-works", "pi-coding-agent", "dist"), { recursive: true });
  fs.writeFileSync(pkgJson(dir("1.6.0")), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "latest" }));
  fs.writeFileSync(pkgJson(dir("1.7.0")), "{not json");
  for (const [version, registry] of [["1.4.0", "1.4.0"], ["1.3.0", "1.4.0"], ["1.5.0", "1.5.0"], ["1.6.0", "1.6.0"], ["1.7.0", "1.7.0"]]) {
    const out = await cli(dir(version), latest(registry));
    assert.equal(out.code, 3, version); assert.equal(out.result.validated, false, version);
    assert.match(out.result.reason, /latest-runtime validation unavailable/, version);
  }
});

test("CLI asks the public registry directly, uncached, ignoring npm offline/cache/registry settings", async () => {
  const { releases } = fakeHome({ "1.4.0": "1.4.0" });
  const modules = path.join(releases, "1.4.0", "node_modules");
  let seen: any;
  const spy = async (url: string, init: any) => { seen = { url, init }; return latest("1.4.0")(); };
  const out = await main({ argv: ["node", "check", modules], env: { npm_config_offline: "true", npm_config_registry: "http://mirror.invalid/", npm_config_cache: "/stale" }, fetchImpl: spy });
  assert.equal(out.code, 0);
  assert.equal(seen.url, REGISTRY); assert.equal(seen.init.cache, "no-store"); assert.ok(seen.init.signal);
});

test("CLI fails unavailable on network error, timeout, HTTP error, wrong registry identity or bad version", async () => {
  const { releases } = fakeHome({ "1.4.0": "1.4.0" });
  const modules = path.join(releases, "1.4.0", "node_modules");
  const hang = (_url: string, init: any) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const cases: Array<[string, any, Record<string, unknown>?]> = [
    ["network", async () => { throw new Error("ENOTFOUND"); }],
    ["timeout", hang, { timeoutMs: 20 }],
    ["http", async () => new Response("{}", { status: 503 })],
    ["name", latest("1.4.0", "someone-else")],
    ["version", latest("latest")],
    ["json", async () => new Response("<html>", { status: 200 })],
  ];
  for (const [label, fetchImpl, extra] of cases) {
    const out = await cli(modules, fetchImpl, extra);
    assert.equal(out.code, 3, label); assert.equal(out.result.validated, false, label);
    assert.match(out.result.reason, /latest-runtime validation unavailable/, label);
  }
});

test("the real executable rejects a bad selection before any network access", () => {
  const { releases } = fakeHome({ "1.3.0": "1.4.0" });
  assert.throws(() => execFileSync(process.execPath, ["scripts/check-pi-latest.mjs", path.join(releases, "1.3.0", "node_modules")], { encoding: "utf8", stdio: "pipe", env: { ...process.env, NATIVE_PROBE_HOST_MODULES: "" } }), (error: any) => error.status === 3 && /latest-runtime validation unavailable/.test(error.stdout));
});

test("CLI treats equivalent spellings of a mismatched release directory as the same mismatch", async () => {
  const { releases } = fakeHome({ "1.3.0": "1.4.0" });
  const dir = path.join(releases, "1.3.0", "node_modules");
  assert.equal((await cli(dir, latest("1.4.0"))).code, 3);
  for (const spelling of [`${dir}/.`, `${dir}/`, `${dir}\\`, `${dir}/./`, `${dir}/../node_modules`, `${dir}/x/..`]) {
    const out = await cli(spelling, latest("1.4.0"));
    assert.equal(out.code, 3, spelling); assert.equal(out.result.validated, false, spelling);
  }
});

test("CLI accepts only string plain-release semver without leading zeros, locally and from the registry", async () => {
  const { root } = fakeHome({});
  const custom = (version: unknown) => {
    const modules = path.join(root, `custom-${roots.length}-${Math.random().toString(36).slice(2)}`, "node_modules");
    installSdk(modules, version);
    return modules;
  };
  assert.equal((await cli(custom("1.4.0"), latest("1.4.0"))).code, 0);
  for (const bad of [["1.4.0"], null, 1, { v: "1.4.0" }, "01.4.0", "1.04.0", "1.4.00"]) {
    const out = await cli(custom(bad), latest("1.4.0"));
    assert.equal(out.code, 3, JSON.stringify(bad)); assert.equal(out.result.validated, false, JSON.stringify(bad));
  }
  for (const bad of ["01.4.0", "1.4.00", "1.4.0-beta"]) assert.equal((await cli(custom(bad), latest(bad))).code, 3, `both ${bad}`);
  assert.equal((await cli(custom("1.4.0"), latest("01.4.0"))).code, 3);
  assert.equal((await cli(custom("1.4.0"), async () => new Response(JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: ["1.4.0"] }), { status: 200 }))).code, 3);
});

test("the declared runtime peer set is exactly the five Pi SDK packages the fixtures model", () => {
  assert.deepEqual(PEERS, ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);
});

for (const missing of PEERS) {
  test(`CLI fails closed, with no registry request, when the SDK lacks ${missing}`, async () => {
    const { releases } = fakeHome({});
    const modules = path.join(releases, "1.4.0", "node_modules");
    installSdk(modules, "1.4.0", [missing]);
    let requests = 0;
    const out = await cli(modules, async () => { requests++; return latest("1.4.0")(); });
    assert.equal(out.code, 3); assert.equal(out.result.validated, false);
    assert.match(out.result.reason, /latest-runtime validation unavailable/);
    assert.match(out.result.reason, /missing|expected/);
    assert.equal(requests, 0);
    assert.throws(() => hostIdentity(modules));
  });
}

test("CLI fails closed for a peer with an unreadable or wrongly named package.json", async () => {
  const { releases } = fakeHome({});
  for (const [label, version, content] of [["bad-json", "1.4.0", "{nope"], ["other-name", "1.5.0", JSON.stringify({ name: "someone-else", version: "1.0.0" })]]) {
    const modules = path.join(releases, version, "node_modules");
    installSdk(modules, version);
    fs.writeFileSync(path.join(modules, "@earendil-works", "pi-tui", "package.json"), content);
    let requests = 0;
    const out = await cli(modules, async () => { requests++; return latest(version)(); });
    assert.equal(out.code, 3, label); assert.equal(out.result.validated, false, label); assert.equal(requests, 0, label);
  }
});
