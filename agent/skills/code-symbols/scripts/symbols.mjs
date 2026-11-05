#!/usr/bin/env node
// code-symbols: symbol outline, definition lookup and code references for Rust, TypeScript/JavaScript and Python, with no language
// server, no package install and no tool schemas. It replaces pi-serena in worker launches: workers run it through the shell only when
// they need it, so it costs nothing in a launch that does not. Read-only: it never writes, and it skips build output and dependencies.
//
//   node symbols.mjs outline <file>...                       symbols with kinds and line ranges
//   node symbols.mjs find <name or A/b path> [path...] [--body] [--kind <kind>]   where a symbol is defined (and its body)
//   node symbols.mjs refs <name> [path...]                   code references (strings and comments excluded) with the enclosing symbol
//
// Heuristic parsing, not a compiler: macros, generated code and unusual formatting can hide a symbol. Use grep for literal text,
// strings, comments, config and renames.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LANG = { ".rs": "rust", ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts", ".py": "py" };
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "coverage", "graphify-out", "vendor", "__pycache__", "venv", "worktrees"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 20_000;
const MAX_BODY_LINES = 300;
const MAX_RESULTS = 200;
const MAX_OUTLINE = 400;

export const langOf = (file) => LANG[path.extname(file).toLowerCase()];

