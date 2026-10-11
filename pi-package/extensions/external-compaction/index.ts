// Parent-side external-compaction guard (opt-in: PI_EXTERNAL_COMPACTION=1). Logic lives in subagent/external-compaction-entry.ts, shared with child spawns.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExternalCompaction } from "../subagent/external-compaction-entry.ts";

export default function (pi: ExtensionAPI) {
	registerExternalCompaction(pi);
}
