// Candidate runtime identity: the measured Pi extensions are the candidate package's declared extensions. A replayed parent's
// package.json and files are task material, never the measured runtime. Fingerprint = SHA-256 over sorted per-file digests.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Every file under dir (the declared extensions import their siblings). A dir that is the candidate root itself is never walked.
function filesUnder(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full));
		else out.push(full);
	}
	return out;
}

export function candidateRuntime({ candidateRoot }) {
	const root = path.resolve(candidateRoot);
	const pkgFile = path.join(root, "package.json");
	const declared = JSON.parse(fs.readFileSync(pkgFile, "utf8")).pi?.extensions;
	if (!Array.isArray(declared) || declared.length === 0) throw new Error(`candidate package.json declares no pi.extensions: ${pkgFile}`);
	const scope = new Set([pkgFile]);
	for (const rel of declared) {
		if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel)) throw new Error(`candidate extension must be a relative path: ${JSON.stringify(rel)}`);
		const abs = path.resolve(root, rel);
		const inside = path.relative(root, abs);
		if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error(`candidate extension "${rel}" is outside the candidate root`);
		if (!fs.existsSync(abs)) throw new Error(`candidate extension is missing: ${rel}`);
		scope.add(abs);
		const dir = path.dirname(abs);
		if (dir !== root) for (const f of filesUnder(dir)) scope.add(f);
	}
	const entries = [...scope].map((f) => [path.relative(root, f).split(path.sep).join("/"), sha256(fs.readFileSync(f))]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const fingerprint = sha256(entries.map(([p, h]) => `${p}\0${h}\n`).join(""));
	return { root, extensions: declared.slice(), fingerprint };
}

// Absolute extension entry points for the SDK loader, always under the candidate root.
export function runtimeExtensionPaths(runtime) {
	return runtime.extensions.map((e) => path.resolve(runtime.root, e));
}
