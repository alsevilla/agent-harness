// Unit contract for provenance.ts: Pi 1.3 AssistantMessage.provider/model echo the child's REQUEST; only responseModel
// can evidence a differing served id. Absence of responseModel is served UNVERIFIED, never "served == model".
import assert from "node:assert/strict";
import test from "node:test";
import { attemptsNote, identityOf, modelProvenance, observeAssistant, observedId, servedReported, type ObservedModel } from "../provenance.ts";

const msg = (extra: object) => ({ role: "assistant", provider: "p", model: "m", ...extra });

test("effective id is route provider + responseModel ?? model; the provider is never taken from responseModel", () => {
	assert.equal(observedId({ provider: "p", model: "m" }), "p/m");
	assert.equal(observedId({ provider: "p", model: "m", responseModel: "served" }), "p/served");
	assert.equal(observedId({ provider: "openrouter", model: "m", responseModel: "anthropic/x" }), "openrouter/anthropic/x");
	assert.equal(observedId({ provider: "p", model: "m", responseModel: "p/served" }), "p/served", "exact route-provider prefix de-dup only");
	assert.equal(observedId({ model: "m", responseModel: "vendor/served" }), undefined, "partial report stays unverified");
});

test("a redundant responseModel is normalized away; responseId never changes identity", () => {
	assert.deepEqual(identityOf(msg({ responseModel: "m" })), { provider: "p", model: "m" });
	assert.deepEqual(identityOf(msg({ responseModel: "r", responseId: "id-1" })), { provider: "p", model: "m", responseModel: "r" });
	assert.deepEqual(identityOf(msg({ responseId: "id-1" })), { provider: "p", model: "m" });
});

test("served response differing from the request is MISMATCH and labels sent vs response; absence is served UNVERIFIED", () => {
	const served = modelProvenance({ requestedModel: "p/m", observed: [{ provider: "p", model: "m", responseModel: "snap" }] });
	assert.equal(served, "p/snap [response id; sent m] (observed; MISMATCH, requested p/m)");
	const silent = modelProvenance({ requestedModel: "p/m", observed: [{ provider: "p", model: "m" }] });
	assert.equal(silent, "p/m (observed; served UNVERIFIED)");
	assert.doesNotMatch(String(silent), /MISMATCH/);
	assert.equal(servedReported([{ provider: "p", model: "m" }]), false);
	assert.equal(servedReported([{ provider: "p", model: "m", responseModel: "snap" }]), true);
	assert.equal(servedReported([{ provider: "p", model: "m", responseModel: "snap" }, { provider: "p", model: "m" }]), false);
	assert.equal(servedReported([{ model: "m", responseModel: "snap" }]), false);
	assert.equal(servedReported([]), false);
});

test("MIXED counts distinct effective ids of completed messages, not metadata refinement", () => {
	const list: ObservedModel[] = [];
	observeAssistant(list, msg({ responseModel: "m" })); // redundant
	observeAssistant(list, msg({ responseModel: "r" }));
	observeAssistant(list, msg({ responseModel: "r", responseId: "later" }));
	assert.equal(modelProvenance({ requestedModel: "p/m", observed: list })?.includes("MIXED"), true, "m and r are two effective ids");
	assert.doesNotMatch(String(modelProvenance({ requestedModel: "p/m", observed: [{ provider: "p", model: "m", responseModel: "r" }, { provider: "p", model: "other", responseModel: "r" }] })), /MIXED/);
	const same: ObservedModel[] = [];
	observeAssistant(same, msg({ responseModel: "m" }));
	observeAssistant(same, msg({}));
	assert.equal(same.length, 1);
	assert.doesNotMatch(String(modelProvenance({ requestedModel: "p/m", observed: same })), /MIXED/);
});

test("partial reports and request-only stay unverified; per-attempt trail shows effective ids", () => {
	assert.match(String(modelProvenance({ requestedModel: "p/m", observed: [{ model: "m", responseModel: "r" }] })), /requested-only; partial report .* UNVERIFIED/);
	assert.equal(modelProvenance({ requestedModel: "p/m", observed: [] }), "p/m (requested-only, unobserved)");
	assert.equal(attemptsNote([{ requestedModel: "a/x", observed: [{ provider: "a", model: "x", responseModel: "x-served" }] }, { requestedModel: "b/y", observed: [{ provider: "b", model: "y" }] }]), "attempts: a/x -> a/x-served; b/y -> b/y (served UNVERIFIED)", "a request echo without responseModel is served UNVERIFIED in the trail too");
});

// Review-fix: an identity-free completed assistant message is retained as an empty marker (never invented identity) so a served report cannot hide it.
for (const unknownLast of [false, true]) test(`unknown and served completed messages stay UNVERIFIED in both orders (${unknownLast ? "unknown last" : "unknown first"})`, () => {
	const list: ObservedModel[] = [];
	const served = msg({ responseModel: "snap" }), none = { role: "assistant" };
	for (const m of unknownLast ? [served, none] : [none, served]) observeAssistant(list, m);
	assert.equal(list.length, 2);
	assert.equal(observeAssistant([], none), undefined, "no identity is returned or invented");
	assert.equal(servedReported(list), false);
	assert.match(String(modelProvenance({ requestedModel: "p/m", observed: list })), /UNVERIFIED/);
	observeAssistant(list, none);
	assert.equal(list.length, 2, "the marker is deduplicated");
});

test("a partial row beside a complete served row is UNVERIFIED; unknown-only is requested-only and unverified", () => {
	assert.equal(servedReported([{ provider: "p", model: "m", responseModel: "snap" }, { model: "bare" }]), false);
	assert.equal(servedReported([{ provider: "p", model: "m", responseModel: "snap" }, {}]), false);
	assert.match(String(modelProvenance({ requestedModel: "p/m", observed: [{ provider: "p", model: "m", responseModel: "snap" }, { model: "bare" }] })), /partial report .*UNVERIFIED/);
	assert.match(String(modelProvenance({ requestedModel: "p/m", observed: [{}] })), /requested-only; .*UNVERIFIED/);
});

test("attempt trail shows a lone prior attempt and keeps partial and served UNVERIFIED beside complete ids", () => {
	assert.notEqual(attemptsNote([{ requestedModel: "a/x", observed: [{ provider: "a", model: "x" }] }]), undefined);
	const note = String(attemptsNote([{ requestedModel: "a/x", observed: [{ provider: "a", model: "x" }, { model: "p" }] }, { requestedModel: "b/y", observed: [{ provider: "b", model: "y", responseModel: "s" }] }]));
	assert.match(note, /a\/x -> a\/x \(partial UNVERIFIED; served UNVERIFIED\); b\/y -> b\/s$/);
	assert.match(String(attemptsNote([{ requestedModel: "a/x", observed: [{}] }])), /UNVERIFIED/);
});
