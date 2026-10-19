/**
 * Requested vs observed model identity. A launch request (--model) is never an observation: only what the child's own
 * completed assistant messages reported is. In Pi 1.3 AssistantMessage.provider/model echo the child's REQUEST (route
 * provider + id it sent); only `responseModel` (set by just the anthropic-messages and openai-completions producers) can
 * evidence a differing served id, and its absence is served UNVERIFIED, never "served == model". The effective id is the
 * route provider + (responseModel ?? model); an upstream provider is never inferred from responseModel text, and an
 * alias/snapshot textual difference is not a verdict of a different model. A report missing provider or model is partial
 * (unverified). Pure helpers; no gate or router lives here.
 */
export interface ObservedModel { provider?: string; model?: string; responseModel?: string }
export interface AttemptProvenance { requestedModel?: string; observed: ObservedModel[] }

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The identity one assistant message reports, or undefined when it reports none. A responseModel equal to model adds nothing and is dropped. */
export function identityOf(message: any): ObservedModel | undefined {
	const provider = text(message?.provider), model = text(message?.model);
	const reported = text(message?.responseModel), responseModel = reported !== model ? reported : undefined;
	if (!provider && !model && !responseModel) return undefined;
	return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(responseModel ? { responseModel } : {}) };
}

/**
 * Call for a COMPLETED assistant message only. Adds its identity unless an identical one is already listed (order of first sight
 * kept) and returns it. A completed message reporting no identity is kept as an empty `{}` marker (returns undefined): at least
 * one completed message is unknown, never a message count, so a served report elsewhere cannot verify the whole attempt.
 */
export function observeAssistant(list: ObservedModel[], message: any): ObservedModel | undefined {
	const id = identityOf(message), row = id ?? {};
	if (!list.some((o) => o.provider === row.provider && o.model === row.model && o.responseModel === row.responseModel)) list.push(row);
	return id;
}

/** Effective route-provider/(responseModel ?? model) of a complete observation; undefined when provider or model is missing. */
export function observedId(o: ObservedModel | undefined): string | undefined {
	if (!o?.provider || !o.model) return undefined;
	const id = o.responseModel ?? o.model;
	return id.startsWith(`${o.provider}/`) ? id : `${o.provider}/${id}`;
}

/** True only when the list is non-empty and EVERY row (partial and unknown ones included) is complete with a child-reported responseModel. */
export function servedReported(observed: ObservedModel[] | undefined): boolean {
	const rows = observed ?? [];
	return rows.length > 0 && rows.every((o) => observedId(o) && o.responseModel);
}

export function attemptOf(entry: { requestedModel?: string; observed?: ObservedModel[] }): AttemptProvenance {
	return { ...(entry.requestedModel !== undefined ? { requestedModel: entry.requestedModel } : {}), observed: entry.observed ?? [] };
}

const shown = (o: ObservedModel) => `${observedId(o)}${o.responseModel ? ` [response id; sent ${o.model}]` : ""}`;
const partialText = (o: ObservedModel) => `${o.provider ? `${o.provider}/` : ""}${o.model ?? "?"}`;
const partialLabel = (o: ObservedModel) => (o.provider || o.model ? JSON.stringify(partialText(o)) : "unknown message");

/** Honest one-phrase model provenance: what was observed, what was only requested, and any mismatch, mix or partial report. */
export function modelProvenance(entry: { model?: string; requestedModel?: string; modelSource?: string; observed?: ObservedModel[] }): string | undefined {
	const requested = entry.requestedModel ?? (entry.modelSource === "observed" ? undefined : entry.model);
	const observed = entry.observed ?? [];
	const complete = observed.filter((o) => observedId(o));
	const partial = observed.filter((o) => !observedId(o));
	const partialNote = partial.length ? `partial report ${partial.map(partialLabel).join(", ")} UNVERIFIED` : "";
	if (!complete.length) {
		if (!requested && !partial.length) return undefined;
		return `${requested ?? "unknown"} (${["requested-only", partialNote || "unobserved"].join(partialNote ? "; " : ", ")})`;
	}
	const distinct = [...new Map(complete.map((o) => [observedId(o), o])).values()]; // MIXED = distinct effective ids, not metadata refinement
	const mismatch = requested !== undefined && distinct.some((o) => observedId(o) !== requested);
	const notes = [mismatch ? `MISMATCH, requested ${requested}` : "", partialNote, servedReported(observed) ? "" : "served UNVERIFIED"].filter(Boolean);
	return `${distinct.map(shown).join(" + ")} (observed${distinct.length > 1 ? ", MIXED" : ""}${notes.length ? `; ${notes.join("; ")}` : ""})`;
}

/** Per-attempt trail of physically launched attempts (any count >= 1): each launch request, what it reported, and its own UNVERIFIED state. */
export function attemptsNote(attempts: AttemptProvenance[] | undefined): string | undefined {
	if (!attempts?.length) return undefined;
	return `attempts: ${attempts.map((a) => {
		const ids = [...new Set(a.observed.map(observedId).filter(Boolean) as string[])];
		const notes = [a.observed.some((o) => !observedId(o)) ? "partial UNVERIFIED" : "", ids.length && !servedReported(a.observed) ? "served UNVERIFIED" : ""].filter(Boolean);
		return `${a.requestedModel ?? "inherited"} -> ${ids.length ? ids.join(" + ") : a.observed.length ? "" : "unobserved"}${notes.length ? `${ids.length ? " " : ""}(${notes.join("; ")})` : ""}`;
	}).join("; ")}`;
}
