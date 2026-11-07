// Pi extension loaded by simulate-pi-shaping.mjs: a stand-in model that replays a scripted list of turns and appends every request
// context Pi sends it to $RECORD_OUT (JSON lines). It uses Pi's own faux provider, so Pi builds and shapes each request as it would for
// a real model. $PI_AI_MODULE is the installed @earendil-works/pi-ai entry.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const ai = await import(pathToFileURL(process.env.PI_AI_MODULE).href);
export default function recorder(pi) {
	const script = JSON.parse(readFileSync(process.env.SCRIPT, "utf8"));
	const core = ai.createFauxCore({ api: "rec-api", provider: "rec", models: [{ id: "rec-model", name: "rec", contextWindow: 1000000 }] });
	core.setResponses(script.map((s) => (s.text !== undefined ? ai.fauxAssistantMessage(ai.fauxText(s.text)) : ai.fauxAssistantMessage([ai.fauxText(s.say ?? "Next."), ai.fauxToolCall(s.tool, s.args, { id: s.id })]))));
	pi.registerProvider("rec", {
		api: core.api, apiKey: "inert", models: core.models,
		streamSimple: (model, context, options) => { appendFileSync(process.env.RECORD_OUT, JSON.stringify(context) + "\n"); return core.streamSimple(model, context, options); },
	});
}
