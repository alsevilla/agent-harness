import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];

/** The runtime peer set package.json declares: the SDK a host tree must hold completely to count as a Pi SDK. */
const declaredPeers = (): string[] => Object.keys(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "..", "package.json"), "utf8")).peerDependencies ?? {}).sort();

export function hostModules(required = packages, selected: string | undefined = process.env.NATIVE_PROBE_HOST_MODULES): string {
  if (selected) {
    if (!fs.statSync(selected, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`NATIVE_PROBE_HOST_MODULES selected ${selected}, but it is not a directory`);
    for (const pkg of required) {
      const entry = pkg === "typebox" ? path.join(selected, pkg, "build", "index.mjs") : pkg.endsWith(".js") ? path.join(selected, ...pkg.split("/")) : path.join(selected, ...pkg.split("/"), "dist", "index.js");
      if (!fs.existsSync(entry)) throw new Error(`NATIVE_PROBE_HOST_MODULES selected ${selected}, but expected ${entry}`);
    }
    return selected;
  }
  const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  if (!fs.existsSync(releases)) throw new Error(`installed host releases directory missing: ${releases}`);
  const versions = fs.readdirSync(releases).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const modules = path.join(releases, versions[0] ?? "", "node_modules");
  const missing = required.map((pkg) => pkg === "typebox" ? path.join(modules, pkg, "build", "index.mjs") : pkg.endsWith(".js") ? path.join(modules, ...pkg.split("/")) : path.join(modules, ...pkg.split("/"), "dist", "index.js")).filter((entry) => !fs.existsSync(entry));
  if (!versions.length || missing.length) throw new Error(`latest installed host ${versions[0] ?? "(none)"} is incomplete; missing ${missing.join(", ")}`);
  return modules;
}

/** Plain release semver: numeric components, no leading zeros, no prerelease/build. */
export const PLAIN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const releaseOf = (modules: string) => /[\\/]releases[\\/](\d+\.\d+\.\d+)[\\/]node_modules[\\/]?$/.exec(modules)?.[1];

/** The Pi package the host-package tests actually load: its own package.json version, not an assumed directory name. */
export function hostIdentity(selected: string | undefined = process.env.NATIVE_PROBE_HOST_MODULES) {
  const peers = declaredPeers();
  if (!peers.length) throw new Error("package.json declares no runtime peer dependencies");
  const modules = hostModules(peers, selected);
  for (const peer of peers) { // a peer must be that package, readable, not merely a path with an entry file
    const reportedPeer = JSON.parse(fs.readFileSync(path.join(modules, ...peer.split("/"), "package.json"), "utf8"));
    if (reportedPeer?.name !== peer) throw new Error(`${modules} holds ${reportedPeer?.name} where ${peer} is expected`);
  }
  const packageName = "@earendil-works/pi-coding-agent";
  const reported = JSON.parse(fs.readFileSync(path.join(modules, ...packageName.split("/"), "package.json"), "utf8"));
  const release = releaseOf(path.resolve(modules)); // equivalent spellings (/., trailing separator) are the same selection
  if (typeof reported.version !== "string" || !PLAIN_SEMVER.test(reported.version)) throw new Error(`${modules} package.json has invalid version ${reported.version}`);
  if (reported.name !== packageName) throw new Error(`${modules} holds ${reported.name}, expected ${packageName}`);
  if (release && reported.version !== release) throw new Error(`release ${release} in ${modules} but its package.json reports ${reported.version}`);
  const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  const installed = fs.existsSync(releases) ? fs.readdirSync(releases).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  return {
    packageName,
    version: reported.version,
    modules,
    selection: selected ? "NATIVE_PROBE_HOST_MODULES" : "latest-installed",
    isLatestInstalled: installed.length > 0 && installed[0] === reported.version,
  };
}
