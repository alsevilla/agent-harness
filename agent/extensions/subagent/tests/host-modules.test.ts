import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { hostModules } from "./host-modules.ts";

const roots: string[] = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test("host release selection uses numeric latest version with every requested package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-release-")); roots.push(root);
  const releases = path.join(root, ".pi", "agent", "install", "releases");
  for (const version of ["1.9.0", "1.10.0"]) for (const pkg of ["pi-coding-agent", "pi-ai"]) {
    const dir = path.join(releases, version, "node_modules", "@earendil-works", pkg, "dist"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "index.js"), "");
  }
  const previousHome = process.env.HOME, previousUserProfile = process.env.USERPROFILE, previousSelection = process.env.NATIVE_PROBE_HOST_MODULES;
  process.env.HOME = process.env.USERPROFILE = root; delete process.env.NATIVE_PROBE_HOST_MODULES;
  try { assert.equal(hostModules(), path.join(releases, "1.10.0", "node_modules")); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    if (previousSelection === undefined) delete process.env.NATIVE_PROBE_HOST_MODULES; else process.env.NATIVE_PROBE_HOST_MODULES = previousSelection;
  }
});

test("latest incomplete host fails instead of falling back to an older complete release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-incomplete-")); roots.push(root);
  const releases = path.join(root, ".pi", "agent", "install", "releases");
  for (const version of ["1.9.0", "1.10.0"]) for (const pkg of ["pi-coding-agent", "pi-ai"]) {
    if (version === "1.10.0" && pkg === "pi-ai") continue;
    const dir = path.join(releases, version, "node_modules", "@earendil-works", pkg, "dist"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "index.js"), "");
  }
  const previousHome = process.env.HOME, previousUserProfile = process.env.USERPROFILE, previousSelection = process.env.NATIVE_PROBE_HOST_MODULES;
  process.env.HOME = process.env.USERPROFILE = root; delete process.env.NATIVE_PROBE_HOST_MODULES;
  try { assert.throws(() => hostModules(), /latest installed host 1\.10\.0 is incomplete/); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    if (previousSelection === undefined) delete process.env.NATIVE_PROBE_HOST_MODULES; else process.env.NATIVE_PROBE_HOST_MODULES = previousSelection;
  }
});

test("an explicit host missing the requested CLI fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-missing-cli-")); roots.push(root);
  const cliIndex = path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js"); fs.mkdirSync(path.dirname(cliIndex), { recursive: true }); fs.writeFileSync(cliIndex, "");
  const previous = process.env.NATIVE_PROBE_HOST_MODULES; process.env.NATIVE_PROBE_HOST_MODULES = root;
  try { assert.throws(() => hostModules(["@earendil-works/pi-coding-agent/dist/bundle/cli.js"]), /expected/); }
  finally { if (previous === undefined) delete process.env.NATIVE_PROBE_HOST_MODULES; else process.env.NATIVE_PROBE_HOST_MODULES = previous; }
});

test("an explicit invalid host fails closed instead of falling back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-invalid-")); roots.push(root);
  const previous = process.env.NATIVE_PROBE_HOST_MODULES; process.env.NATIVE_PROBE_HOST_MODULES = root;
  try { assert.throws(() => hostModules(), /NATIVE_PROBE_HOST_MODULES selected/); }
  finally { if (previous === undefined) delete process.env.NATIVE_PROBE_HOST_MODULES; else process.env.NATIVE_PROBE_HOST_MODULES = previous; }
});
