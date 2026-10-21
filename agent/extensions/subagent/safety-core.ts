// Stage 1 safety core: pure guard rules, a bounded lexical shell matcher and a single-use in-memory grant store.
// Not an OS sandbox and not a shell parser: documented bypasses (scripts, env, aliases, variables, operator shell) are in subagent/README.md.
import * as childProcess from "node:child_process"; // namespace import: test doubles that stub only `spawn` still link
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertExcludeUntracked, candidateFingerprint, validateExclude } from "./candidate-fingerprint.ts";

export type RiskRule =
	| "GIT_PUBLISH" | "GIT_COMMIT" | "GIT_DESTRUCTIVE" | "PKG_PUBLISH_AUTH" | "DESTRUCTIVE_FS" | "LINKS" | "PRIVILEGE_PERSIST" | "PROC_KILL"
	| "LAUNCH_PI" | "CURL_SHELL" | "OPAQUE_UNPARSEABLE" | "SECRET" | "CONFIG_WRITE" | "PATH_AMBIGUOUS";

export type GuardOp = { kind: "shell"; command: string; cwd: string } | { kind: "write"; path: string } | { kind: "read"; path: string };
export type Decision = { action: "allow" } | { action: "block"; rules: RiskRule[]; grantable: boolean; op: GuardOp; digest: string };
export interface ShellClassification { rules: RiskRule[]; grantable: boolean }

export const MAX_GRANT_OPS = 5;
export const GRANT_TTL_DEFAULT_MS = 30 * 60_000;
export const GRANT_TTL_MAX_MS = 60 * 60_000;
const MAX_NESTING = 4;

const NOT_GRANTABLE = new Set<RiskRule>(["OPAQUE_UNPARSEABLE", "SECRET", "PATH_AMBIGUOUS"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const WRAPPERS = new Set(["env", "command", "nohup", "time", "timeout", "exec", "call", "start", "nice", "xargs"]);
const DELETE_CMDS = new Set(["rm", "rmdir", "rd", "unlink", "shred", "del", "erase", "rimraf", "remove-item", "ri"]);
const PRIVILEGE_CMDS = new Set(["sudo", "runas", "schtasks", "reg", "setx", "crontab", "icacls", "takeown", "chmod", "chown", "register-scheduledtask", "new-scheduledtask"]);
const PROC_CMDS = new Set(["kill", "killall", "pkill", "taskkill", "stop-process"]);
const WRITE_CMDS = new Set(["cp", "copy", "mv", "move", "tee", "set-content", "out-file", "add-content", "copy-item", "move-item", "sed", "new-item"]);
const PKG_SUBS = new Set(["publish", "login", "adduser", "logout", "token", "owner", "access", "dist-tag"]);
const SECRET_BASENAME = /^(auth\.json|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|credentials|credentials\.json)$|^\.env(\..+)?$|\.(pem|key|p12|pfx)$/;
const SECRET_SAFE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const CREDENTIAL_TEXT = /(token|password|secret|api[_-]?key|authorization)\s*[=:]|_authtoken|\bBearer\s+\S+|\b(sk-|ghp_|github_pat_|xox[bp]-|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

type Token = { text: string; op: boolean };

// Escape character of the lexical reading being classified (null raw, backslash POSIX, backtick PowerShell); set by classifyVariants, synchronous, always reset.
let esc: string | null = null;
// Outside quotes the escape character takes the next character literally; inside double quotes POSIX shells unescape only " \ $ and backtick, PowerShell any character; single quotes never.
function escapes(quote: string | null, next: string): boolean {
	return quote === "'" ? false : quote === "\"" && esc === "\\" ? "\"\\$`".includes(next) : true;
}

// Unquoted < and > end the word before them; an unquoted run (<, >, >>, &>) is one op token, and a digit-only word before it is an fd number. Quoted text is never an operator.
function tokenize(segment: string): Token[] {
	const out: Token[] = [];
	let current = "";
	let quote: string | null = null;
	let started = false;
	let redirect = false;
	const flush = () => {
		if (started || current) out.push({ text: current, op: redirect });
		current = "";
		started = false;
		redirect = false;
	};
	const chars = Array.from(segment);
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (esc && ch === esc && i + 1 < chars.length && escapes(quote, chars[i + 1])) {
			if (redirect) flush();
			current += chars[++i];
			started = true;
		} else if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === "<" || ch === ">") {
			if (!redirect) {
				if (/^\d+$/.test(current)) current = "";
				else flush();
				redirect = true;
			}
			current += ch;
			started = true;
		} else {
			if (redirect && !((ch === "|" || ch === "&") && /[<>]$/.test(current))) flush(); // >| and >& keep their second character in the operator
			if (ch === "\"" || ch === "'") {
				quote = ch;
				started = true;
			} else if (/\s/.test(ch)) {
				flush();
			} else {
				current += ch;
				started = true;
			}
		}
	}
	flush();
	return out;
}

// Redirections (operator plus target) are neither the command word nor its arguments; SECRET and CONFIG_WRITE still read every token.
function argvOf(tokens: Token[]): string[] {
	const words: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].op) i++;
		else words.push(tokens[i].text);
	}
	return words;
}

function commandName(token: string): string {
	return token.toLowerCase().split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}

function basenameOf(token: string): string {
	return token.split(/[\\/]/).pop() ?? "";
}

