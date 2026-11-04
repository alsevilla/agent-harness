// Fixed sequences for the common task shapes. Main names the shape, the worker role and one packet per step;
// this module expands that into the existing `chain` mode with a fixed role order. No new runtime, no classifier.
//   T1: <worker>
//   T2: debugger -> <worker> [-> test-engineer] [-> reviewer]
//   T3: [planner (economy)] -> [<specialist>] -> <worker> -> test-engineer (capable) [-> reviewer (capable)]
// Delivery (release-engineer) is never part of a shape: main accepts the checks first, then delivers separately.
// A shape step whose STATUS is not PASS stops the sequence and returns to main (see `shapeStepStop`).

export const SHAPE_NAMES = ["T1", "T2", "T3"] as const;
export type ShapeName = (typeof SHAPE_NAMES)[number];
export const SHAPE_WORKERS = ["backend-worker", "database-worker", "frontend-worker", "platform-worker", "general-worker"];
const PACKET_KEYS = ["planner", "debugger", "specialist", "worker", "test", "review"] as const;
type PacketKey = (typeof PACKET_KEYS)[number];

export interface ShapeRequest {
	name: string;
	worker: string;
	specialist?: string;
	packets: Partial<Record<PacketKey, string>>;
	cwd?: string;
}

export interface ShapeStep {
	agent: string;
	task: string;
	cwd?: string;
	readOnly?: boolean;
	modelTier?: "economy" | "capable";
}

// required / optional packets per shape; anything else is refused so a packet is never silently dropped
const RULES: Record<ShapeName, { required: PacketKey[]; optional: PacketKey[] }> = {
	T1: { required: ["worker"], optional: [] },
	T2: { required: ["debugger", "worker"], optional: ["test", "review"] },
	T3: { required: ["worker", "test"], optional: ["planner", "specialist", "review"] },
};

const PREVIOUS = "\n\nPrevious step report:\n{previous}";

export function expandShape(shape: ShapeRequest): { ok: true; chain: ShapeStep[] } | { ok: false; error: string } {
	const fail = (error: string) => ({ ok: false as const, error: `Invalid shape: ${error}` });
	if (!shape || typeof shape !== "object") return fail("expected an object");
	if (!(SHAPE_NAMES as readonly string[]).includes(shape.name)) return fail(`name must be one of ${SHAPE_NAMES.join(", ")}; T4 and unusual tasks are routed by main`);
	const name = shape.name as ShapeName;
	if (!SHAPE_WORKERS.includes(shape.worker)) return fail(`worker must be one of ${SHAPE_WORKERS.join(", ")}`);
	const packets = shape.packets ?? {};
	const { required, optional } = RULES[name];
	for (const key of Object.keys(packets)) {
		if (!(PACKET_KEYS as readonly string[]).includes(key) || ![...required, ...optional].includes(key as PacketKey)) return fail(`packet "${key}" is not part of ${name}`);
		if (typeof packets[key as PacketKey] !== "string" || !packets[key as PacketKey]!.trim()) return fail(`packet "${key}" must be non-empty text`);
	}
	for (const key of required) if (!packets[key]) return fail(`${name} needs a "${key}" packet`);
	if (shape.specialist !== undefined) {
		if (name !== "T3") return fail("a specialist step is only part of T3");
		if (typeof shape.specialist !== "string" || !/^[a-z][a-z-]*-specialist$/.test(shape.specialist)) return fail("specialist must be a *-specialist role name");
	}
	if ((shape.specialist === undefined) !== (packets.specialist === undefined)) return fail("specialist and its packet go together");

	const steps: ShapeStep[] = [];
	const add = (agent: string, key: PacketKey, extra: Omit<ShapeStep, "agent" | "task"> = {}) => {
		const text = packets[key]!;
		const task = steps.length === 0 || text.includes("{previous}") ? text : text + PREVIOUS;
		steps.push({ agent, task, ...(shape.cwd !== undefined ? { cwd: shape.cwd } : {}), ...extra });
	};
	if (packets.planner) add("planner", "planner", { readOnly: true, modelTier: "economy" });
	if (packets.debugger) add("debugger", "debugger", { readOnly: true });
	if (packets.specialist) add(shape.specialist!, "specialist", { readOnly: true });
	add(shape.worker, "worker");
	// T3 gates are independent VERIFY/REVIEW for material risk: explicit capable (both roles default to economy)
	const gateTier = name === "T3" ? { modelTier: "capable" as const } : {};
	if (packets.test) add("test-engineer", "test", { readOnly: true, ...gateTier });
	if (packets.review) add("reviewer", "review", { readOnly: true, ...gateTier });
	return { ok: true, chain: steps };
}

/** A non-final shape step continues only on STATUS PASS; anything else (or no STATUS line) stops and returns to main. */
export function shapeStepStop(report: string): string | undefined {
	const status = /^\s*STATUS\s*:\s*(.*)$/im.exec(report)?.[1]?.trim();
	if (status === undefined) return "no STATUS line";
	return /^PASS\b/i.test(status) ? undefined : `STATUS ${status}`;
}
