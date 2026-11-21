// The packaged install must ship every skill guide the role prompts point to: packageResourceGuidance tells packaged children to
// resolve agent/skills/ paths under the installed root, so a guide missing from the tarball would be a dead instruction there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("npm pack ships the four domain catalogs and every agent/skills path a role references", () => {
	const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" }));
	const files = new Set<string>(pack.files.map((f: { path: string }) => f.path.replace(/\\/g, "/")));
	for (const catalog of ["backend", "frontend", "graphify", "browser"]) assert.ok(files.has(`agent/skills/${catalog}/SKILL.md`), `${catalog} catalog is in the tarball`);
	const agents = new URL("agent/agents/", root);
	for (const name of readdirSync(agents).filter((f) => f.endsWith(".md"))) {
		for (const ref of readFileSync(new URL(name, agents), "utf8").match(/agent\/skills\/[A-Za-z0-9_./-]+/g) ?? []) {
			const path = ref.replace(/[.,;:)]+$/, "");
			if (path === "agent/skills/..." || path.endsWith("/")) continue;
			assert.ok(files.has(path) || [...files].some((f) => f.startsWith(`${path}/`)), `${name}: ${path} is in the tarball`);
		}
	}
});