const SHELL_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
// Value-taking options per tool (git -c and -C both take a value; gh -R/--repo; npm --registry etc.).
const GIT_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);
const NPM_VALUE = new Set(["--registry", "--userconfig", "--globalconfig", "--prefix", "--cache", "-w", "--workspace", "--loglevel", "--otp", "--tag"]);
const GH_VALUE = new Set(["-r", "--repo", "--hostname"]);
const PS_VALUE = new Set(["-executionpolicy", "-ep", "-windowstyle", "-w", "-workingdirectory", "-wd", "-inputformat", "-if", "-outputformat", "-of", "-configurationname", "-settingsfile"]);
const TIMEOUT_VALUE = new Set(["-s", "-k", "--signal", "--kill-after"]);
const NICE_VALUE = new Set(["-n", "--adjustment"]);
const XARGS_VALUE = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--replace"]);
const SUDO_VALUE = new Set(["-u", "-g", "-c", "-C", "-d", "-D", "-h", "-p", "-r", "-t", "-U"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// True when the > just before the | or & at index `at` is a redirection: an odd backslash run escapes it.
// shortcut: backslash parity only, no quote-aware escape lexer (quoted text never reaches this check), upgrade with a real shell lexer.
function isRedirectAt(text: string, at: number): boolean {
	let slashes = 0;
	for (let j = at - 2; j >= 0 && text[j] === "\\"; j--) slashes++;
	return text[at - 1] === ">" && slashes % 2 === 0;
}

// Splits text on separators outside single quotes; command substitution still splits inside double quotes. Unbalanced quotes fall back to a plain split (fail closed).
function splitSegments(text: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | "\"" | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1] ?? "";
		if (esc && ch === esc && i + 1 < text.length && escapes(quote, next)) {
			current += ch + next; // an escaped pair neither toggles quotes nor splits
			i++;
		} else if (quote === "'") {
			if (ch === "'") quote = null;
			current += ch;
		} else if (quote === "\"" && ch !== "`" && !(ch === "$" && next === "(")) {
			if (ch === "\"") quote = null;
			current += ch;
		} else if (ch === "'" || ch === "\"") {
			quote = ch;
			current += ch;
		} else if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || (ch === "$" && next === "(")) {
			segments.push(current);
			current = "";
			i++;
		} else if ((ch === "|" || ch === "&") && isRedirectAt(text, i)) {
			current += ch; // >| and >& are redirections whose target stays in this segment, not pipes or background separators
		} else if ((esc === "`" ? ";&|(){}\n\r" : ";&|()`{}\n\r").includes(ch)) {
			segments.push(current);
			current = "";
		} else current += ch;
	}
	if (quote !== null) return text.replace(/&&|\|\||\$\(|(?<![<>])[;&|()`{}\n\r]/g, "\n").split("\n");
	segments.push(current);
	return segments;
}

// Leading keywords (if/then/do/!/braces) and VAR=value assignments do not change the command that runs.
function stripPrefix(tokens: string[]): string[] {
	let t = tokens;
	while (t.length && (SHELL_KEYWORDS.has(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) t = t.slice(1);
	if (t.length && /^!./.test(t[0])) return [t[0].slice(1), ...t.slice(1)];
	return t;
}

// Non-option tokens after skipping each tool's value-taking options.
function positionals(lower: string[], valueOpts: Set<string>): string[] {
	const found: string[] = [];
	for (let i = 0; i < lower.length; i++) {
		if (valueOpts.has(lower[i])) i++;
		else if (!lower[i].startsWith("-")) found.push(lower[i]);
	}
	return found;
}

// Index of the wrapped command. env: skips GNU-style assignments (any word with '=' not starting '-'); an option there is rejected by the caller (never modelled).
function wrappedStart(name: string, args: string[]): number {
	const lower = args.map((a) => a.toLowerCase());
	let i = 0;
	if (name === "env") {
		while (i < args.length && args[i].includes("=") && !args[i].startsWith("-")) i++;
		return i;
	}
	if (name === "timeout") {
		while (i < args.length && lower[i].startsWith("-")) i += TIMEOUT_VALUE.has(lower[i]) ? 2 : 1;
		return i + 1;
	}
	if (name === "nice") {
		while (i < args.length && lower[i].startsWith("-")) i += NICE_VALUE.has(lower[i]) ? 2 : 1;
		return i;
	}
	if (name === "xargs") {
		while (i < args.length && args[i].startsWith("-")) i += XARGS_VALUE.has(args[i]) ? 2 : 1;
		return i;
	}
	if (name === "sudo") {
		while (i < args.length && args[i].startsWith("-")) i += SUDO_VALUE.has(args[i]) ? 2 : 1;
		return i;
	}
	while (i < args.length && args[i].startsWith("-")) i++;
	return i;
}

// Prefix match for PowerShell switches (-c, -com, -enc, ...); a one-letter switch is not treated as a prefix.
function isPrefixOf(arg: string, flag: string): boolean {
	return arg.length >= 2 && flag.startsWith(arg);
}

// Text PowerShell runs: after -Command, or the first positional argument when no switch names it.
function powershellText(args: string[]): string | undefined {
	const lower = args.map((a) => a.toLowerCase());
	for (let i = 0; i < args.length; i++) {
		if (isPrefixOf(lower[i], "-command")) return args.slice(i + 1).join(" ");
		if (PS_VALUE.has(lower[i])) i++;
		else if (!lower[i].startsWith("-")) return args.slice(i).join(" ");
	}
	return undefined;
}

// Mirrors Pi tool path normalization (unicode spaces, leading @, MSYS /c/ drive, ~, file://) so the guard checks the path the tool opens.
function piPathInput(input: string, expandHome = true): string {
	let p = input.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (process.platform === "win32" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
		const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
		if (m) p = `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/\//g, "\\")}`;
	}
	if (expandHome && p === "~") p = os.homedir();
	else if (expandHome && (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\")))) p = path.join(os.homedir(), p.slice(2));
	if (p.startsWith("file://")) p = fileURLToPath(p);
	return p;
}

export function isSecretBasename(name: string): boolean {
	const lower = name.toLowerCase();
	return !SECRET_SAFE_NAMES.has(lower) && SECRET_BASENAME.test(lower);
}

function isConfigToken(token: string): boolean {
	const norm = token.toLowerCase().replace(/\\/g, "/");
	return basenameOf(norm) === "settings.json" || /(^|\/)\.git\/(hooks\/|config$)/.test(norm);
}

function add(out: Set<RiskRule>, ...rules: RiskRule[]): void {
	for (const rule of rules) out.add(rule);
}

// Set by the gh branch of classifySegment while isMergeOrRelease classifies (synchronous, reset every call).
let mergeReleaseSeen = false;

// Classifier-level recognition of `gh pr merge` / `gh release create` in any spelling the shell tokenizer reads the same way (quoted words, wrappers, nested shells, compound segments).
function isMergeOrRelease(command: string): boolean {
	const text = String(command ?? "");
	mergeReleaseSeen = false;
	let seen = false;
	try {
		classifyVariants(text, new Set()); // the flag accumulates across every reading
	} finally {
		seen = mergeReleaseSeen;
		mergeReleaseSeen = false;
	}
	return seen || MERGE_OR_RELEASE.test(text);
}

// Every lexical reading of the same text: raw and Git Bash backslash-pair collapse, each with no escape, POSIX backslash and PowerShell backtick escapes. A conservative union (over-blocks exotic benign text), shared by classifyShell and merge/release recognition.
function classifyVariants(text: string, out: Set<RiskRule>): void {
	for (const t of [text, text.replace(/\\\\/g, "\\")]) {
		for (const e of [null, "\\", "`"]) {
			esc = e;
			try {
				classifyText(t, out, 0);
			} finally {
				esc = null;
			}
		}
	}
}

// Classifies one command segment (already split on separators). Wrappers and nested shells recurse with a depth bound.
function classifySegment(rawTokens: string[], out: Set<RiskRule>, depth: number): void {
	const tokens = stripPrefix(rawTokens);
	if (tokens.length === 0) return;
	if (depth > MAX_NESTING) return add(out, "OPAQUE_UNPARSEABLE");
	const name = commandName(tokens[0]);
	const args = tokens.slice(1);
	const lower = args.map((a) => a.toLowerCase());
	const subOf = (valueOpts: Set<string> = new Set()) => positionals(lower, valueOpts)[0] ?? "";
	const after = (flags: string[]) => {
		const i = lower.findIndex((a) => flags.includes(a));
		return i < 0 ? undefined : args.slice(i + 1).join(" ");
	};
	if (name === "sudo" || name === "runas") add(out, "PRIVILEGE_PERSIST");
	if (WRAPPERS.has(name) || name === "sudo") {
		const start = wrappedStart(name, args);
		// shortcut: every env option (-i, -u, -S, --, -, long forms) is unsupported and non-grantable, so no env grammar is modelled; benign `env -i node` is over-blocked.
		if (name === "env" && args[start]?.startsWith("-")) return add(out, "OPAQUE_UNPARSEABLE");
		return classifySegment(args.slice(start), out, depth + 1);
	}
	if (name === "eval") return add(out, "OPAQUE_UNPARSEABLE");
	if (SHELLS.has(name)) {
		const at = lower.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)); // -c inside any short flag cluster (-xc, -ec, -lc)
		if (at >= 0) classifyText(args.slice(at + 1).join(" "), out, depth + 1);
		return;
	}
	if (POWERSHELLS.has(name)) {
		if (lower.some((a) => isPrefixOf(a, "-encodedcommand"))) return add(out, "OPAQUE_UNPARSEABLE");
		const inner = powershellText(args);
		if (inner !== undefined) classifyText(inner, out, depth + 1);
		return;
	}
	if (name === "cmd") {
		const inner = after(["/c", "/k"]);
		if (inner !== undefined) classifyText(inner, out, depth + 1);
		return;
	}
	if (name === "git") {
		const sub = subOf(GIT_VALUE);
		if (sub === "push") add(out, "GIT_PUBLISH");
		if (sub === "reset" && (lower.includes("--hard") || lower.includes("--merge"))) add(out, "GIT_DESTRUCTIVE");
		if (["clean", "restore", "rebase"].includes(sub)) add(out, "GIT_DESTRUCTIVE");
		if (sub === "checkout" && (lower.includes("--") || lower.includes("."))) add(out, "GIT_DESTRUCTIVE");
		if (sub === "stash" && lower.some((a) => ["drop", "clear", "pop"].includes(a))) add(out, "GIT_DESTRUCTIVE");
		if (sub === "branch" && lower.some((a) => a === "-d" || a === "--delete")) add(out, "GIT_DESTRUCTIVE");
		if (sub === "worktree" && lower.some((a) => a === "remove" || a === "prune")) add(out, "GIT_DESTRUCTIVE");
		if (sub === "tag" && lower.includes("-d")) add(out, "GIT_DESTRUCTIVE");
		if (sub === "commit") add(out, "GIT_COMMIT");
		// git accepts any unambiguous long-option prefix of --amend (--am, --ame, --amen).
		if (sub === "commit" && lower.some((a) => a.split("=")[0].length >= 4 && "--amend".startsWith(a.split("=")[0]))) add(out, "GIT_DESTRUCTIVE");
		if (sub === "config" && lower.some((a) => a === "--global" || a === "--system")) add(out, "PRIVILEGE_PERSIST");
		if (sub === "config" && lower.some((a) => a.includes("hookspath"))) add(out, "CONFIG_WRITE");
		if (lower.some((a) => a.startsWith("core.hookspath="))) add(out, "CONFIG_WRITE");
		return;
	}
	if (name === "gh") {
		const [sub1 = "", sub2 = ""] = positionals(lower, GH_VALUE);
		if ((sub1 === "pr" && sub2 === "merge") || (sub1 === "release" && sub2 === "create")) mergeReleaseSeen = true;
		if ((sub1 === "pr" && ["create", "merge", "close", "edit", "ready", "review"].includes(sub2)) || sub1 === "release" || (sub1 === "repo" && ["create", "delete", "rename", "edit"].includes(sub2))) add(out, "GIT_PUBLISH");
		if (sub1 === "api" && lower.some((a) => ["post", "put", "patch", "delete"].includes(a))) add(out, "GIT_PUBLISH");
		if (sub1 === "auth") add(out, "PKG_PUBLISH_AUTH");
		return;
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
		const sub = subOf(NPM_VALUE);
		if (PKG_SUBS.has(sub)) add(out, "PKG_PUBLISH_AUTH");
		if (sub === "config" && lower.some((a) => a.includes("_authtoken") || a.startsWith("//"))) add(out, "PKG_PUBLISH_AUTH");
		return;
	}
	if (DELETE_CMDS.has(name)) return add(out, "DESTRUCTIVE_FS");
	if (name === "find" && (lower.includes("-delete") || (lower.includes("-exec") && lower.includes("rm")))) return add(out, "DESTRUCTIVE_FS");
	if (name === "ln" || name === "mklink") return add(out, "LINKS");
	if (name === "fsutil" && lower.some((a) => a === "hardlink" || a === "reparsepoint")) return add(out, "LINKS");
	if (name === "new-item" && lower.some((a) => ["symboliclink", "junction", "hardlink"].includes(a))) return add(out, "LINKS");
	if (PRIVILEGE_CMDS.has(name)) return add(out, "PRIVILEGE_PERSIST");
	if (name === "net" && (lower[0] === "user" || lower[0] === "localgroup")) return add(out, "PRIVILEGE_PERSIST");
	if (PROC_CMDS.has(name)) return add(out, "PROC_KILL");
	if (name === "pi" || (name === "npx" && lower.some((a) => a === "pi" || a.includes("pi-coding-agent"))) || (name === "node" && lower.some((a) => a.includes("pi-coding-agent")))) return add(out, "LAUNCH_PI");
	if ((name === "base64" && lower.some((a) => a === "-d" || a === "--decode" || a === "-D")) || (name === "certutil" && lower.includes("-decode"))) return add(out, "OPAQUE_UNPARSEABLE");
}

// Splits on separators (&&, ||, ;, |, &, newline, backtick, parentheses) outside quotes is approximated; unbalanced quotes are not flagged alone.
function classifyText(text: string, out: Set<RiskRule>, depth: number): void {
	if (depth > MAX_NESTING) return add(out, "OPAQUE_UNPARSEABLE");
	const segments = splitSegments(text);
	const allTokens: string[] = [];
	for (const raw of segments) {
		const tokens = tokenize(raw);
		allTokens.push(...tokens.map((t) => t.text));
		const words = argvOf(tokens);
		classifySegment(words, out, depth);
		if (tokens.length && (WRITE_CMDS.has(commandName(words[0] ?? "")) || raw.includes(">")) && tokens.some((t) => isConfigToken(t.text))) add(out, "CONFIG_WRITE");
	}
	if (allTokens.some((t) => isSecretBasename(basenameOf(t)))) add(out, "SECRET");
	if (/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&\n]*\|\s*(sh|bash|zsh|dash|iex|invoke-expression|pwsh|powershell|cmd)\b/i.test(text)) add(out, "CURL_SHELL");
	if (/\b(iex|invoke-expression)\b.*\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(text)) add(out, "CURL_SHELL");
}

// Git Bash argv collapses each backslash pair before the shell parses it (a run of n reaches the shell as ceil(n/2)): classify raw and collapsed text, a conservative union. Grant text stays raw (decideToolCall).
// shortcut: collapse applies on every platform and shell (over-blocks PowerShell/POSIX text with backslash pairs), upgrade by gating on the verified Git Bash argv transport.
export function classifyShell(command: string, gateCommits = false): ShellClassification {
	const text = String(command ?? "");
	const out = new Set<RiskRule>();
	classifyVariants(text, out);
	// Commits are gated only in the trusted release-engineer child; elsewhere git commit stays unclassified as before.
	if (!gateCommits) out.delete("GIT_COMMIT");
	const rules = [...out];
	return { rules, grantable: !rules.some((r) => NOT_GRANTABLE.has(r)) };
}

function ambiguousReason(p: string, typed: string): string | undefined {
	if (p.includes("\0")) return "nul byte";
	if (p.replace(/^[a-zA-Z]:/, "").includes(":")) return "alternate data stream";
	const base = (p.split(/[\\/]/).pop() ?? "").split(".")[0].toUpperCase();
	if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) return "device name";
	const name = p.split(/[\\/]/).pop() ?? "";
	// Every typed component, not only the last: an alias ancestor (SSH~1) reaches a protected directory without the final name showing it.
	// shortcut: any ~<digit> component is treated as a possible 8.3 alias (may over-block a literal ~1 name), upgrade to native realpath when the target volume's aliases can be resolved.
	if (typed.split(/[\\/]/).some((c) => /~\d/.test(c))) return "8.3 short name";
	if (process.platform === "win32" && name !== "." && name !== ".." && /[. ]$/.test(name)) return "trailing dot or space";
	return undefined;
}

// Canonical path: deepest existing ancestor is realpath-resolved, so symlinks/junctions resolve to their target before matching.
export function canonicalPath(rawInput: string, cwd: string): { path: string; ambiguous?: undefined } | { path?: undefined; ambiguous: string } {
	let input: string;
	let typed: string;
	try {
		input = piPathInput(rawInput);
		typed = piPathInput(rawInput, false);
	} catch {
		return { ambiguous: "unparseable path" };
	}
	// A cwd joins a relative target before expansion: an 8.3 alias in the cwd is ambiguous like one in the target.
	const reason = ambiguousReason(input, path.isAbsolute(typed) ? typed : `${cwd}${path.sep}${typed}`);
	if (reason) return { ambiguous: reason };
	const absolute = path.resolve(cwd, input);
	let existing = absolute;
	const rest: string[] = [];
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		rest.unshift(path.basename(existing));
		existing = parent;
	}
	try {
		return { path: path.join(fs.realpathSync(existing), ...rest) };
	} catch {
		return { ambiguous: "unresolvable path" };
	}
}

function isSecretPath(canonical: string): boolean {
	const parts = canonical.split(/[\\/]/);
	return isSecretBasename(parts[parts.length - 1] ?? "") || parts.some((p) => SECRET_DIRS.has(p.toLowerCase()));
}

function isConfigWritePath(canonical: string, agentDir: string): boolean {
	const norm = canonical.toLowerCase().replace(/\\/g, "/");
	const base = basenameOf(norm);
	const agent = path.resolve(agentDir).toLowerCase().replace(/\\/g, "/");
	return base === "settings.json" || /(^|\/)\.git\/(hooks\/|config$)/.test(norm) || (norm.startsWith(agent) && base.includes("trust"));
}

