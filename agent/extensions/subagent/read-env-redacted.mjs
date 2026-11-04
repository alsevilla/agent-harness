#!/usr/bin/env node
// Redacted view of one .env file: prints every KEY with its value, except values that may be secret, which print as <redacted, N chars>.
// The safety guard allows exactly `node "<this file>" "<absolute .env path>"` and checks this file's SHA-256 first, so an edited copy is refused.
// Secret-like: the key names a key, secret, password, token, credential, auth, cookie, session, JWT, private or DSN value; the value embeds
// URL credentials (scheme://user:pass@); or the value is a long unbroken string that looks generated. Commented-out assignments are
// redacted the same way; plain comments hide generated-looking words; other unparsed lines are never printed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_KEY = /(KEY|SECRET|PASS(WORD|WD)?|PWD|TOKEN|CREDENTIAL|AUTH|COOKIE|SESSION|JWT|PRIVATE|DSN|SIGNATURE|SALT|CERT)/i;
const URL_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*@/i;
const GENERATED = /^[A-Za-z0-9+/=_.~-]{24,}$/;
const MAX_BYTES = 64 * 1024;

export function redactEnv(text) {
	const out = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") { out.push(""); continue; }
		const comment = line.startsWith("#");
		const body = comment ? line.replace(/^#+\s*/, "") : line;
		const m = /^(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(body);
		if (!m) {
			// A plain comment is shown with any generated-looking word hidden; any other unparsed line is never printed.
			out.push(comment ? `# ${body.split(/\s+/).map((w) => (GENERATED.test(w) ? "<redacted>" : w)).join(" ")}` : "<unparsed line redacted>");
			continue;
		}
		const key = m[2];
		let value = m[3];
		const quoted = /^(["'])(.*)\1$/.exec(value);
		if (quoted) value = quoted[2];
		const secret = SECRET_KEY.test(key) || URL_CREDENTIALS.test(value) || GENERATED.test(value);
		out.push(`${comment ? "# " : ""}${key}=${value === "" ? "" : secret ? `<redacted, ${value.length} chars>` : value}`);
	}
	return out.join("\n");
}

function main(argv) {
	const file = argv[0];
	if (argv.length !== 1 || !path.isAbsolute(file) || !/^\.env(\..+)?$/.test(path.basename(file))) {
		console.error("usage: node read-env-redacted.mjs <absolute path to a .env or .env.* file>");
		return 2;
	}
	const st = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!st || !st.isFile()) { console.error("not a regular file"); return 2; }
	if (st.size > MAX_BYTES) { console.error(`larger than ${MAX_BYTES} bytes; not shown`); return 2; }
	console.log(redactEnv(fs.readFileSync(file, "utf8")));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
