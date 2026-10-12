// Node-run probe for the native layout tests: prints one JSON line. Modes: discover (agents.ts) and sdk (public DefaultResourceLoader).
// Bare host packages (@earendil-works/*, typebox) resolve from NATIVE_PROBE_HOST_MODULES (the supported install tree), never from a checkout node_modules.
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const HOST = process.env.NATIVE_PROBE_HOST_MODULES;
if (HOST) {
	const parentURL = pathToFileURL(path.join(HOST, "..", "_.mjs")).href;
	registerHooks({ resolve: (specifier, context, next) => (/^(@earendil-works\/|typebox)/.test(specifier) ? next(specifier, { ...context, parentURL }) : next(specifier, context)) });
}
const [mode, arg1, arg2, arg3] = process.argv.slice(2);
if (mode === "discover") {
	const mod = await import(pathToFileURL(arg1).href);
	const result = mod.discoverAgents(arg2, arg3);
	console.log(JSON.stringify({ packageRoot: mod.packageRoot(), error: result.error ?? null, agents: result.agents.map((a) => ({ name: a.name, source: a.source, model: a.model ?? null, filePath: a.filePath, systemPrompt: a.systemPrompt })) }));
} else if (mode === "sdk") {
	const pi = await import("@earendil-works/pi-coding-agent");
	const settingsManager = pi.SettingsManager.inMemory({ packages: [arg1] });
	const loader = new pi.DefaultResourceLoader({ cwd: arg2, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager });
	await loader.reload();
	const exts = loader.getExtensions();
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	console.log(JSON.stringify({ prompts: prompts.prompts.map((p) => p.name ?? p.filePath), extensions: exts.extensions.map((e) => e.resolvedPath), extensionErrors: exts.errors.map((e) => e.error), skills: skills.skills.map((s) => ({ name: s.name, filePath: s.filePath })), skillDiagnostics: skills.diagnostics.map((d) => String(d.message ?? d)) }));
} else {
	throw new Error(`unknown probe mode: ${mode}`);
}