export function canonicalCwd(cwd: string): string {
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

// Command text is case-exact; only the Windows path (cwd or target) is case-folded.
function foldPath(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

function keyOf(op: GuardOp): string {
	return op.kind === "shell" ? JSON.stringify(["shell", op.command, foldPath(op.cwd)]) : JSON.stringify([op.kind, foldPath(op.path)]);
}

function block(rules: RiskRule[], op: GuardOp): Decision {
	const grantable = !rules.some((r) => NOT_GRANTABLE.has(r));
	return { action: "block", rules, grantable, op, digest: createHash("sha256").update(keyOf(op)).digest("hex").slice(0, 16) };
}

export function decideToolCall(toolName: string, input: Record<string, unknown>, cwd: string, agentDir: string, gateCommits = false): Decision {
	if (toolName === "bash" || toolName === "powershell") {
		const command = String(input.command ?? "");
		const { rules } = classifyShell(command, gateCommits);
		return rules.length ? block(rules, { kind: "shell", command, cwd: canonicalCwd(cwd) }) : { action: "allow" };
	}
	if (toolName === "write" || toolName === "edit") {
		const target = String(input.path ?? "");
		const canon = canonicalPath(target, cwd);
		if (canon.ambiguous) return block(["PATH_AMBIGUOUS"], { kind: "write", path: path.resolve(cwd, piPathInput(target)) });
		if (isSecretPath(canon.path)) return block(["SECRET"], { kind: "write", path: canon.path });
		if (isConfigWritePath(canon.path, agentDir)) return block(["CONFIG_WRITE"], { kind: "write", path: canon.path });
		return { action: "allow" };
	}
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
		const target = String(input.path ?? ".");
		const canon = canonicalPath(target, cwd);
		if (canon.ambiguous) return block(["PATH_AMBIGUOUS"], { kind: "read", path: path.resolve(cwd, piPathInput(target)) });
		if (isSecretPath(canon.path)) return block(["SECRET"], { kind: "read", path: canon.path });
	}
	return { action: "allow" };
}

export function describeOp(op: GuardOp): string {
	return op.kind === "shell" ? `shell in ${op.cwd}: ${op.command}` : `${op.kind} ${op.path}`;
}

const MAX_OP_CHARS = 4096;
const MAX_BATCH_CHARS = 16384;
const UNSAFE_DISPLAY = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

// Refuses text the operator could not read exactly (format/bidi/line-separator/control, oversize). Nothing is truncated.
function assertDisplayable(text: string): void {
	if (text.length > MAX_OP_CHARS) throw new RangeError(`operation text exceeds ${MAX_OP_CHARS} characters`);
	if (UNSAFE_DISPLAY.test(text)) throw new RangeError("invisible, bidi, line-separator or control characters are not authorizable");
	if (CREDENTIAL_TEXT.test(text)) throw new RangeError("credential-like text is not authorizable; use the operator out-of-band");
}

function validateOp(op: GuardOp): void {
	if (op.kind === "shell") {
		if (typeof op.command !== "string" || !op.command.trim() || !path.isAbsolute(op.cwd)) throw new TypeError("shell op needs a command and an absolute cwd");
		assertDisplayable(op.command);
		assertDisplayable(op.cwd);
	} else if (op.kind === "write" || op.kind === "read") {
		if (typeof op.path !== "string" || !path.isAbsolute(op.path)) throw new TypeError("path op needs an absolute path");
		assertDisplayable(op.path);
	} else throw new TypeError("unknown op kind");
}

export interface GrantRecord { id: string; bearer: string; role: string | null; candidate: string; op: GuardOp; expiresAt: number }
export interface MintRequest { role: string | null; candidate: string; ops: GuardOp[]; ttlMs?: number }
export type GuardScope = "main" | "child";

export interface GrantStore {
	mint(request: MintRequest): GrantRecord[];
	consume(scope: GuardScope, candidate: string, op: GuardOp): boolean;
	claim(role: string, candidate: string): GrantRecord[];
	importRecords(records: GrantRecord[]): void;
	revokeAll(includeLeases?: boolean): void;
	size(): number;
	mintLease(request: { candidate: string; pushUrl: string; branch: string; commits?: boolean; artifactDir?: string }): PushLease;
	findLease(candidate: string, branch: string, pushUrl: string): PushLease | undefined;
	hasLease(candidate: string, branch: string, pushUrl: string): boolean;
	copyLeases(candidate: string): PushLease[];
	importLeases(incoming: PushLease[]): void;
	leaseCount(): number;
	addDeliveryGrant(binding: DeliveryBinding): DeliveryGrant;
	findDelivery(binding: DeliveryBinding): DeliveryGrant | undefined;
	findSuperseded(binding: DeliveryBinding): DeliveryGrant | undefined;
	copyDelivery(candidate: string): DeliveryGrant[];
	importDelivery(incoming: DeliveryGrant[]): void;
	deliveryCount(): number;
	summary(now: number): { count: number; main: number; roleBound: number; shell: number; write: number; read: number; nextExpiry?: number };
	listLeases(): PushLease[];
	listDelivery(): DeliveryGrant[];
}

function validateRecord(value: unknown): GrantRecord {
	const r = value as GrantRecord;
	if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[0-9a-f]{64}$/.test(String(r.bearer)) || !(r.role === null || typeof r.role === "string") || typeof r.candidate !== "string" || !path.isAbsolute(r.candidate) || typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) throw new TypeError("invalid grant record");
	validateOp(r.op);
	return r;
}

export function createGrantStore(now: () => number = () => Date.now()): GrantStore {
	let records: GrantRecord[] = [];
	let leases: PushLease[] = [];
	let delivery: DeliveryGrant[] = [];
	const live = () => {
		const t = now();
		records = records.filter((r) => r.expiresAt > t);
		return t;
	};
	return {
		mint({ role, candidate, ops, ttlMs = GRANT_TTL_DEFAULT_MS }) {
			if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_GRANT_OPS) throw new RangeError(`a batch carries 1 to ${MAX_GRANT_OPS} operations`);
			if (!(ttlMs > 0 && ttlMs <= GRANT_TTL_MAX_MS)) throw new RangeError("ttl must be above 0 and at most 60 minutes");
			if (!path.isAbsolute(candidate)) throw new TypeError("candidate must be absolute");
			ops.forEach(validateOp);
			const expiresAt = live() + ttlMs;
			const minted = ops.map((op) => ({ id: randomUUID(), bearer: randomBytes(32).toString("hex"), role, candidate, op, expiresAt }));
			records.push(...minted);
			return minted;
		},
		consume(scope, candidate, op) {
			const t = live();
			const index = records.findIndex((r) => (scope === "main" ? r.role === null : r.role !== null) && foldPath(r.candidate) === foldPath(candidate) && keyOf(r.op) === keyOf(op) && r.expiresAt > t);
			if (index < 0) return false;
			records.splice(index, 1);
			return true;
		},
		claim(role, candidate) {
			const t = live();
			const taken = records.filter((r) => r.role === role && r.candidate === candidate && r.expiresAt > t);
			records = records.filter((r) => !taken.includes(r));
			return taken;
		},
		importRecords(incoming) {
			const valid = incoming.map(validateRecord);
			records.push(...valid);
		},
		revokeAll(includeLeases = false) {
			records = [];
			if (includeLeases) {
				leases = [];
				delivery = [];
			}
		},
		mintLease({ candidate, pushUrl, branch, commits, artifactDir }) {
			if (!path.isAbsolute(candidate)) throw new TypeError("candidate must be absolute");
			const lease = validateLease({ role: LEASE_ROLE, candidate: canonicalCwd(candidate), pushUrl, branch, commits: commits === true ? true : undefined, artifactDir: commits === true ? artifactDir : undefined });
			const existing = leases.find((l) => sameLease(l, lease));
			if (existing) {
				// Upgrade only: a push-only repeat keeps the stored commit scope; a commit grant sets the artifact directory it approved.
				if (lease.commits) {
					existing.commits = true;
					if (lease.artifactDir) existing.artifactDir = lease.artifactDir;
					else delete existing.artifactDir;
				}
				return { ...existing };
			}
			if (leases.length >= MAX_PUSH_LEASES) throw new RangeError(`at most ${MAX_PUSH_LEASES} push leases per session`);
			leases.push(lease);
			return { ...lease };
		},
		hasLease(candidate, branch, pushUrl) {
			return leases.some((l) => foldPath(l.candidate) === foldPath(candidate) && l.branch === branch && l.pushUrl === pushUrl);
		},
		findLease(candidate, branch, pushUrl) {
			return leases.find((l) => foldPath(l.candidate) === foldPath(candidate) && l.branch === branch && l.pushUrl === pushUrl);
		},
		copyLeases(candidate) {
			return leases.filter((l) => foldPath(l.candidate) === foldPath(candidate)).map((l) => ({ ...l }));
		},
		importLeases(incoming) {
			for (const lease of incoming.map((l) => validateLease(l))) {
				if (leases.some((l) => sameLease(l, lease))) continue;
				if (leases.length >= MAX_PUSH_LEASES) throw new RangeError(`at most ${MAX_PUSH_LEASES} push leases per session`);
				leases.push(lease);
			}
		},
		leaseCount() {
			return leases.length;
		},
		addDeliveryGrant(binding) {
			const t = live();
			const next = normalizeBinding(binding);
			const existing = delivery.find((d) => sameBinding(d, next));
			if (existing) return { ...existing };
			// A new bound state for the same scope replaces the older bound record only (the caller confirmed it); unbound records are never touched.
			const stale = next.bound ? delivery.findIndex((d) => d.bound && sameScope(d, next)) : -1;
			if (stale >= 0) {
				const replaced = { ...next, issuedAt: t };
				delivery[stale] = replaced;
				return { ...replaced };
			}
			if (delivery.length >= MAX_DELIVERY_GRANTS) throw new RangeError(`at most ${MAX_DELIVERY_GRANTS} live delivery grants`);
			const record = { ...next, issuedAt: t };
			delivery.push(record);
			return { ...record };
		},
		findSuperseded(binding) {
			live();
			const next = normalizeBinding(binding);
			const found = next.bound ? delivery.find((d) => d.bound && sameScope(d, next) && !sameBinding(d, next)) : undefined;
			return found ? { ...found } : undefined;
		},
		findDelivery(binding) {
			live();
			const next = normalizeBinding(binding);
			const found = delivery.find((d) => sameBinding(d, next));
			return found ? { ...found } : undefined;
		},
		copyDelivery(candidate) {
			live();
			return delivery.filter((d) => normPath(d.candidate) === normPath(candidate) && artifactStillLive(d)).map((d) => ({ ...d }));
		},
		importDelivery(incoming) {
			delivery.push(...incoming.map((d) => validateDelivery(d)));
		},
		deliveryCount() {
			live();
			return delivery.length;
		},
		summary(at) {
			const mine = records.filter((r) => r.expiresAt > at);
			const expiries = mine.map((r) => r.expiresAt);
			return {
				count: mine.length,
				main: mine.filter((r) => r.role === null).length,
				roleBound: mine.filter((r) => r.role !== null).length,
				shell: mine.filter((r) => r.op.kind === "shell").length,
				write: mine.filter((r) => r.op.kind === "write").length,
				read: mine.filter((r) => r.op.kind === "read").length,
				nextExpiry: expiries.length ? Math.min(...expiries) : undefined,
			};
		},
		listLeases() {
			return leases.slice(0, MAX_PUSH_LEASES).map((l) => ({ ...l }));
		},
		listDelivery() {
			return delivery.slice(0, MAX_DELIVERY_GRANTS).map((d) => ({ ...d }));
		},
		size() {
			return records.length;
		},
	};
}

export const CHILD_GRANT_ENV = "PI_SAFETY_GRANTS";

// Push target of the trusted release-engineer launch. `base` is the optional parent-supplied PR base: when present, PR create/edit must match it exactly; when absent the legacy syntactic-only base check applies.
export interface PushTarget { candidate: string; pushUrl: string; branch: string; base?: string }