// ---- Masking: strings and comments become spaces (newlines and quote characters stay), so braces and names in them never count.
function skipTemplate(src, j) {
	while (j < src.length) {
		if (src[j] === "\\") { j += 2; continue; }
		if (src[j] === "`") return j + 1;
		if (src[j] === "$" && src[j + 1] === "{") { j = skipExpression(src, j + 2); continue; }
		j++;
	}
	return src.length;
}
function skipExpression(src, j) {
	let depth = 1;
	while (j < src.length) {
		const c = src[j];
		if (c === "`") { j = skipTemplate(src, j + 1); continue; }
		if (c === '"' || c === "'") { j++; while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1; j++; continue; }
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return j + 1;
		j++;
	}
	return src.length;
}
// No "<", ">" or "}": in TSX they precede closing tags (</a>) and self-closing tags (/>), which are not regex literals.
const REGEX_BEFORE = /[(,=:[!&|?{;+\-*%~^]/;
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "yield", "await", "void", "delete", "instanceof", "new"]);
function regexAllowed(src, i) {
	let k = i - 1;
	while (k >= 0 && /\s/.test(src[k])) k--;
	if (k < 0) return true;
	if (REGEX_BEFORE.test(src[k])) return true;
	if (!/[\w$]/.test(src[k])) return false;
	let s = k;
	while (s > 0 && /[\w$]/.test(src[s - 1])) s--;
	return REGEX_WORDS.has(src.slice(s, k + 1));
}

export function maskCode(src, lang) {
	const out = src.split("");
	const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
	const n = src.length;
	let i = 0;
	while (i < n) {
		const c = src[i];
		const d = src[i + 1];
		if ((lang === "py" && c === "#") || (lang !== "py" && c === "/" && d === "/")) {
			let j = src.indexOf("\n", i);
			if (j < 0) j = n;
			blank(i, j);
			i = j;
			continue;
		}
		if (lang !== "py" && c === "/" && d === "*") {
			let depth = 1;
			let j = i + 2;
			while (j < n && depth > 0) {
				if (lang === "rust" && src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
				if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; continue; }
				j++;
			}
			blank(i, j);
			i = j;
			continue;
		}
		if (lang === "rust" && (c === "r" || c === "b") && !/[\w$]/.test(src[i - 1] ?? "")) {
			const m = /^b?r(#*)"/.exec(src.slice(i, i + 40));
			if (m) {
				const close = `"${m[1]}`;
				let j = src.indexOf(close, i + m[0].length);
				j = j < 0 ? n : j + close.length;
				blank(i + m[0].length, j - close.length);
				i = j;
				continue;
			}
		}
		if (lang === "py" && (c === '"' || c === "'") && src.startsWith(c.repeat(3), i)) {
			const q = c.repeat(3);
			let j = src.indexOf(q, i + 3);
			j = j < 0 ? n : j + 3;
			blank(i + 3, j - 3);
			i = j;
			continue;
		}
		if (lang === "ts" && c === "`") {
			const j = skipTemplate(src, i + 1);
			blank(i + 1, j - 1);
			i = j;
			continue;
		}
		if (c === '"' || (c === "'" && lang !== "rust")) {
			let j = i + 1;
			while (j < n && src[j] !== c) {
				if (src[j] === "\\") j++;
				else if (src[j] === "\n" && lang !== "rust") break;
				j++;
			}
			blank(i + 1, j);
			i = Math.min(n, j + 1);
			continue;
		}
		if (c === "'" && lang === "rust") {
			const m = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/.exec(src.slice(i, i + 14));
			if (m) { blank(i + 1, i + m[0].length - 1); i += m[0].length; continue; }
			i++; // a lifetime such as 'a
			continue;
		}
		if (lang === "ts" && c === "/" && d !== "/" && d !== "*" && d !== ">" && regexAllowed(src, i)) {
			let j = i + 1;
			let inClass = false;
			while (j < n && src[j] !== "\n") {
				if (src[j] === "\\") { j += 2; continue; }
				if (src[j] === "[") inClass = true;
				else if (src[j] === "]") inClass = false;
				else if (src[j] === "/" && !inClass) break;
				j++;
			}
			if (src[j] === "/") { blank(i + 1, j); i = j + 1; continue; }
		}
		i++;
	}
	return out.join("");
}

// ---- Extent of a declaration in masked text. "block": up to the brace that closes its body, or a ";" before any body.
// "stmt": up to the ";" or the line end that finishes the statement.
function nextNonBlank(m, k) {
	const rest = m.slice(k + 1, k + 400);
	const match = /\S/.exec(rest);
	return match ? rest.slice(match.index, match.index + 2) : "";
}
function extentEnd(m, start, mode) {
	let paren = 0, brack = 0, brace = 0, opened = false;
	for (let k = start; k < m.length; k++) {
		const ch = m[k];
		if (ch === "(") paren++;
		else if (ch === ")") paren--;
		else if (ch === "[") brack++;
		else if (ch === "]") brack--;
		else if (ch === "{") { if (mode === "block" && paren === 0 && brack === 0 && brace === 0) opened = true; brace++; }
		else if (ch === "}") {
			brace--;
			if (brace < 0) return k - 1;
			if (mode === "block" && opened && brace === 0) return k;
		} else if (ch === ";" && paren === 0 && brack === 0 && brace === 0 && !opened) return k;
		else if (ch === "\n" && mode === "stmt" && paren <= 0 && brack <= 0 && brace <= 0) {
			const before = m.slice(start, k).trimEnd();
			if (before && !/[=,(\[{+\-*/%&|^!?:<>.]$/.test(before) && !/^(?:[.?:|&+\-*/)\]}=,]|=>)/.test(nextNonBlank(m, k))) return k - 1;
		}
	}
	return m.length - 1;
}

const VIS = String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?`;
const RUST = [
	{ kind: "fn", mode: "block", re: new RegExp(String.raw`^${VIS}(?:(?:default|const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z_]\w*)`) },
	{ kind: "type", mode: "block", re: new RegExp(String.raw`^${VIS}(?:(?:unsafe|auto)\s+)*(struct|enum|union|trait)\s+([A-Za-z_]\w*)`), kindGroup: 1 },
	{ kind: "mod", mode: "block", re: new RegExp(String.raw`^${VIS}mod\s+([A-Za-z_]\w*)`) },
	{ kind: "type", mode: "stmt", re: new RegExp(String.raw`^${VIS}type\s+([A-Za-z_]\w*)`) },
	{ kind: "const", mode: "stmt", re: new RegExp(String.raw`^${VIS}(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:`) },
	{ kind: "macro", mode: "block", re: /^macro_rules!\s*([A-Za-z_]\w*)/ },
	{ kind: "impl", mode: "block", re: /^(?:unsafe\s+)?impl\b\s*(?:<[^{]*?>)?\s*([^{;]+?)\s*(?:\bwhere\b[^{]*)?(?:\{|$)/ },
];
const TS = [
	{ kind: "fn", mode: "block", re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*[<(]/ },
	{ kind: "class", mode: "block", re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "interface", mode: "block", re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "type", mode: "stmt", re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<.*?>)?\s*=/ },
	{ kind: "enum", mode: "block", re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "namespace", mode: "block", re: /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/ },
	{ kind: "const", mode: "stmt", topOnly: true, re: /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ },
];
const TS_MEMBER = /^(?:(?:public|private|protected|static|readonly|async|abstract|override|declare|get|set|accessor)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*\??\s*(?:<[^>]*>)?\s*\(/;
const TS_ARROW_FIELD = /^(?:(?:public|private|protected|static|readonly)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const NOT_MEMBERS = new Set(["if", "for", "while", "switch", "catch", "return", "super", "new", "typeof", "await", "yield", "throw", "function"]);
const FUNCTION_LIKE = new Set(["fn", "method"]);
const FN_VALUE = /^[^=]*=\s*(?:async\s+)?(?:function\b|(?:<[^>]*>\s*)?\([^]*?\)\s*(?::[^=]*?)?=>|[A-Za-z_$][\w$]*\s*=>)/;

function lineIndex(text) {
	const starts = [0];
	for (let k = 0; k < text.length; k++) if (text[k] === "\n") starts.push(k + 1);
	const lineOf = (offset) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };
	return { starts, lineOf };
}

function braceDepths(masked, starts) {
	const depth = new Array(starts.length).fill(0);
	let d = 0, line = 0;
	for (let k = 0; k < masked.length; k++) {
		if (masked[k] === "\n") { depth[++line] = d; continue; }
		if (masked[k] === "{") d++;
		else if (masked[k] === "}") d = Math.max(0, d - 1);
	}
	return depth;
}

function implName(text) {
	const flat = text.replace(/\s+/g, " ").trim();
	const forMatch = / for (.+)$/.exec(flat);
	const target = (forMatch ? forMatch[1] : flat).replace(/^&?(?:mut\s+)?/, "");
	const seg = (/([A-Za-z_]\w*)\s*(?:<.*)?$/.exec(target.replace(/<.*$/, "")) ?? [, target])[1];
	return { name: flat, seg };
}

function nestAndFilter(found) {
	found.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
	const kept = [];
	const stack = [];
	for (const s of found) {
		while (stack.length && stack[stack.length - 1].endOffset < s.startOffset) stack.pop();
		const parent = stack[stack.length - 1];
		if (parent && FUNCTION_LIKE.has(parent.kind)) continue; // locals inside a function body are not symbols
		if (parent && s.endOffset > parent.endOffset) continue; // a header that does not fit its container is noise
		s.parent = parent;
		if (parent?.kind !== undefined && (parent.kind === "class" || parent.kind === "impl" || parent.kind === "trait" || parent.kind === "interface") && s.kind === "fn") s.kind = "method";
		kept.push(s);
		stack.push(s);
	}
	return kept;
}

function braceSymbols(src, lang) {
	const masked = maskCode(src, lang);
	const { starts, lineOf } = lineIndex(masked);
	const depth = braceDepths(masked, starts);
	const lines = masked.split("\n");
	const rules = lang === "rust" ? RUST : TS;
	const found = [];
	const add = (kind, name, seg, startOffset, mode) => {
		const endOffset = extentEnd(masked, startOffset, mode);
		found.push({ kind, name, seg: seg ?? name, startOffset, endOffset, start: lineOf(startOffset) + 1, end: lineOf(Math.max(startOffset, endOffset)) + 1 });
	};
	lines.forEach((line, idx) => {
		const indent = line.length - line.trimStart().length;
		const text = line.trimStart();
		if (!text) return;
		for (const rule of rules) {
			if (rule.topOnly && depth[idx] !== 0) continue;
			const m = rule.re.exec(text);
			if (!m) continue;
			const offset = starts[idx] + indent;
			if (rule.kind === "impl") { const { name, seg } = implName(m[1]); add("impl", name, seg, offset, rule.mode); break; }
			const kind = rule.kindGroup ? m[rule.kindGroup] : rule.kind;
			const name = rule.kindGroup ? m[rule.kindGroup + 1] : m[1] ?? "default";
			if (rule.kind === "const" && lang === "ts") { add(FN_VALUE.test(masked.slice(offset, offset + 600)) ? "fn" : "const", name, name, offset, "stmt"); break; }
			add(kind, name, name, offset, rule.mode);
			break;
		}
	});
	if (lang === "ts") {
		// Members: lines directly inside a class or interface body.
		for (const owner of found.filter((s) => s.kind === "class" || s.kind === "interface")) {
			const bodyDepth = depth[owner.start - 1] + 1;
			for (let idx = owner.start; idx < owner.end - 1; idx++) {
				if (depth[idx] !== bodyDepth) continue;
				const line = lines[idx];
				const text = line.trimStart();
				const arrow = TS_ARROW_FIELD.exec(text);
				const member = arrow ?? TS_MEMBER.exec(text);
				if (!member || NOT_MEMBERS.has(member[1])) continue;
				add("method", member[1], member[1], starts[idx] + line.length - text.length, arrow ? "stmt" : "block");
			}
		}
	}
	return nestAndFilter(found);
}

function pythonSymbols(src) {
	const masked = maskCode(src, "py");
	const { starts, lineOf } = lineIndex(masked);
	const lines = masked.split("\n");
	const indentOf = (line) => line.length - line.trimStart().length;
	const found = [];
	lines.forEach((line, idx) => {
		const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
		if (!m) return;
		const own = m[1].length;
		const offset = starts[idx] + own;
		// The body starts after the ":" that closes the header at paren depth 0 (headers may span lines).
		let paren = 0, k = offset;
		for (; k < masked.length; k++) {
			const ch = masked[k];
			if (ch === "(" || ch === "[") paren++;
			else if (ch === ")" || ch === "]") paren--;
			else if (ch === ":" && paren === 0) break;
		}
		let last = lineOf(k);
		for (let j = last + 1; j < lines.length; j++) {
			if (!lines[j].trim()) continue;
			if (indentOf(lines[j]) <= own) break;
			last = j;
		}
		found.push({ kind: m[2] === "class" ? "class" : "fn", name: m[3], seg: m[3], startOffset: offset, endOffset: starts[last] + lines[last].length, start: idx + 1, end: last + 1 });
	});
	return nestAndFilter(found);
}

/** Symbols of one source text: { kind, name, path, start, end } with 1-based inclusive line ranges, in file order. */
export function symbolsOf(src, lang) {
	const raw = lang === "py" ? pythonSymbols(src) : braceSymbols(src, lang);
	return raw.map((s) => {
		const segs = [];
		for (let p = s; p; p = p.parent) segs.unshift(p.seg);
		let level = 0;
		for (let p = s.parent; p; p = p.parent) level++;
		return { kind: s.kind, name: s.name, path: segs.join("/"), start: s.start, end: s.end, level };
	});
}

// ---- Files.
const rel = (file) => { const r = path.relative(process.cwd(), file); return (r && !r.startsWith("..") && !path.isAbsolute(r) ? r : file).replace(/\\/g, "/"); };
function sourceFiles(targets) {
	const out = [];
	const visit = (p, top) => {
		if (out.length >= MAX_FILES) return;
		let st;
		try { st = fs.lstatSync(p); } catch { if (top) throw new Error(`not found: ${p}`); return; }
		if (st.isSymbolicLink()) return;
		if (st.isDirectory()) {
			const name = path.basename(p);
			if (!top && (name.startsWith(".") || SKIP_DIRS.has(name))) return;
			for (const entry of fs.readdirSync(p).sort()) visit(path.join(p, entry), false);
		} else if (st.isFile() && langOf(p) && st.size <= MAX_FILE_BYTES) out.push(p);
	};
	for (const t of targets.length ? targets : ["."]) visit(path.resolve(t), true);
	return out;
}
const readText = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function matchesName(sym, wanted) {
	if (!wanted.includes("/")) return sym.name === wanted || sym.path.split("/").pop() === wanted;
	return sym.path === wanted || sym.path.endsWith(`/${wanted}`);
}

export function outlineCommand(files) {
	const out = [];
	for (const file of files) {
		const lang = langOf(file);
		if (!lang) { out.push(`${rel(file)}: unsupported file type (Rust, TypeScript/JavaScript and Python only); use read with offset/limit`); continue; }
		const text = readText(file);
		const symbols = symbolsOf(text, lang);
		out.push(`${rel(file)} (${text.split("\n").length} lines, ${symbols.length} symbols)`);
		for (const s of symbols.slice(0, MAX_OUTLINE)) out.push(`${"  ".repeat(s.level + 1)}${s.kind} ${s.name}  L${s.start}-${s.end}`);
		if (symbols.length > MAX_OUTLINE) out.push(`  ... ${symbols.length - MAX_OUTLINE} more`);
	}
	return out.join("\n");
}

export function findCommand(name, targets, opts = {}) {
	const hits = [];
	for (const file of sourceFiles(targets)) {
		const text = readText(file);
		for (const s of symbolsOf(text, langOf(file))) if (matchesName(s, name) && (!opts.kind || s.kind === opts.kind)) hits.push({ file, text, s });
	}
	if (!hits.length) return `no definition of ${name} found (heuristic parser; try grep for the literal name)`;
	const out = [`${hits.length} definition${hits.length === 1 ? "" : "s"} of ${name}`];
	hits.slice(0, MAX_RESULTS).forEach(({ file, text, s }, i) => {
		out.push(`${rel(file)}:${s.start}-${s.end}  ${s.kind}  ${s.path}`);
		if (opts.body && i < 5) {
			const lines = text.split("\n").slice(s.start - 1, s.end);
			lines.slice(0, MAX_BODY_LINES).forEach((l, k) => out.push(`${String(s.start + k).padStart(6)}  ${l}`));
			if (lines.length > MAX_BODY_LINES) out.push(`  ... ${lines.length - MAX_BODY_LINES} more lines: read ${rel(file)} with offset ${s.start + MAX_BODY_LINES}`);
		}
	});
	if (opts.body && hits.length > 5) out.push(`bodies shown for the first 5; narrow with a path or an A/b name`);
	if (hits.length > MAX_RESULTS) out.push(`... ${hits.length - MAX_RESULTS} more`);
	return out.join("\n");
}

export function refsCommand(name, targets) {
	if (!/^[A-Za-z_$#][\w$]*$/.test(name)) throw new Error("refs takes one identifier");
	const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
	const hits = [];
	let files = 0;
	for (const file of sourceFiles(targets)) {
		const text = readText(file);
		const lang = langOf(file);
		const masked = maskCode(text, lang).split("\n");
		const symbols = symbolsOf(text, lang);
		const raw = text.split("\n");
		let any = false;
		masked.forEach((line, idx) => {
			if (!word.test(line)) return;
			const lineNo = idx + 1;
			if (symbols.some((s) => s.start === lineNo && s.path.split("/").pop() === name)) return; // its own definition
			const inside = symbols.filter((s) => s.start <= lineNo && lineNo <= s.end).pop();
			hits.push(`${rel(file)}:${lineNo}  ${inside ? `[${inside.path}]  ` : ""}${raw[idx].trim().slice(0, 160)}`);
			any = true;
		});
		if (any) files++;
	}
	if (!hits.length) return `no code references to ${name} (strings and comments are excluded; grep finds those)`;
	return [`${hits.length} reference${hits.length === 1 ? "" : "s"} to ${name} in ${files} file${files === 1 ? "" : "s"}`, ...hits.slice(0, MAX_RESULTS), ...(hits.length > MAX_RESULTS ? [`... ${hits.length - MAX_RESULTS} more: narrow with a path`] : [])].join("\n");
}

const USAGE = `usage:
  node symbols.mjs outline <file>...
  node symbols.mjs find <name or A/b path> [path...] [--body] [--kind <kind>]
  node symbols.mjs refs <name> [path...]`;

export function main(argv) {
	const [command, ...rest] = argv;
	const body = rest.includes("--body");
	const kindAt = rest.indexOf("--kind");
	const kind = kindAt >= 0 ? rest[kindAt + 1] : undefined;
	const args = rest.filter((a, i) => a !== "--body" && a !== "--kind" && !(kindAt >= 0 && i === kindAt + 1));
	if (command === "outline" && args.length) return outlineCommand(args.map((a) => path.resolve(a)));
	if (command === "find" && args.length) return findCommand(args[0], args.slice(1), { body, kind });
	if (command === "refs" && args.length) return refsCommand(args[0], args.slice(1));
	throw new Error(USAGE);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) {
	try { process.stdout.write(`${main(process.argv.slice(2))}\n`); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
