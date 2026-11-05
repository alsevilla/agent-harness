import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EnvironmentConfig = {
  env: Record<string, string>;
};

export default function engineeringEnvironment(_pi: ExtensionAPI) {
  // Run during extension loading. Child processes inherit these variables even when they disable extensions.
  const file = new URL("./config.json", import.meta.url);
  const config = JSON.parse(readFileSync(file, "utf8")) as EnvironmentConfig;
  const allowed = new Set([
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  ]);
  // pi-serena's warm-up switch: accepted and ignored in an older config.json, so removing pi-serena never breaks startup.
  const retired = new Set(["SERENA_EAGER_STARTUP"]);
  for (const [name, value] of Object.entries(config.env)) {
    if (retired.has(name)) continue;
    if (!allowed.has(name) || typeof value !== "string") {
      throw new Error(`Invalid engineering environment entry: ${name}`);
    }
    process.env[name] = value;
  }
}