export function serializeGrants(records: GrantRecord[], leases: PushLease[] = [], delivery: DeliveryGrant[] = [], gateCommits = false, pushTarget?: PushTarget): string {
	// A known PR base travels under its own key (pushTargetBound), never inside pushTarget: a loader that predates it ignores the unknown key and sees no push target (every automatic PR/push path stays blocked) instead of rebuilding a legacy target that drops the base.
	// Action grants (merge/release) travel under their own key: an older loader ignores unknown keys and so sees no grant, never a broader one. The legacy delivery/deliveryBound keys are never written.
	return JSON.stringify({ v: 1, grants: records, ...(leases.length ? { leases } : {}), ...(delivery.length ? { deliveryActions: delivery } : {}), ...(gateCommits ? { gateCommits: true } : {}), ...(pushTarget ? (pushTarget.base !== undefined ? { pushTargetBound: pushTarget } : { pushTarget }) : {}) });
}

export function loadChildGrants(text: string): GrantRecord[] {
	const parsed = JSON.parse(text) as { v?: number; grants?: unknown };
	if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.grants)) throw new TypeError("invalid grant envelope");
	return parsed.grants.map(validateRecord);
}

// Release-engineer PR-branch push lease: a trusted-main approval binds candidate, origin push URL and one feature branch. Session-only (memory), no expiry, never written to disk or config.
export const LEASE_ROLE = "release-engineer";
// At most this many distinct push/commit bindings per session; a further distinct binding is refused, never evicted.
export const MAX_PUSH_LEASES = 8;
export interface PushLease { role: string; candidate: string; pushUrl: string; branch: string; commits?: true; artifactDir?: string }

const PUSH_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const PROTECTED_BRANCH = /(^|\/)(master|main|head|trunk|develop|releases?|prod|production)([-._\/]|$)/i;
const PUSH_TIMEOUT_MS = 5000;

// ASCII feature branch names only; protected families and ref forms that could be options, refspecs, wildcards or tags are refused.
export function validatePushBranch(name: string): string {
	if (typeof name !== "string" || name.length < 1 || name.length > 100 || !PUSH_BRANCH.test(name)) throw new RangeError("branch must be an ASCII feature name");
	if (/\.\.|\/\/|\/\.|\.lock(\/|$)|[./]$/.test(name) || PROTECTED_BRANCH.test(name)) throw new RangeError("branch is malformed or protected");
	return name;
}

// Whole-command normal push forms only. Anything else (flags, refspecs, other remotes, compounds, quoting) is not a normal push.
export function parseNormalPush(command: string): { branch: string } | undefined {
	const match = /^git push (?:(?:-u|--set-upstream) )?origin (\S+)$/.exec(String(command));
	if (!match) return undefined;
	try {
		return { branch: validatePushBranch(match[1]) };
	} catch {
		return undefined;
	}
}

// Normal commit grammar (whole command, ASCII, single spaces): git commit -m "<safe message>" or git commit -F "<absolute path>". Anything else is not a normal commit.
const COMMIT_MESSAGE = /^(?:"([A-Za-z0-9 .,:_\/#()+-]{1,200})"|'([A-Za-z0-9 .,:_\/#()+-]{1,200})')$/;
const COMMIT_FILE = /^"([A-Za-z0-9 ._\/:-]+)"$/;
export function parseNormalCommit(command: string): { message?: string; file?: string } | undefined {
	const text = String(command ?? "");
	if (!/^[\x20-\x7e]+$/.test(text)) return undefined;
	const match = /^git commit (-m|-F) (.+)$/.exec(text);
	if (!match) return undefined;
	if (match[1] === "-m") {
		const m = COMMIT_MESSAGE.exec(match[2]);
		const message = m ? (m[1] ?? m[2]) : undefined;
		return message && /[A-Za-z0-9]/.test(message) ? { message } : undefined;
	}
	const f = COMMIT_FILE.exec(match[2]);
	return f && path.isAbsolute(f[1]) && !badSegments(f[1]) ? { file: f[1] } : undefined;
}

