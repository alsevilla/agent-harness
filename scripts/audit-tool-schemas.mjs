// Audit Pi request-context JSONL from the offline recorder. Never emit descriptions, schemas or messages.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function auditToolSchemas(requests) {
	if (!Array.isArray(requests) || requests.length === 0) throw new Error("expected at least one recorded Pi request");
	const variants = new Set(), tools = new Map(), sizes = [];
	for (const request of requests) {
		// Missing schemas mean incomplete evidence, not zero overhead.
		if (!Array.isArray(request?.tools)) throw new Error("request is missing its tools array");
		const serialized = JSON.stringify(request.tools);
		sizes.push(serialized.length);
		variants.add(createHash("sha256").update(serialized).digest("hex"));
		const seen = new Set();
		for (const tool of request.tools) {
			if (typeof tool?.name !== "string" || !tool.name || seen.has(tool.name)) throw new Error("expected unique named Pi tools in each request");
			seen.add(tool.name);
			const chars = JSON.stringify(tool).length;
			const row = tools.get(tool.name) ?? { name: tool.name, requests: 0, totalChars: 0, minChars: chars, maxChars: chars };
			row.requests++;
			row.totalChars += chars;
			row.minChars = Math.min(row.minChars, chars);
			row.maxChars = Math.max(row.maxChars, chars);
			tools.set(tool.name, row);
		}
	}
	return {
		units: "serialized UTF-16 characters; active catalog before provider serialization, not billed tokens",
		requests: requests.length, schemaVariants: variants.size, stable: variants.size === 1,
		totalChars: sizes.reduce((a, b) => a + b, 0), minChars: Math.min(...sizes), maxChars: Math.max(...sizes),
		tools: [...tools.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
	};
}

// Current Pi declares tools in system messages. Use its own replay function, not a parallel implementation.
export function resolveToolDeclarations(requests, getCurrentTools) {
	return requests.map((request) => {
		if (Array.isArray(request?.tools)) return request;
		if (typeof getCurrentTools !== "function" || !Array.isArray(request?.messages)
			|| !request.messages.some((message) => message.role === "system" && Array.isArray(message.toolsAdded))) {
			throw new Error("request lacks tool definitions or a compatible Pi declaration resolver");
		}
		return { tools: getCurrentTools(request.messages) };
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		if (process.argv.length !== 3) throw new Error("usage: node scripts/audit-tool-schemas.mjs <Pi request-context JSONL>");
		const lines = readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter((line) => line.trim());
		let requests;
		try { requests = lines.map((line) => JSON.parse(line)); } catch { throw new Error("invalid request JSONL (contents omitted)"); }
		if (requests.some((request) => !Array.isArray(request?.tools))) {
			const modules = process.env.NATIVE_PROBE_HOST_MODULES;
			if (!modules) throw new Error("transcript tool declarations require NATIVE_PROBE_HOST_MODULES pointing to the matching Pi install");
			const { getCurrentTools } = await import(pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/index.js")).href);
			requests = resolveToolDeclarations(requests, getCurrentTools);
		}
		console.log(JSON.stringify(auditToolSchemas(requests), null, 2));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
