import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];

export function hostModules(required = packages): string {
  const selected = process.env.NATIVE_PROBE_HOST_MODULES;
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