function assertPushUrl(url: string): void {
	if (typeof url !== "string" || !url) throw new TypeError("push URL missing");
	assertDisplayable(url);
	// Only standard public SSH forms (ssh://git@host/... and git@host:path) may carry a userinfo; every other credential-bearing form, token-only included, refuses.
	const credentialed = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url) || /^[^/:]*@/.test(url);
	if (credentialed && !/^(ssh:\/\/git@[^/?#@]+\/|git@[^/?#@:]+:)/i.test(url)) throw new RangeError("push URL with embedded credentials is not authorizable");
}

// Fixed argv, no shell. Unset config (exit 1) is an empty list; any other failure or timeout is undefined, which callers treat as refusal.
// Neutral cwd plus explicit -C: a bare git/gh run with the candidate as cwd can resolve a same-named binary from the candidate on Windows. PATH and global config stay trusted (documented, not an OS sandbox).
const NEUTRAL_EXEC_CWD = path.parse(os.homedir()).root;
function gitRead(cwd: string, args: string[]): string[] | undefined {
	try {
		return childProcess.execFileSync("git", ["-C", cwd, ...args], { cwd: NEUTRAL_EXEC_CWD, encoding: "utf8", timeout: PUSH_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
	} catch (error) {
		return args[0] === "config" && (error as { status?: number }).status === 1 ? [] : undefined;
	}
}

// Live binding: repo root is the candidate, exactly one push URL for origin, no mirror, push.followTags, custom receivepack or pushurl, and the branch resolves only to refs/heads/<branch> (not a same-named tag). Reasons are fixed strings: no URL, no raw git text.
// Exit status of a read-only git call: 0 found, 1 no such ref; undefined when git could not run or timed out.
function gitExit(cwd: string, args: string[]): number | undefined {
	try {
		childProcess.execFileSync("git", ["-C", cwd, ...args], { cwd: NEUTRAL_EXEC_CWD, timeout: PUSH_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
		return 0;
	} catch (error) {
		const status = (error as { status?: unknown }).status;
		return typeof status === "number" ? status : undefined;
	}
}

export type PushDiagnosis = { pushUrl: string } | { reason: string };
export function diagnosePushBranch(candidate: string, branch: string): PushDiagnosis {
	const top = gitRead(candidate, ["rev-parse", "--show-toplevel"]);
	if (top === undefined) return { reason: "git could not be read" };
	if (top.length !== 1 || foldPath(canonicalCwd(top[0])) !== foldPath(canonicalCwd(candidate))) return { reason: "not the repository root of the candidate" };
	const exists = gitExit(candidate, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (exists === 1) return { reason: "local branch is missing" };
	if (exists !== 0) return { reason: "git could not be read" };
	const ref = gitRead(candidate, ["rev-parse", "--symbolic-full-name", branch]);
	if (ref === undefined) return { reason: "git could not be read" };
	if (ref.length !== 1 || ref[0] !== `refs/heads/${branch}`) return { reason: "branch name is ambiguous (matches another ref)" };
	const urls = gitRead(candidate, ["remote", "get-url", "--push", "--all", "origin"]);
	const mirror = gitRead(candidate, ["config", "--type=bool", "--get-all", "remote.origin.mirror"]);
	const followTags = gitRead(candidate, ["config", "--type=bool", "--get-all", "push.followTags"]);
	const receive = gitRead(candidate, ["config", "--get-all", "remote.origin.receivepack"]);
	const pushurls = gitRead(candidate, ["config", "--get-all", "remote.origin.pushurl"]);
	// Effective submodule recursion (push.recurseSubmodules, and submodule.recurse) would push other repos: only unset or false is allowed.
	const recurse = gitRead(candidate, ["config", "--type=bool", "--get-all", "push.recurseSubmodules"]);
	const submodules = gitRead(candidate, ["config", "--type=bool", "--get-all", "submodule.recurse"]);
	if (!urls || !mirror || !followTags || !receive || !pushurls || !recurse || !submodules) return { reason: "git could not be read" };
	if (urls.length !== 1) return { reason: "origin remote is missing or has more than one push URL" };
	// An explicit remote.origin.pushurl is never part of the approved binding, even a single one (it replaces the fetch URL for pushes).
	if (mirror.includes("true") || followTags.includes("true") || recurse.includes("true") || submodules.includes("true") || receive.length || pushurls.length) return { reason: "origin push configuration is unsafe" };
	return { pushUrl: urls[0] };
}

export function livePushUrl(candidate: string, branch: string): string | undefined {
	const diagnosis = diagnosePushBranch(candidate, branch);
	return "pushUrl" in diagnosis ? diagnosis.pushUrl : undefined;
}

// Planner for a push or push+commit request: covered (no dialog) or ask (new confirm). Merge and release action grants never cover a push or commit.
export function planPushRequest(store: GrantStore, target: { candidate: string; pushUrl: string; branch: string }, request: { commits: boolean; artifactDir?: string }): { action: "covered" | "ask" } {
	const lease = store.findLease(target.candidate, target.branch, target.pushUrl);
	if (lease) return { action: !request.commits || (lease.commits === true && lease.artifactDir === request.artifactDir) ? "covered" : "ask" };
	return { action: "ask" };
}

// Owner/repo label from a parsed URL pathname or SCP-style path only; ambiguous origins stay neutral.
function repoLabel(origin: string): string {
	let pathname: string;
	if (/^[^/@:\s]+@[^/:\s]+:.+/.test(origin)) {
		pathname = origin.slice(origin.indexOf(":") + 1);
		if (/[?#]/.test(pathname)) return "repo not shown";
	}
	else {
		try {
			const url = new URL(origin);
			if (!url.protocol || !url.hostname) return "repo not shown";
			pathname = url.pathname;
		} catch {
			return "repo not shown";
		}
	}
	const match = /^\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(pathname);
	return match ? `${match[1]}/${match[2]}` : "repo not shown";
}

function validityOf(candidate: string, branch: string, pushUrl: string): string {
	const diagnosis = diagnosePushBranch(candidate, branch);
	if ("pushUrl" in diagnosis && diagnosis.pushUrl === pushUrl) return "valid";
	return `invalid: ${"reason" in diagnosis ? diagnosis.reason : "live origin URL differs from the approved one"}`;
}

// Read-only, secret-free session status for /authorization: counts, scopes, expiry and bounded validity reasons. No command text, digests, ids, bearer values, URLs or raw git/gh error text.
export function authorizationStatus(store: GrantStore, now: number): string {
	const grants = store.summary(now);
	const next = grants.nextExpiry === undefined ? "" : `; next expiry ${new Date(grants.nextExpiry).toISOString()}`;
	const lines = [`single-use grants: ${grants.count} live (main ${grants.main}, child roles ${grants.roleBound}; shell ${grants.shell}, write ${grants.write}, read ${grants.read}${next})`];
	const leases = store.listLeases();
	lines.push(leases.length ? `push leases: ${leases.length} (session only, no expiry)` : "push leases: none");
	for (const lease of leases) lines.push(`- ${lease.commits ? "push+commit" : "push"}: repo ${repoLabel(lease.pushUrl)}, branch ${lease.branch}, candidate ${lease.candidate}, artifact dir ${lease.artifactDir ?? "none"}, ${validityOf(lease.candidate, lease.branch, lease.pushUrl)}`);
	const deliveries = store.listDelivery();
	lines.push(deliveries.length ? `merge/release grants: ${deliveries.length} (approved scope, session only)` : "merge/release grants: none");
	for (const d of deliveries) lines.push(`- ${d.action}: repo ${d.repo}, branch ${d.branch}, base ${d.base}, PR ${d.pr}, SHA ${d.sha.slice(0, 7)}${d.action === "release" ? `, version ${d.version}, latest ${d.latest ? "yes" : "no"}` : ""}, artifact dir ${d.artifactDir ?? "none"}, ${validityOf(d.candidate, d.branch, d.pushUrl)}${d.bound ? `, fp ${d.bound.fingerprint.slice(0, 12)}, excl ${d.bound.exclude.length} (not rechecked in status)` : ""}`);
	return lines.join("\n");
}

// Trusted-main lease target: canonical candidate, live push URL and validated branch; undefined when the folder is not a verified repo.
export function pushBranchTarget(cwd: string, branch: string): { candidate: string; pushUrl: string; branch: string } | undefined {
	if (!path.isAbsolute(cwd)) throw new TypeError("push target cwd must be absolute");
	validatePushBranch(branch);
	const candidate = canonicalCwd(cwd);
	assertDisplayable(candidate);
	const pushUrl = livePushUrl(candidate, branch);
	if (pushUrl === undefined) return undefined;
	assertPushUrl(pushUrl);
	return { candidate, pushUrl, branch };
}

function sameLease(a: PushLease, b: PushLease): boolean {
	return foldPath(a.candidate) === foldPath(b.candidate) && a.branch === b.branch && a.pushUrl === b.pushUrl;
}

function validateLease(value: unknown): PushLease {
	const l = value as PushLease;
	if (!l || typeof l !== "object" || l.role !== LEASE_ROLE || typeof l.candidate !== "string" || !path.isAbsolute(l.candidate)) throw new TypeError("invalid push lease");
	assertPushUrl(l.pushUrl);
	const branch = validatePushBranch(l.branch);
	if (l.commits !== undefined && l.commits !== true) throw new TypeError("invalid lease commit flag");
	if (l.artifactDir !== undefined && (l.commits !== true || typeof l.artifactDir !== "string")) throw new TypeError("artifact directory needs a commit lease");
	const artifactDir = l.artifactDir === undefined ? undefined : validateArtifactDir(l.artifactDir, l.candidate);
	return { role: LEASE_ROLE, candidate: l.candidate, pushUrl: l.pushUrl, branch, ...(l.commits ? { commits: true as const } : {}), ...(artifactDir ? { artifactDir } : {}) };
}

export function loadChildLeases(text: string): PushLease[] {
	const parsed = JSON.parse(text) as { v?: number; leases?: unknown };
	if (!parsed || parsed.v !== 1) throw new TypeError("invalid grant envelope");
	if (parsed.leases === undefined) return [];
	if (!Array.isArray(parsed.leases)) throw new TypeError("invalid lease list");
	return parsed.leases.map((l) => validateLease(l));
}

// Release delivery (human-approved, reusable for the current PI session, like a push lease: no time expiry). Bound to candidate, origin push URL, repo, branch and base; release-engineer children only; non-consuming. Cleared by explicit revoke or session shutdown; abort keeps it.
// Commit gate flag in the child envelope: only the trusted release-engineer launch sends true. Absent means ungated; any other value fails closed.
export function loadChildGate(text: string): boolean {
	const parsed = JSON.parse(text) as { v?: number; gateCommits?: unknown };
	if (!parsed || parsed.v !== 1) throw new TypeError("invalid grant envelope");
	if (parsed.gateCommits === undefined) return false;
	if (parsed.gateCommits !== true) throw new TypeError("invalid commit gate flag");
	return true;
}

export function loadChildPushTarget(text: string): PushTarget | undefined {
	if (redirectedGitEnvironment()) return undefined;
	const parsed = JSON.parse(text) as { v?: number; pushTarget?: unknown; pushTargetBound?: unknown };
	if (!parsed || parsed.v !== 1) throw new TypeError("invalid grant envelope");
	// Both keys together are ambiguous (a bound context must never coexist with a legacy one); either alone is the whole context.
	if (parsed.pushTarget !== undefined && parsed.pushTargetBound !== undefined) throw new TypeError("ambiguous push target");
	const bound = parsed.pushTargetBound !== undefined;
	const raw = bound ? parsed.pushTargetBound : parsed.pushTarget;
	if (raw === undefined) return undefined;
	const value = raw as Record<string, unknown>;
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.candidate !== "string" || !path.isAbsolute(value.candidate) || typeof value.pushUrl !== "string") throw new TypeError("invalid push target");
	// The legacy key never carries a base and the bound key always does (exact key set): a stripped, extra or mistyped field is refused, not normalized away.
	const keys = Object.keys(value).sort().join(",");
	if (keys !== (bound ? "base,branch,candidate,pushUrl" : "branch,candidate,pushUrl")) throw new TypeError("invalid push target");
	if (bound && (!baseBranchOk(value.base) || value.base === value.branch)) throw new TypeError("invalid push target base");
	const target = pushBranchTarget(value.candidate, String(value.branch));
	if (!target || target.pushUrl !== value.pushUrl) throw new TypeError("invalid push target");
	return bound ? { ...target, base: value.base as string } : target;
}

export const MAX_DELIVERY_GRANTS = 4;
const GH_TIMEOUT_MS = 15_000;
const DELIVERY_FILE_MAX = 65_536;
const PLACEMENT = /^(?:[A-Za-z]:)?\/(?:.+\/)?worktrees\/[^/]+\/_(?:scratch|evidence)\/[^/]+(?:\/.+)?$/;
const PATH_ARG = /^(?:[A-Za-z]:)?\/[A-Za-z0-9 _.,+()#\/-]+$/;
const TEXT_ARG = /^[A-Za-z0-9 .,_\/#()+-]+$/;
const BARE_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BARE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const BARE_NUM = /^[1-9][0-9]{0,8}$/;
const BARE_SHA = /^[0-9a-f]{40}$/;
const BARE_VERSION = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TEXT_LIMIT = { title: 120, subject: 120, body: 500 } as const;

// Fingerprint binding (mandatory for a merge grant): HEAD attached to ref, the candidate fingerprint and the exclusions it was computed with.
export interface BoundState { head: string; ref: string; fingerprint: string; exclude: string[] }
// Separate approvals, one action each. merge: PR + reviewed HEAD sha + mandatory bound (bound.head === sha). release: PR + version + target sha (the merge commit), never bound. Push, PR create and PR edit are automatic and no grant carries them.
export type DeliveryAction = "merge" | "release";
export interface DeliveryBinding { role: string; candidate: string; pushUrl: string; repo: string; branch: string; base: string; action: DeliveryAction; pr: number; sha: string; version?: string; latest?: boolean; artifactDir?: string; bound?: BoundState }
export interface DeliveryGrant extends DeliveryBinding { issuedAt: number }
// Live readers, injectable for offline tests. Production uses the real git/gh calls below.
export interface DeliveryLive { bound?(candidate: string, exclude: string[]): BoundState; env(): Record<string, string | undefined>; pushUrl(candidate: string, branch: string): string | undefined; ghJson(args: string[]): unknown; tagStatus(pushUrl: string, tag: string): number }

// A record whose artifact directory vanished stays stored but is not copied to a child (the envelope would otherwise fail closed as a whole).
function artifactStillLive(d: DeliveryGrant): boolean {
	if (d.artifactDir === undefined) return true;
	try { validateArtifactDir(d.artifactDir, d.candidate); return true; } catch { return false; }
}

function normPath(p: string): string {
	return foldPath(p.replace(/\\/g, "/"));
}

// github.com origin forms only (https, scp-style ssh, ssh://git@). Credentials, other hosts, extra segments and dot-names refuse.
export function parseRepoFromPushUrl(url: unknown): string | undefined {
	const m = typeof url === "string" ? /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([^/]+?)(?:\.git)?$/.exec(url) : null;
	if (!m || !/^[A-Za-z0-9._-]{1,100}$/.test(m[2]) || m[2].startsWith(".") || m[2].endsWith(".")) return undefined;
	return `${m[1]}/${m[2]}`;
}

function baseBranchOk(name: unknown): name is string {
	return typeof name === "string" && BARE_BRANCH.test(name) && !/\.\.|\/\/|[./]$|\/\.|\.lock(\/|$)/.test(name);
}

// Pre-launch check of a supplied PR base against the candidate's live feature branch (the claim re-checks it): valid branch name, not the feature branch itself. Throws RangeError.
export function checkPrBase(base: unknown, cwd: string): string {
	if (!baseBranchOk(base)) throw new RangeError("prBase must be a valid branch name");
	const live = redirectedGitEnvironment() ? undefined : gitRead(canonicalCwd(cwd), ["symbolic-ref", "--short", "HEAD"])?.[0];
	if (!live || live === base) throw new RangeError("prBase needs a verifiable feature branch different from it");
	return base;
}

// Segments after the drive: no empty, dot, dot-dot, or trailing dot/space segment.
function badSegments(p: string): boolean {
	return p.replace(/^[A-Za-z]:/, "").split("/").slice(1).some((seg) => seg === "" || seg === "." || seg === ".." || /[. ]$/.test(seg));
}

// Trusted artifact directory: ASCII absolute forward-slash placement under <worktrees>/<repo>/_scratch|_evidence/<task>, existing, canonical (no alias/link), and not overlapping the candidate.
export function validateArtifactDir(input: string, candidate: string): string {
	// shortcut: any ~<digit> segment refuses as a possible 8.3 alias (may over-block a literal ~1 name), upgrade to native alias resolution when realpath can settle it.
	if (typeof input === "string" && input.split("/").some((seg) => /~\d/.test(seg))) throw new RangeError("artifact directory is an alias or link (8.3 short name)");
	if (typeof input !== "string" || !/^[\x20-\x7e]+$/.test(input) || input.includes("\\") || !PLACEMENT.test(input) || badSegments(input)) throw new RangeError("artifact directory must be an ASCII absolute forward-slash path under worktrees/<repo>/_scratch or _evidence");
	let stat: fs.Stats;
	try { stat = fs.statSync(input); } catch { throw new RangeError("artifact directory does not exist"); }
	if (!stat.isDirectory()) throw new RangeError("artifact directory is not a directory");
	if (normPath(fs.realpathSync.native(input)) !== normPath(input)) throw new RangeError("artifact directory is an alias or link");
	const cand = normPath(canonicalCwd(candidate));
	const dir = normPath(input);
	if (dir === cand || dir.startsWith(`${cand}/`) || cand.startsWith(`${dir}/`)) throw new RangeError("artifact directory overlaps the candidate");
	return input;
}

// One file per use, read by gh from the approved directory. Returns the violated rule name only, or undefined when the file is allowed.
export function checkArtifactFile(file: string, artifactDir: string): string | undefined {
	if (typeof file !== "string" || !PATH_ARG.test(file) || badSegments(file)) return "path";
	if (!normPath(file).startsWith(`${normPath(artifactDir)}/`)) return "outside the approved artifact directory";
	if (!/\.(md|txt)$/i.test(file)) return "extension";
	let stat: fs.Stats;
	try { stat = fs.lstatSync(file); } catch { return "missing"; }
	if (!stat.isFile()) return "not a regular file";
	if (stat.nlink !== 1) return "hard link";
	if (stat.size < 1 || stat.size > DELIVERY_FILE_MAX) return "size";
	if (normPath(fs.realpathSync.native(file)) !== normPath(file)) return "alias or link escape";
	const bytes = fs.readFileSync(file);
	if (bytes.length < 1 || bytes.length > DELIVERY_FILE_MAX) return "size";
	if (bytes.includes(0)) return "NUL byte";
	if (CREDENTIAL_TEXT.test(bytes.toString("utf8"))) return "credential-like text";
	return undefined;
}

function normalizeBinding(input: unknown): DeliveryBinding {
	const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (b.role !== LEASE_ROLE) throw new RangeError("delivery is for release-engineer children only");
	if (typeof b.candidate !== "string" || !path.isAbsolute(b.candidate)) throw new TypeError("candidate must be absolute");
	const candidate = canonicalCwd(b.candidate);
	assertPushUrl(b.pushUrl as string);
	const repo = parseRepoFromPushUrl(b.pushUrl);
	if (repo === undefined || b.repo !== repo) throw new RangeError("repo must derive from the github.com origin push URL");
	const branch = validatePushBranch(b.branch as string);
	if (!baseBranchOk(b.base) || b.base === branch) throw new RangeError("base must be a branch name different from the feature branch");
	// Legacy combined or unbound shapes (no action, or PR/SHA missing) are refused outright: there is no compatibility path for merge or release.
	if (b.action !== "merge" && b.action !== "release") throw new RangeError("delivery action must be merge or release (legacy combined delivery grants are not accepted)");
	if (typeof b.pr !== "number" || !Number.isSafeInteger(b.pr) || b.pr < 1 || b.pr > 999999999) throw new RangeError("PR number is required");
	if (typeof b.sha !== "string" || !BARE_SHA.test(b.sha)) throw new RangeError("a 40-hex SHA is required");
	const out: DeliveryBinding = { role: LEASE_ROLE, candidate, pushUrl: b.pushUrl as string, repo, branch, base: b.base, action: b.action, pr: b.pr, sha: b.sha };
	if (b.action === "merge") {
		if (b.version !== undefined || b.latest !== undefined) throw new RangeError("a merge grant carries no release fields");
		if (b.bound === undefined) throw new RangeError("a merge grant needs the verified candidate fingerprint binding");
		out.bound = normalizeBound(b.bound, branch);
		if (out.bound.head !== out.sha) throw new RangeError("merge SHA must equal the bound candidate HEAD");
	} else {
		if (typeof b.version !== "string" || !BARE_VERSION.test(b.version)) throw new RangeError("version must be a release tag such as v1.2.3");
		out.version = b.version;
		if (b.latest !== undefined && b.latest !== false) {
			if (b.latest !== true) throw new RangeError("latest must be a boolean");
			out.latest = true;
		}
		if (b.bound !== undefined) throw new RangeError("a release grant is not fingerprint-bound");
	}
	if (b.artifactDir !== undefined) out.artifactDir = validateArtifactDir(b.artifactDir as string, candidate);
	return out;
}

// Strict bound shape: exactly head, ref, fingerprint, exclude; the ref must be the approved branch and the exclusions already normalized. Frozen so copies cannot mutate a stored record.
function normalizeBound(input: unknown, branch: string): BoundState {
	const v = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
	if (Object.keys(v).sort().join() !== "exclude,fingerprint,head,ref") throw new TypeError("invalid bound state");
	if (typeof v.head !== "string" || !BARE_SHA.test(v.head) || typeof v.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(v.fingerprint) || v.ref !== `refs/heads/${branch}`) throw new TypeError("invalid bound state");
	const exclude = validateExclude(v.exclude);
	if (exclude.join("\n") !== (v.exclude as string[]).join("\n")) throw new TypeError("invalid bound state");
	return Object.freeze({ head: v.head, ref: v.ref, fingerprint: v.fingerprint, exclude: Object.freeze(exclude) as string[] });
}

// An old 30-minute record (expiresAt or TTL present) is refused, never reread as forever; the feature was not activated, so no such record exists in practice.
function validateDelivery(value: unknown): DeliveryGrant {
	const d = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	if ("expiresAt" in d || "ttl" in d || "ttlMs" in d) throw new RangeError("delivery records are session-scoped; expiresAt or TTL is unsupported");
	const binding = normalizeBinding(value);
	if (typeof d.issuedAt !== "number" || !Number.isFinite(d.issuedAt)) throw new RangeError("delivery issuedAt must be a finite session time");
	return { ...binding, issuedAt: d.issuedAt };
}

function sameBound(a?: BoundState, b?: BoundState): boolean {
	return a === undefined ? b === undefined : b !== undefined && a.head === b.head && a.ref === b.ref && a.fingerprint === b.fingerprint && a.exclude.join("\n") === b.exclude.join("\n");
}

function sameBinding(a: DeliveryBinding, b: DeliveryBinding): boolean {
	return sameScope(a, b) && sameBound(a.bound, b.bound);
}

// Scope: everything except the bound state.
export function sameScope(a: DeliveryBinding, b: DeliveryBinding): boolean {
	return normPath(a.candidate) === normPath(b.candidate) && a.pushUrl === b.pushUrl && a.repo === b.repo && a.branch === b.branch && a.base === b.base && a.action === b.action && a.pr === b.pr && a.sha === b.sha && a.version === b.version && a.latest === b.latest && (a.artifactDir === undefined ? b.artifactDir === undefined : b.artifactDir !== undefined && normPath(a.artifactDir) === normPath(b.artifactDir));
}

export function loadChildDelivery(text: string): DeliveryGrant[] {
	const parsed = JSON.parse(text) as { v?: number; delivery?: unknown; deliveryBound?: unknown; deliveryActions?: unknown };
	if (!parsed || parsed.v !== 1) throw new TypeError("invalid grant envelope");
	// Legacy combined delivery keys are never honored: fail closed rather than reinterpret them.
	if (parsed.delivery !== undefined || parsed.deliveryBound !== undefined) throw new TypeError("legacy delivery grants are not supported");
	if (parsed.deliveryActions !== undefined && !Array.isArray(parsed.deliveryActions)) throw new TypeError("invalid delivery list");
	return (parsed.deliveryActions ?? []).map((d: unknown) => validateDelivery(d));
}

// Live candidate state for a bound grant. Fail closed: redirected git environment, a non-root candidate, a detached HEAD, UNSUPPORTED entries, limits or any git error throw.
export function readBoundState(candidate: string, exclude: string[]): BoundState {
	if (redirectedGitEnvironment()) throw new Error("git environment is redirected");
	const top = gitRead(candidate, ["rev-parse", "--show-toplevel"]);
	if (top?.length !== 1 || foldPath(canonicalCwd(top[0])) !== foldPath(canonicalCwd(candidate))) throw new Error("not the repository root of the candidate");
	const ref = gitRead(candidate, ["symbolic-ref", "-q", "HEAD"]);
	if (ref?.length !== 1) throw new Error("HEAD is not attached to a branch");
	const f = candidateFingerprint(candidate, exclude);
	if (f.unsupported.length > 0) throw new Error("candidate has unsupported entries");
	return { head: f.head, ref: ref[0], fingerprint: f.value, exclude: [...exclude] };
}

// Mint-time binding: the branch must be checked out (what a push sends is then the bound commit); optional expect ties the grant to a fingerprint the operator already verified.
export function bindDelivery(candidate: string, branch: string, opts: { exclude?: unknown; expect?: unknown } = {}): BoundState {
	const exclude = validateExclude(opts.exclude ?? []);
	if (opts.expect !== undefined && !(typeof opts.expect === "string" && /^[0-9a-f]{64}$/.test(opts.expect))) throw new RangeError("expect must be a 64-hex fingerprint");
	assertExcludeUntracked(candidate, exclude);
	const state = readBoundState(candidate, exclude);
	if (state.ref !== `refs/heads/${branch}`) throw new RangeError("branch is not checked out (HEAD must be attached to it)");
	if (opts.expect !== undefined && opts.expect !== state.fingerprint) throw new RangeError("live candidate differs from the expected fingerprint");
	return state;
}

interface Tok { text: string; quoted: string }

// Single spaces between tokens, ASCII only; a token is double-quoted, single-quoted or bare (no spaces or quotes). Any other shape is not a delivery command.
function tokenizeDelivery(command: string): Tok[] | undefined {
	if (typeof command !== "string" || /[^\x20-\x7e]/.test(command)) return undefined;
	const re = /"([^"]*)"|'([^']*)'|([^ "']+)/y;
	const out: Tok[] = [];
	let i = 0;
	while (i < command.length) {
		re.lastIndex = i;
		const m = re.exec(command);
		if (!m) return undefined;
		out.push(m[1] !== undefined ? { text: m[1], quoted: '"' } : m[2] !== undefined ? { text: m[2], quoted: "'" } : { text: m[3], quoted: "" });
		i = re.lastIndex;
		if (i < command.length) {
			if (command[i] !== " ") return undefined;
			i++;
			if (i >= command.length) return undefined;
		}
	}
	return out;
}

type ArgKind = "none" | "repo" | "branch" | "sha" | "path" | "title" | "subject" | "body";

function textValue(tok: Tok, max: number): string | undefined {
	if (tok.quoted === "" || tok.text.length < 1 || tok.text.length > max || !TEXT_ARG.test(tok.text) || CREDENTIAL_TEXT.test(tok.text)) return undefined;
	return tok.text;
}

function argValue(kind: Exclude<ArgKind, "none">, tok: Tok): string | undefined {
	switch (kind) {
		case "repo": return tok.quoted === "" && BARE_REPO.test(tok.text) ? tok.text : undefined;
		case "branch": return tok.quoted === "" && baseBranchOk(tok.text) ? tok.text : undefined;
		case "sha": return tok.quoted === "" && BARE_SHA.test(tok.text) ? tok.text : undefined;
		case "path": return tok.quoted === '"' && tok.text.length <= 240 && PATH_ARG.test(tok.text) ? tok.text : undefined;
		default: return textValue(tok, TEXT_LIMIT[kind]);
	}
}

// Each flag at most once, only flags in spec, values typed by kind; order is free.
function readOptions(tokens: Tok[], spec: Record<string, ArgKind>): Record<string, string | true> | undefined {
	const out: Record<string, string | true> = {};
	for (let i = 0; i < tokens.length; i++) {
		const flag = tokens[i];
		if (flag.quoted !== "" || !Object.hasOwn(spec, flag.text) || Object.hasOwn(out, flag.text)) return undefined;
		const kind = spec[flag.text];
		if (kind === "none") {
			out[flag.text] = true;
			continue;
		}
		const value = tokens[++i];
		const parsed = value ? argValue(kind, value) : undefined;
		if (parsed === undefined) return undefined;
		out[flag.text] = parsed;
	}
	return out;
}

export type DeliveryCommand =
	| { kind: "create"; repo: string; base: string; head: string; title: string; body?: string; bodyFile?: string }
	| { kind: "edit"; pr: number; repo: string; title?: string; body?: string; bodyFile?: string }
	| { kind: "merge"; pr: number; repo: string; sha: string; subject?: string; body?: string; bodyFile?: string }
	| { kind: "release"; tag: string; repo: string; target: string; title: string; notes?: string; notesFile?: string; generate: boolean; latest: boolean };

// Exactly the five approved gh forms (PR create/edit/merge, release create); anything else, including compounds, returns undefined.
export function parseDeliveryCommand(command: string): DeliveryCommand | undefined {
	const t = tokenizeDelivery(command);
	if (!t) return undefined;
	const w = (i: number) => (t[i] && t[i].quoted === "" ? t[i].text : undefined);
	const s = (o: Record<string, string | true>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
	if (w(0) !== "gh") return undefined;
	if (w(1) === "pr" && w(2) === "create") {
		const o = readOptions(t.slice(3), { "--repo": "repo", "--base": "branch", "--head": "branch", "--title": "title", "--body": "body", "--body-file": "path" });
		if (!o) return undefined;
		const repo = s(o, "--repo"), base = s(o, "--base"), head = s(o, "--head"), title = s(o, "--title"), body = s(o, "--body"), bodyFile = s(o, "--body-file");
		if (!repo || !base || !head || !title || (body === undefined) === (bodyFile === undefined)) return undefined;
		return { kind: "create", repo, base, head, title, body, bodyFile };
	}
	if (w(1) === "pr" && (w(2) === "edit" || w(2) === "merge")) {
		const num = w(3);
		if (!num || !BARE_NUM.test(num)) return undefined;
		if (w(2) === "edit") {
			const o = readOptions(t.slice(4), { "--repo": "repo", "--title": "title", "--body": "body", "--body-file": "path" });
			if (!o) return undefined;
			const repo = s(o, "--repo"), title = s(o, "--title"), body = s(o, "--body"), bodyFile = s(o, "--body-file");
			if (!repo || (title === undefined && body === undefined && bodyFile === undefined) || (body !== undefined && bodyFile !== undefined)) return undefined;
			return { kind: "edit", pr: Number(num), repo, title, body, bodyFile };
		}
		const o = readOptions(t.slice(4), { "--repo": "repo", "--squash": "none", "--match-head-commit": "sha", "--subject": "subject", "--body": "body", "--body-file": "path" });
		if (!o) return undefined;
		const repo = s(o, "--repo"), sha = s(o, "--match-head-commit"), subject = s(o, "--subject"), body = s(o, "--body"), bodyFile = s(o, "--body-file");
		if (!repo || !sha || o["--squash"] !== true || (body !== undefined && bodyFile !== undefined)) return undefined;
		return { kind: "merge", pr: Number(num), repo, sha, subject, body, bodyFile };
	}
	if (w(1) === "release" && w(2) === "create") {
		const tag = w(3);
		if (!tag || !BARE_VERSION.test(tag)) return undefined;
		const o = readOptions(t.slice(4), { "--repo": "repo", "--target": "sha", "--title": "title", "--notes": "body", "--notes-file": "path", "--generate-notes": "none", "--latest": "none" });
		if (!o) return undefined;
		const repo = s(o, "--repo"), target = s(o, "--target"), title = s(o, "--title"), notes = s(o, "--notes"), notesFile = s(o, "--notes-file"), generate = o["--generate-notes"] === true;
		if (!repo || !target || !title || [notes !== undefined, notesFile !== undefined, generate].filter(Boolean).length !== 1) return undefined;
		return { kind: "release", tag, repo, target, title, notes, notesFile, generate, latest: o["--latest"] === true };
	}
	return undefined;
}

function prView(pr: number, repo: string, live: DeliveryLive): Record<string, unknown> | undefined {
	const view = live.ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "state,baseRefName,headRefName,headRefOid,isCrossRepository"]);
	return view && typeof view === "object" ? (view as Record<string, unknown>) : undefined;
}

// Structural ownership: open, same-repo (strictly isCrossRepository === false; missing or null refuses) and head is the expected feature branch. The base is checked by the caller.
function openSameRepo(view: Record<string, unknown> | undefined, branch: string): view is Record<string, unknown> {
	return view !== undefined && view.state === "OPEN" && view.headRefName === branch && view.isCrossRepository === false;
}

// A merge grant is always bound: the live candidate must equal the approved HEAD, branch and fingerprint. Any throw refuses.
function boundHolds(g: DeliveryGrant, live: DeliveryLive): boolean {
	const b = g.bound;
	if (!b || b.head !== g.sha) return false;
	try {
		const now = (live.bound ?? readBoundState)(g.candidate, [...b.exclude]);
		return now.ref === b.ref && now.head === b.head && now.fingerprint === b.fingerprint;
	} catch {
		return false;
	}
}

// The approved PR fetched by exact number from the grant's repo: merged, same-repo, approved head/base and merge commit. No list, history or time fallback; any other answer is false.
const MERGED_VIEW_FIELDS = "number,state,baseRefName,headRefName,isCrossRepository,mergeCommit";
function mergedMatches(g: { repo: string; branch: string; base: string; pr: number }, target: string, live: DeliveryLive): boolean {
	const v = live.ghJson(["pr", "view", String(g.pr), "--repo", g.repo, "--json", MERGED_VIEW_FIELDS]);
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const pr = v as Record<string, any>;
	return pr.number === g.pr && pr.state === "MERGED" && pr.isCrossRepository === false && pr.headRefName === g.branch && pr.baseRefName === g.base && typeof pr.mergeCommit?.oid === "string" && BARE_SHA.test(target) && pr.mergeCommit.oid === target;
}

// One grant against one command. The grant's action must equal the command's kind; any mismatch or read problem is false (refusal).
function matchDelivery(g: DeliveryGrant, c: DeliveryCommand | undefined, live: DeliveryLive): boolean {
	if (live.pushUrl(g.candidate, g.branch) !== g.pushUrl) return false;
	if (!c || c.repo !== g.repo || c.kind !== g.action) return false;
	const fileOk = (file?: string) => file === undefined || (g.artifactDir !== undefined && checkArtifactFile(file, g.artifactDir) === undefined);
	switch (c.kind) {
		case "merge": {
			if (c.pr !== g.pr || c.sha !== g.sha || !fileOk(c.bodyFile)) return false;
			const view = prView(c.pr, g.repo, live);
			return openSameRepo(view, g.branch) && view.baseRefName === g.base && view.headRefOid === c.sha && boundHolds(g, live);
		}
		case "release": {
			// A tag that already exists (status 0) or an unreadable remote refuses: --target is never trusted on an existing tag. No time-based fallback.
			if (g.version !== c.tag || c.target !== g.sha || (c.latest && g.latest !== true) || !fileOk(c.notesFile)) return false;
			if (live.tagStatus(g.pushUrl, c.tag) !== 2) return false;
			return mergedMatches(g, c.target, live);
		}
		default:
			return false;
	}
}

// Mint-time live verification of an action grant (the operator confirms only facts the guard will also check). Returns a refusal reason or undefined.
export function verifyDeliveryTarget(g: DeliveryBinding, live: DeliveryLive = defaultDeliveryLive(livePushUrl)): string | undefined {
	try {
		if (g.action === "merge") {
			const view = prView(g.pr, g.repo, live);
			if (!openSameRepo(view, g.branch) || view.baseRefName !== g.base) return "PR is not open, same-repo, on this branch and base";
			return view.headRefOid === g.sha ? undefined : "PR head does not equal the approved SHA";
		}
		if (live.tagStatus(g.pushUrl, g.version as string) !== 2) return "release tag already exists or cannot be checked";
		return mergedMatches(g, g.sha, live) ? undefined : "approved PR is not merged with the approved target SHA";
	} catch {
		return "live GitHub state could not be read";
	}
}

function defaultDeliveryLive(liveUrl: (candidate: string, branch: string) => string | undefined): DeliveryLive {
	return {
		env: () => process.env,
		pushUrl: liveUrl,
		ghJson: (args) => JSON.parse(childProcess.execFileSync("gh", args, { cwd: NEUTRAL_EXEC_CWD, encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } })),
		tagStatus: (pushUrl, tag) => {
			const run = childProcess.spawnSync("git", ["ls-remote", "--exit-code", "--tags", pushUrl, `refs/tags/${tag}`], { cwd: NEUTRAL_EXEC_CWD, encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
			return run.error || run.signal || run.status === null ? -1 : run.status;
		},
	};
}

// Child release-engineer merge/release: exact gh form, only GIT_PUBLISH, no GH_HOST/GH_REPO. Non-consuming; each grant re-checked live. Push, PR create and PR edit are never matched here.
function deliveryAllows(store: GrantStore, decision: Extract<Decision, { action: "block" }>, live: DeliveryLive): boolean {
	if (decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_PUBLISH") return false;
	const cmd = parseDeliveryCommand(decision.op.command);
	if (!cmd || (cmd.kind !== "merge" && cmd.kind !== "release")) return false;
	try {
		const env = live.env();
		if (env.GH_HOST !== undefined || env.GH_REPO !== undefined) return false;
		for (const grant of store.copyDelivery(decision.op.cwd)) {
			try { if (matchDelivery(grant, cmd, live)) return true; } catch { /* a read problem refuses this grant only */ }
		}
	} catch {
		return false;
	}
	return false;
}

export interface ChildGuardLaunch {
	entry: string;
	grantCount: number;
	leaseCount: number;
	deliveryCount: number;
	gateCommits: boolean;
	childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

// One logical child job's claim window. Its first actual spawn closes the window, even when no grant exists or the spawn fails; fallback spawns of that job never claim.
export interface ClaimWindow { open: boolean }

// Claims this role's grants for one child spawn (single use) and returns the guard entry plus the child's environment.
export function claimChildGuard(store: GrantStore, role: string, candidate: string, guardFile: string, window: ClaimWindow = { open: true }, withLeases = false, prBase?: string): ChildGuardLaunch {
	if (!fs.existsSync(guardFile)) throw new Error("Safety guard missing: child launch refused (fail closed).");
	// A supplied PR base narrows the trusted release-engineer context only. Refuse before any grant is claimed or the window closes.
	if (prBase !== undefined && (!(withLeases && role === LEASE_ROLE) || !baseBranchOk(prBase))) throw new RangeError("prBase needs a trusted release-engineer launch and a valid branch name");
	// Lease copies are non-consuming: every legitimate release-engineer spawn of this candidate gets them, including fallback and later spawns.
	const leases = withLeases && role === LEASE_ROLE ? store.copyLeases(canonicalCwd(candidate)) : [];
	// Delivery copies follow the lease rule: non-consuming, release-engineer only, same absolute expiry for every spawn of this candidate.
	const delivery = withLeases && role === LEASE_ROLE ? store.copyDelivery(canonicalCwd(candidate)) : [];
	// Normal commits are gated only in the trusted release-engineer launch (same trust signal as the lease copies).
	const gateCommits = withLeases && role === LEASE_ROLE;
	let pushTarget: PushTarget | undefined;
	if (gateCommits && !redirectedGitEnvironment()) {
		try { const branch = gitRead(canonicalCwd(candidate), ["symbolic-ref", "--short", "HEAD"])?.[0]; if (branch) pushTarget = pushBranchTarget(canonicalCwd(candidate), branch); } catch { /* no automatic push context */ }
	}
	if (prBase !== undefined) {
		// Known base never degrades to legacy: no verified target or a base equal to the feature branch refuses the launch.
		if (!pushTarget || pushTarget.branch === prBase) throw new RangeError("prBase needs a verified push target different from the base");
		pushTarget = { ...pushTarget, base: prBase };
	}
	// Every refusal above precedes the claim: a refused launch neither closes the window nor consumes a single-use grant.
	const mayClaim = window.open;
	window.open = false;
	const claimed = mayClaim ? store.claim(role, canonicalCwd(candidate)) : [];
	const value = claimed.length || leases.length || delivery.length || gateCommits ? serializeGrants(claimed, leases, delivery, gateCommits, pushTarget) : undefined;
	return {
		entry: guardFile,
		grantCount: claimed.length,
		leaseCount: leases.length,
		deliveryCount: delivery.length,
		gateCommits,
		childEnv(base) {
			const env: NodeJS.ProcessEnv = { ...base };
			delete env[CHILD_GRANT_ENV];
			if (value !== undefined) env[CHILD_GRANT_ENV] = value;
			return env;
		},
	};
}

export interface GuardBlock { block: true; reason: string }

// Git state that makes a plain commit a different operation (merge, cherry-pick, revert, rebase, sequencer) and env that redirects repository, index, objects, namespace or config.
const UNSAFE_GIT_STATE = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
const REDIRECT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];

function redirectedGitEnvironment(): boolean {
	return Object.keys(process.env).some((name) => REDIRECT_ENV.some((key) => key.toLowerCase() === name.toLowerCase()) || /^GIT_CONFIG_(?:KEY|VALUE)_/i.test(name) || /^(?:GH_HOST|GH_REPO)$/i.test(name));
}

function commitTargetLive(target: { candidate: string; pushUrl: string; branch: string }, root: string, liveUrl: (candidate: string, branch: string) => string | undefined): string | undefined {
	if (foldPath(canonicalCwd(root)) !== foldPath(target.candidate) || redirectedGitEnvironment()) return undefined;
	const top = gitRead(root, ["rev-parse", "--show-toplevel"]);
	if (top?.length !== 1 || foldPath(canonicalCwd(top[0])) !== foldPath(root)) return undefined;
	const head = gitRead(root, ["symbolic-ref", "-q", "HEAD"]);
	if (head?.length !== 1 || !head[0].startsWith("refs/heads/")) return undefined;
	const branch = validatePushBranch(head[0].slice("refs/heads/".length));
	if (branch !== target.branch || liveUrl(root, branch) !== target.pushUrl) return undefined;
	const gitDir = gitRead(root, ["rev-parse", "--absolute-git-dir"]);
	if (gitDir?.length !== 1 || UNSAFE_GIT_STATE.some((s) => fs.existsSync(path.join(gitDir[0], s)))) return undefined;
	return branch;
}

// Artifact groups accepted without a lease: worktrees/<primary checkout basename> (legacy) or worktrees/<repo name of the live-verified origin>.
function automaticArtifactAllowed(file: string, target: { candidate: string; pushUrl: string }): boolean {
	const candidate = target.candidate;
	try {
		if (!path.isAbsolute(file) || file.includes("\\") || !/^[\x20-\x7e]+$/.test(file)) return false;
		const common = gitRead(candidate, ["rev-parse", "--git-common-dir"]);
		if (common?.length !== 1) return false;
		const commonDir = canonicalCwd(path.resolve(candidate, common[0]));
		if (path.basename(commonDir).toLowerCase() !== ".git") return false;
		const primary = path.dirname(commonDir);
		const repoName = parseRepoFromPushUrl(target.pushUrl)?.split("/")[1];
		const names = [path.basename(primary), ...(repoName !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repoName) && !repoName.endsWith(".") ? [repoName] : [])];
		const normalizedFile = normPath(file);
		const base = path.join(path.dirname(primary), "worktrees");
		const group = names.map((name) => path.join(base, name)).find((g) => normalizedFile.startsWith(`${normPath(g)}/`));
		if (group === undefined) return false;
		const normalizedGroup = normPath(group);
		const parts = normalizedFile.slice(normalizedGroup.length + 1).split("/");
		if (parts.length < 3 || !["_scratch", "_evidence"].includes(parts[0])) return false;
		const taskDir = path.join(group, parts[0], parts[1]);
		const validated = validateArtifactDir(taskDir.replace(/\\/g, "/"), candidate);
		return checkArtifactFile(file, validated) === undefined;
	} catch { return false; }
}

function normalTrustedCommit(target: { candidate: string; pushUrl: string; branch: string } | undefined, decision: Extract<Decision, { action: "block" }>, liveUrl: (candidate: string, branch: string) => string | undefined): boolean {
	if (!target || decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_COMMIT") return false;
	const normal = parseNormalCommit(decision.op.command);
	if (!normal) return false;
	try { return commitTargetLive(target, decision.op.cwd, liveUrl) !== undefined && (normal.file === undefined || automaticArtifactAllowed(normal.file, target)); } catch { return false; }
}

// A child release-engineer normal commit that matches a live commit lease: exact normal commit form, only GIT_COMMIT, cwd is the leased candidate root on the leased branch with the live origin binding, no merge-like state, no redirect env. Non-consuming; any throw or mismatch refuses.
function leasedCommit(store: GrantStore, decision: Extract<Decision, { action: "block" }>, liveUrl: (candidate: string, branch: string) => string | undefined): boolean {
	if (decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_COMMIT") return false;
	const normal = parseNormalCommit(decision.op.command);
	if (!normal) return false;
	try {
		const root = decision.op.cwd;
		if (REDIRECT_ENV.some((k) => process.env[k] !== undefined) || Object.keys(process.env).some((k) => k.startsWith("GIT_CONFIG_KEY_") || k.startsWith("GIT_CONFIG_VALUE_"))) return false;
		const top = gitRead(root, ["rev-parse", "--show-toplevel"]);
		if (top?.length !== 1 || foldPath(canonicalCwd(top[0])) !== foldPath(root)) return false;
		const head = gitRead(root, ["symbolic-ref", "-q", "HEAD"]);
		if (head?.length !== 1 || !head[0].startsWith("refs/heads/")) return false;
		const branch = validatePushBranch(head[0].slice("refs/heads/".length));
		const url = liveUrl(root, branch);
		const lease = url === undefined ? undefined : store.findLease(root, branch, url);
		if (lease?.commits !== true) return false;
		const target = { candidate: root, pushUrl: url!, branch };
		if (commitTargetLive(target, root, liveUrl) === undefined) return false;
		if (normal.file !== undefined && (!lease.artifactDir || checkArtifactFile(normal.file, lease.artifactDir) !== undefined)) return false;
		return true;
	} catch {
		return false;
	}
}

// A child release-engineer push that matches a live lease: exact normal push, only GIT_PUBLISH, live binding must equal the lease. Non-consuming; any throw or mismatch refuses.
function trustedTargetLive(target: { candidate: string; pushUrl: string; branch: string }, cwd: string, liveUrl: (candidate: string, branch: string) => string | undefined): boolean {
	if (foldPath(canonicalCwd(cwd)) !== foldPath(target.candidate) || redirectedGitEnvironment()) return false;
	const top = gitRead(target.candidate, ["rev-parse", "--show-toplevel"]);
	const head = gitRead(target.candidate, ["symbolic-ref", "--short", "HEAD"]);
	return top?.length === 1 && foldPath(canonicalCwd(top[0])) === foldPath(target.candidate) && head?.length === 1 && validatePushBranch(head[0]) === target.branch && liveUrl(target.candidate, target.branch) === target.pushUrl;
}

function normalTrustedPush(target: { candidate: string; pushUrl: string; branch: string } | undefined, decision: Extract<Decision, { action: "block" }>, liveUrl: (candidate: string, branch: string) => string | undefined): boolean {
	if (!target || decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_PUBLISH") return false;
	const normal = parseNormalPush(decision.op.command);
	if (!normal || normal.branch !== target.branch) return false;
	try { return trustedTargetLive(target, decision.op.cwd, liveUrl); } catch { return false; }
}

// Automatic same-owned PR metadata edit (trusted release-engineer, no grant): exact `gh pr edit` form (parser allowlist: --repo, --title, --body or --body-file only), origin repo, live PR open, same-repo and headed by the task's feature branch. Never base, reviewers, labels, state or cross-repo changes.
function normalTrustedPrEdit(target: PushTarget | undefined, decision: Extract<Decision, { action: "block" }>, liveUrl: (candidate: string, branch: string) => string | undefined, live: DeliveryLive): boolean {
	if (!target || decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_PUBLISH") return false;
	const command = parseDeliveryCommand(decision.op.command);
	if (!command || command.kind !== "edit") return false;
	try {
		const env = live.env();
		if (env.GH_HOST !== undefined || env.GH_REPO !== undefined || !trustedTargetLive(target, decision.op.cwd, liveUrl)) return false;
		const repo = parseRepoFromPushUrl(target.pushUrl);
		if (repo === undefined || command.repo !== repo || (command.bodyFile !== undefined && !automaticArtifactAllowed(command.bodyFile, target))) return false;
		const view = prView(command.pr, repo, live);
		return openSameRepo(view, target.branch) && baseBranchOk(view.baseRefName) && (target.base === undefined || view.baseRefName === target.base);
	} catch { return false; }
}

function normalTrustedPrCreate(target: PushTarget | undefined, decision: Extract<Decision, { action: "block" }>, liveUrl: (candidate: string, branch: string) => string | undefined, live: DeliveryLive): boolean {
	if (!target || decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_PUBLISH") return false;
	const command = parseDeliveryCommand(decision.op.command);
	if (!command || command.kind !== "create" || (command.body === undefined) === (command.bodyFile === undefined)) return false;
	try {
		const env = live.env();
		if (env.GH_HOST !== undefined || env.GH_REPO !== undefined || !trustedTargetLive(target, decision.op.cwd, liveUrl)) return false;
		const repo = parseRepoFromPushUrl(target.pushUrl);
		return repo !== undefined && command.repo === repo && command.head === target.branch && command.base !== target.branch && baseBranchOk(command.base) && (target.base === undefined || command.base === target.base) && (command.bodyFile === undefined || automaticArtifactAllowed(command.bodyFile, target));
	} catch { return false; }
}

function leasedPush(store: GrantStore, decision: Extract<Decision, { action: "block" }>, liveUrl: (candidate: string, branch: string) => string | undefined): boolean {
	if (decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_PUBLISH") return false;
	const normal = parseNormalPush(decision.op.command);
	if (!normal) return false;
	try {
		const url = liveUrl(decision.op.cwd, normal.branch);
		return url !== undefined && store.hasLease(decision.op.cwd, normal.branch, url);
	} catch {
		return false;
	}
}

// Fixed hint (no command or path echo) only when the sole refused argument is one -m/-F value that is not in the strict quoted grammar; amend, --no-verify, -a and other flags get none.
function unsupportedCommitHint(decision: Extract<Decision, { action: "block" }>): string {
	if (decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_COMMIT" || parseNormalCommit(decision.op.command) !== undefined) return "";
	const bare = decision.op.command.replace(/"[^"]*"|'[^']*'/g, "Q");
	return /^git commit -[mF] \S+$/.test(bare) ? '; not a normal commit form: use git commit -m "<text>" or git commit -F "<absolute .md/.txt file>" (double quotes, one command, cwd = candidate root)' : "";
}

// Shared hook logic for main and child: allow, consume one exact grant, use a live child lease, or block with rule ids and a digest only (no raw command).
export function guardToolCall(guard: { scope: GuardScope; store: GrantStore; agentDir: string; live?: DeliveryLive; gateCommits?: boolean; pushTarget?: PushTarget }, toolName: string, input: Record<string, unknown>, cwd: string, liveUrl: (candidate: string, branch: string) => string | undefined = livePushUrl): GuardBlock | undefined {
	// Commit gating is a trusted-child policy only; the main guard never gates commits.
	const decision = decideToolCall(toolName, input, cwd, guard.agentDir, guard.scope === "child" && guard.gateCommits === true);
	if (decision.action === "allow") return undefined;
	// A single-use record never carries PR merge or release create (defense in depth for envelopes or stores that hold one): only the action grants do.
	if (decision.grantable && !(decision.op.kind === "shell" && isMergeOrRelease(decision.op.command)) && guard.store.consume(guard.scope, canonicalCwd(cwd), decision.op)) return undefined;
	if (guard.scope === "child" && normalTrustedPush(guard.pushTarget, decision, liveUrl)) return undefined;
	const live = guard.live ?? defaultDeliveryLive(liveUrl);
	if (guard.scope === "child" && (guard.gateCommits === true || guard.pushTarget !== undefined) && (normalTrustedPrCreate(guard.pushTarget, decision, liveUrl, live) || normalTrustedPrEdit(guard.pushTarget, decision, liveUrl, live))) return undefined;
	if (guard.scope === "child" && leasedPush(guard.store, decision, liveUrl)) return undefined;
	if (guard.scope === "child" && guard.gateCommits === true && normalTrustedCommit(guard.pushTarget, decision, liveUrl)) return undefined;
	if (guard.scope === "child" && guard.gateCommits === true && leasedCommit(guard.store, decision, liveUrl)) return undefined;
	if (guard.scope === "child" && deliveryAllows(guard.store, decision, live)) return undefined;
	const how = decision.grantable ? "needs an explicit operator grant (request_authorization is for a genuinely blocked risky command such as merge or release, not ordinary commit, feature push or PR create)" : "not grantable to a model: use the operator out-of-band";
	return { block: true, reason: `Blocked by harness safety guard [${decision.rules.join(", ")}] op ${decision.digest}: ${how}${unsupportedCommitHint(decision)}.` };
}

const MERGE_OR_RELEASE = /\bgh(?:\.exe)?\s+(?:(?:-R|--repo|--hostname)[\s=]\S+\s+)*(?:pr\s+merge|release\s+create)\b/i;

// Authorization requests are accepted only for operations the guard would actually block and that are grantable.
export function authorizableOp(kind: "shell" | "write", value: string, candidate: string, agentDir: string, gateCommits = false): GuardOp {
	const decision = kind === "shell" ? decideToolCall("bash", { command: value }, candidate, agentDir, gateCommits) : decideToolCall("write", { path: value }, candidate, agentDir);
	if (decision.action !== "block" || !decision.grantable) throw new RangeError("operation is not a grantable risky operation");
	// Merge and release run only through the dedicated action grants (exact PR/version, SHA pins, separate confirmations); a single-use or batched shell grant would bypass those pins.
	if (kind === "shell" && isMergeOrRelease(value)) throw new RangeError("PR merge and release create need their own delivery action grant (request_authorization delivery), never a single-use operation");
	validateOp(decision.op);
	return decision.op;
}

// One prompt shows the whole batch: 1 to 5 operations, each displayable, total bounded (nothing truncated).
export function assertBatchDisplayable(ops: GuardOp[]): void {
	if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_GRANT_OPS) throw new RangeError(`a batch carries 1 to ${MAX_GRANT_OPS} operations`);
	ops.forEach(validateOp);
	if (ops.reduce((sum, op) => sum + describeOp(op).length, 0) > MAX_BATCH_CHARS) throw new RangeError(`operation batch exceeds ${MAX_BATCH_CHARS} characters`);
}
