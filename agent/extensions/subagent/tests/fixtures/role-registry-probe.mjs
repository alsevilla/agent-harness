import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST = process.env.NATIVE_PROBE_HOST_MODULES;
if (!HOST) throw new Error("NATIVE_PROBE_HOST_MODULES must select the installed host modules");
const sdkUrl = pathToFileURL(path.join(HOST, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
const parentURL = pathToFileURL(path.join(HOST, "..", "_.mjs")).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-coding-agent") return { url: sdkUrl, shortCircuit: true };
  if (specifier.startsWith("@earendil-works/") || specifier === "typebox") return nextResolve(specifier, { ...context, parentURL });
    return nextResolve(specifier, context);
} });
const [agentsUrl, ...args] = process.argv.slice(2);
await import(sdkUrl);
const { discoverAgents } = await import(agentsUrl);
if (args.length === 0) console.log("ROLE_REGISTRY_DISCOVERY_OK");
else console.log(JSON.stringify(discoverAgents(args[0], args[1])));
