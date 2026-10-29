// Loads the candidate extension's OWN pure native helpers (agents.ts discoverAgents, model-routing.ts resolveModelTier) from the exact extension directory a session
// would load, with the SDK specifier of agents.ts pointed at the already loaded installed SDK file (same module instance, so the same ambient getAgentDir).
// No ModelRuntime, AuthStorage, session or model call is created, and no environment variable is changed. The resolve hook is scoped to one parent URL and is
// always deregistered; where the platform has no registerHooks the check is BLOCKED rather than faked.
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { topologyError } from "./topology.mjs";

const SDK_SPECIFIER = "@earendil-works/pi-coding-agent";

export async function loadNativeAgents({ extensionEntry, piPackageRoot }) {
	if (!piPackageRoot) throw topologyError("no_sdk_root");
	const sdkFile = path.join(piPackageRoot, "dist", "index.js");
	if (!fs.existsSync(sdkFile)) throw topologyError("sdk_missing");
	const dir = path.dirname(path.resolve(extensionEntry));
	const agentsFile = path.join(dir, "agents.ts");
	const routingFile = path.join(dir, "model-routing.ts");
	for (const f of [agentsFile, routingFile]) if (!fs.existsSync(f)) throw topologyError("extension_files_missing");
	if (typeof registerHooks !== "function") throw topologyError("no_register_hooks");
	const agentsUrl = pathToFileURL(agentsFile).href;
	const sdkUrl = pathToFileURL(sdkFile).href;
	const hooks = registerHooks({ resolve: (specifier, context, next) => (specifier === SDK_SPECIFIER && context.parentURL === agentsUrl ? { url: sdkUrl, shortCircuit: true } : next(specifier, context)) });
	try {
		const [agents, routing] = await Promise.all([import(agentsUrl), import(pathToFileURL(routingFile).href)]);
		return { discoverAgents: agents.discoverAgents, resolveModelTier: routing.resolveModelTier };
	} catch { throw topologyError("native_import_failed"); } finally { hooks.deregister(); }
}
