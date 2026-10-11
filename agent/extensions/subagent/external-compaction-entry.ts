// External-compaction guard (opt-in: PI_EXTERNAL_COMPACTION=1). An external owner (proxy) compresses context, so native
// compaction is cancelled for manual, threshold and overflow. It never compresses, repairs refs, retries, or changes tools.
// Child spawns load the default export with notify off, so child UI output stays unchanged.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const START = "PI_EXTERNAL_COMPACTION=1: native compaction is cancelled. The external proxy owns context compression; on overflow, Pi needs external compression or a new session.";
const MANUAL = "/compact cancelled (PI_EXTERNAL_COMPACTION=1): the external proxy owns compression. Use the external owner or start a new session.";
const OVERFLOW = "Context overflow: native recovery cancelled (PI_EXTERNAL_COMPACTION=1); nothing was compressed and no retry is scheduled. Needs external compression or a new session.";

export function registerExternalCompaction(pi: ExtensionAPI, options: { env?: Record<string, string | undefined>; notify?: boolean } = {}): void {
	const { env = process.env, notify = true } = options;
	if (env.PI_EXTERNAL_COMPACTION !== "1") return;
	pi.on("session_start", (_event, ctx) => {
		if (notify) ctx.ui.notify(START, "info");
	});
	pi.on("session_before_compact", (event, ctx) => {
		if (notify && event.reason !== "threshold") ctx.ui.notify(event.reason === "manual" ? MANUAL : OVERFLOW, "warning"); // threshold repeats per turn: startup note only
		return { cancel: true };
	});
}

export default function (pi: ExtensionAPI) {
	registerExternalCompaction(pi, { notify: false });
}
