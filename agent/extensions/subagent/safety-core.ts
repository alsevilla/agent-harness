// Stage 1 safety core: pure guard rules, a bounded lexical shell matcher and a single-use in-memory grant store.
// Not an OS sandbox and not a shell parser: documented bypasses (scripts, env, aliases, variables, operator shell) are in subagent/README.md.
import * as childProcess from "node:child_process"; // namespace import: test doubles that stub only `spawn` still link
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertExcludeUntracked, candidateFingerprint, git as hardenedGit, preflight as checkoutPreflight, assertNoRepoFsmonitor, validateExclude } from "./candidate-fingerprint.ts";
import { overlaps, type OwnerTracker } from "./cleanup-state.ts";
import { foldCase } from "./path-case.ts";

export type RiskRule =
	| "GIT_PUBLISH" | "GIT_COMMIT" | "GIT_DESTRUCTIVE" | "PKG_PUBLISH_AUTH" | "DESTRUCTIVE_FS" | "LINKS" | "PRIVILEGE_PERSIST" | "PROC_KILL"
	| "LAUNCH_PI" | "PI_PACKAGE" | "CURL_SHELL" | "OPAQUE_UNPARSEABLE" | "SECRET" | "CONFIG_WRITE" | "PATH_AMBIGUOUS";

export type GuardOp = { kind: "shell"; command: string; cwd: string } | { kind: "write"; path: string } | { kind: "read"; path: string };
export type Decision = { action: "allow" } | { action: "block"; rules: RiskRule[]; grantable: boolean; op: GuardOp; digest: string };
export interface ShellClassification { rules: RiskRule[]; grantable: boolean }

export const MAX_GRANT_OPS = 5;
export const GRANT_TTL_DEFAULT_MS = 30 * 60_000;
export const GRANT_TTL_MAX_MS = 60 * 60_000;
const MAX_NESTING = 4;

// Pi CLI forms (pi docs/cli.md, docs/packages.md). Anything else, including a bare `pi` or a prompt, launches an agent.
const PI_READ_ONLY = new Set(["list", "--help", "-h", "--version"]);
const PI_PACKAGE_CMDS = new Set(["install", "remove", "uninstall", "update", "config"]);
/** Arguments after the Pi program for `pi ...`, `npx pi ...` or `node <pi-coding-agent cli> ...`; undefined when this is not Pi. */
function piArgs(name: string, lower: string[]): string[] | undefined {
	if (name === "pi") return lower;
	const at = name === "npx" ? lower.findIndex((a) => a === "pi" || a.includes("pi-coding-agent")) : name === "node" ? lower.findIndex((a) => a.includes("pi-coding-agent")) : -1;
	return at < 0 ? undefined : lower.slice(at + 1);
}
const NOT_GRANTABLE = new Set<RiskRule>(["OPAQUE_UNPARSEABLE", "SECRET", "PATH_AMBIGUOUS"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const WRAPPERS = new Set(["env", "command", "nohup", "time", "timeout", "exec", "call", "start", "nice", "xargs"]);
const DELETE_CMDS = new Set(["rm", "rmdir", "rd", "unlink", "shred", "del", "erase", "rimraf", "remove-item", "ri"]);
const PS_DELETE_NAMES = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const PRIVILEGE_CMDS = new Set(["sudo", "runas", "schtasks", "reg", "setx", "crontab", "icacls", "takeown", "chmod", "chown", "register-scheduledtask", "new-scheduledtask"]);
const PROC_CMDS = new Set(["kill", "killall", "pkill", "taskkill", "stop-process"]);
const WRITE_CMDS = new Set(["cp", "copy", "mv", "move", "tee", "set-content", "out-file", "add-content", "copy-item", "move-item", "sed", "new-item"]);
const PKG_SUBS = new Set(["publish", "login", "adduser", "logout", "token", "owner", "access", "dist-tag"]);
const SECRET_BASENAME = /^(auth\.json|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|credentials|credentials\.json)$|^\.env(\..+)?$|\.(pem|key|p12|pfx)$/;
const SECRET_SAFE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const CREDENTIAL_TEXT = /(token|password|secret|api[_-]?key|authorization)\s*[=:]|_authtoken|\bBearer\s+\S+|\b(sk-|ghp_|github_pat_|xox[bp]-|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
// Field report (op c058ffddb7a0f93c): an approved isolated preview set a disposable admin password generated at runtime
// ($env:ADMIN_PASSWORD = [guid]::NewGuid()), and every command naming a password was refused as credential-like. A credential
// assignment whose value is computed when the command runs carries no secret in its text, so it can be shown and approved; a literal
// value, a Bearer token, a known key prefix or a private key cannot.
const CREDENTIAL_ASSIGN = /(token|password|secret|api[_-]?key|authorization)\s*[=:]\s*/gi;
const ALWAYS_CREDENTIAL = /_authtoken|\bBearer\s+\S+|\b(sk-|ghp_|github_pat_|xox[bp]-|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const RUNTIME_VALUE = /^(\[[A-Za-z_][\w.]*\]::|\$\(|\$[A-Za-z_{]|\(|-join\b|(Get-Random|New-Guid|ConvertTo-SecureString|openssl\s+rand|uuidgen|node\s+-e)\b)/i;
// Field report (op 5b724340ad2aa44d): an identity-checked cleanup of a test backend was refused as credential-like and the worker could
// find no credential in it. The refusal now names the part that matched (never the value), and a credential word followed by no value,
// a wildcard or a closing bracket or quote (a match pattern such as -like '*token=*', or a "Token:" label) is not a literal credential.
const NO_VALUE = /^($|[*)\]};|,]|["'](\s|$|[*)\]};|,]))/;
/** What makes the text carry a credential literal (not one computed at runtime), named without the value; undefined when it carries none. */
export function credentialFinding(text: string): string | undefined {
	const always = ALWAYS_CREDENTIAL.exec(text);
	if (always) {
		const hit = always[0];
		const what = always[1] ? `a known key prefix (${always[1].startsWith("AKIA") ? "AKIA" : always[1]})` : /^_authtoken/i.test(hit) ? "an _authToken setting" : /^Bearer/i.test(hit) ? "a Bearer token" : "a private key block";
		return `${what} at character ${always.index + 1}`;
	}
	for (const m of text.matchAll(CREDENTIAL_ASSIGN)) {
		const rest = text.slice((m.index ?? 0) + m[0].length);
		if (!RUNTIME_VALUE.test(rest) && !NO_VALUE.test(rest)) return `"${m[1].toLowerCase()}${m[0].trim().slice(-1)}" followed by a literal value at character ${(m.index ?? 0) + 1}`;
	}
	return undefined;
}
/** True when the text embeds a credential literal (not one computed at runtime), so it must not be shown in an approval or stored in a grant. */
export function literalCredential(text: string): boolean {
	return credentialFinding(text) !== undefined;
}

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
	return basenameOf(norm) === "settings.json" || basenameOf(norm) === PERMISSIONS_FILE || /(^|\/)\.git\/(hooks\/|config$)/.test(norm);
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

export function unresolvedDeleteTarget(arg: string): boolean {
	const a = arg.trim();
	if (/[$`]|%[A-Za-z_][A-Za-z0-9_]*%/.test(a)) return true; // shell, PowerShell or cmd variable or substitution: unknown until run
	const p = a.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
	return /^(\/|[A-Za-z]:|[A-Za-z]:\/?|~|\.|\.\.|\*|\/\*|[A-Za-z]:\/\*|~\/\*|\.\/\*)$/.test(p);
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
		if ((sub1 === "pr" && ["create", "merge", "close", "edit", "ready", "review"].includes(sub2)) || (sub1 === "release" && !["list", "view"].includes(sub2)) || (sub1 === "repo" && ["create", "delete", "rename", "edit"].includes(sub2))) add(out, "GIT_PUBLISH");
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
	// PowerShell providers that are not the filesystem: Remove-Item Env:NAME clears a process variable, not a file.
	if (DELETE_CMDS.has(name) && PS_DELETE_NAMES.has(name)) {
		const targets = args.filter((a, i) => !a.startsWith("-") && !/^-(?:ErrorAction|ea|WarningAction|wa)$/i.test(args[i - 1] ?? ""));
		if (targets.length && targets.every((a) => /^(env|variable|function|alias):/i.test(a))) return;
	}
	if (DELETE_CMDS.has(name)) {
		// A delete whose target is a variable, substitution, glob at a root, or a root, home or current/parent folder can remove far more
		// than intended (rm -rf $DIR/ with an empty DIR is rm -rf /). No approval makes that safe, so it is PATH_AMBIGUOUS, never grantable.
		if (args.filter((a) => !a.startsWith("-")).some(unresolvedDeleteTarget)) add(out, "PATH_AMBIGUOUS");
		return add(out, "DESTRUCTIVE_FS");
	}
	if (name === "find" && (lower.includes("-delete") || (lower.includes("-exec") && lower.includes("rm")))) return add(out, "DESTRUCTIVE_FS");
	if (name === "ln" || name === "mklink") return add(out, "LINKS");
	if (name === "fsutil" && lower.some((a) => a === "hardlink" || a === "reparsepoint")) return add(out, "LINKS");
	if (name === "new-item" && lower.some((a) => ["symboliclink", "junction", "hardlink"].includes(a))) return add(out, "LINKS");
	if (PRIVILEGE_CMDS.has(name)) return add(out, "PRIVILEGE_PERSIST");
	if (name === "net" && (lower[0] === "user" || lower[0] === "localgroup")) return add(out, "PRIVILEGE_PERSIST");
	if (PROC_CMDS.has(name)) return add(out, "PROC_KILL");
	const pi = piArgs(name, lower);
	if (pi !== undefined) {
		// Only an agent launch is LAUNCH_PI. Help, version and the package list print and exit; package commands change the installed extensions.
		if (pi.length === 1 && PI_READ_ONLY.has(pi[0])) return;
		return add(out, PI_PACKAGE_CMDS.has(pi[0] ?? "") ? "PI_PACKAGE" : "LAUNCH_PI");
	}
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
	if (/\.Kill\s*\(/i.test(text)) add(out, "PROC_KILL"); // System.Diagnostics.Process.Kill(), which names no kill command
	if (/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&\n]*\|\s*(sh|bash|zsh|dash|iex|invoke-expression|pwsh|powershell|cmd)\b/i.test(text)) add(out, "CURL_SHELL");
	if (/\b(iex|invoke-expression)\b.*\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i.test(text)) add(out, "CURL_SHELL");
}

// Field report (sms-live-test): a read-only test-engineer's hardware smoke test started the backend from its _evidence folder, waited,
// then stopped it, and the stop was refused as PROC_KILL although it ended only the process the same command had started. A stop is now
// allowed when every process it targets is owned by the command: held in a variable assigned exactly once, from Start-Process -PassThru
// (PowerShell) or $! after a background launch (Bash), or a Bash job spec (%1). Stopping by name, by a literal PID or through any other
// variable stays PROC_KILL.
function ownedProcessVars(text: string): Set<string> {
	const owned = new Set<string>();
	if (VAR_CHANGERS.test(text)) return owned;
	const count = (re: RegExp) => [...text.matchAll(re)].length;
	for (const m of text.matchAll(/\$([A-Za-z_]\w*)\s*=\s*Start-Process\b[^;\n|]*?\s-PassThru\b/gi)) {
		if (count(new RegExp(`\\$${m[1]}\\s*=(?!=)`, "gi")) === 1) owned.add(m[1].toLowerCase());
	}
	for (const m of text.matchAll(/(?:^|[\s;&])([A-Za-z_]\w*)=\$!(?=$|[\s;&])/g)) {
		if (count(new RegExp(`(?:^|[\\s;&|(])${m[1]}=`, "g")) === 1) owned.add(m[1].toLowerCase());
	}
	return owned;
}
// $p, "$p", ${p}, $p.Id, "$p.Id" or $($p.Id)
const OWNED_REF = /^(?:"?\$\{?([A-Za-z_]\w*)\}?(?:\.Id)?"?|\$\(\$([A-Za-z_]\w*)\.Id\))$/i;
/** Whether every process stop in the command targets a process the command itself started. */
function killsOnlyOwned(command: string): boolean {
	// "$p | Stop-Process" names its target before the pipe; rewrite it as the -InputObject form so the segment carries the target.
	const text = command.replace(/\$([A-Za-z_]\w*)\s*\|\s*Stop-Process\b/gi, (_m, v: string) => `Stop-Process -InputObject $${v}`);
	const owned = ownedProcessVars(text);
	const isOwned = (arg: string) => { const m = OWNED_REF.exec(arg); return !!m && owned.has((m[1] ?? m[2]).toLowerCase()); };
	for (const m of text.matchAll(/(\S*)\.Kill\s*\(/gi)) if (!isOwned(m[1])) return false;
	let stops = 0;
	for (const raw of splitSegments(text)) {
		const words = argvOf(tokenize(raw));
		const name = commandName(words[0] ?? "");
		if (!PROC_CMDS.has(name)) continue;
		stops++;
		if (name !== "kill" && name !== "stop-process") return false; // pkill, killall, taskkill: by name or image, never owned
		const args = words.slice(1);
		const targets: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (name === "kill") {
				if (/^-(?:\d+|[A-Z]+)$/i.test(a)) continue; // -9, -TERM, -SIGKILL
				if (/^-[sn]$/i.test(a)) { i++; continue; }
				targets.push(a);
				continue;
			}
			if (/^-(?:force|passthru|whatif|confirm)$/i.test(a)) continue;
			if (/^-(?:erroraction|ea|warningaction|wa)$/i.test(a)) { i++; continue; }
			if (/^-(?:id|inputobject)$/i.test(a)) { if (args[i + 1] !== undefined) targets.push(args[++i]); continue; }
			if (a.startsWith("-")) return false; // -Name and anything unknown
			targets.push(a);
		}
		if (!targets.length || !targets.every((t) => isOwned(t) || (name === "kill" && /^%(?:\d+|%|\+|-)$/.test(t)))) return false;
	}
	return stops > 0 || /\.Kill\s*\(/i.test(text);
}

// Git Bash argv collapses each backslash pair before the shell parses it (a run of n reaches the shell as ceil(n/2)): classify raw and collapsed text, a conservative union. Grant text stays raw (decideToolCall).
// shortcut: collapse applies on every platform and shell (over-blocks PowerShell/POSIX text with backslash pairs), upgrade by gating on the verified Git Bash argv transport.
export function classifyShell(command: string, gateCommits = false): ShellClassification {
	// Text a command only writes to a file (or prints) is data, not commands: see withoutFileBodies.
	const text = withoutFileBodies(String(command ?? ""));
	const out = new Set<RiskRule>();
	classifyVariants(text, out);
	if (out.has("PROC_KILL") && killsOnlyOwned(text)) out.delete("PROC_KILL");
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
	return base === "settings.json" || base === PERMISSIONS_FILE || /(^|\/)\.git\/(hooks\/|config$)/.test(norm) || (norm.startsWith(agent) && base.includes("trust"));
}

export function canonicalCwd(cwd: string): string {
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

// Command text is case-exact; paths (cwd or target) are case-folded where the OS ignores case (Windows, macOS; see path-case.ts).
function foldPath(p: string): string {
	return foldCase(p);
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
	const finding = credentialFinding(text);
	if (finding) throw new RangeError(`credential-like literal text is not authorizable (${finding}): generate the value when the command runs (for example $env:NAME = [guid]::NewGuid().ToString()) or have the operator run it out-of-band`);
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
	/** Why a blocked shell op found no grant: one exists for other text here, for this text elsewhere, or this exact one was already used. */
	grantMiss?(scope: GuardScope, candidate: string, op: GuardOp): GrantMiss | undefined;
	claim(role: string, candidate: string): GrantRecord[];
	/** Why a launch of this role in this folder receives no grant although live ones exist: another folder, or another role here. */
	claimHint?(role: string, candidate: string): string | undefined;
	/** Ids of single-use grants this store consumed, in order (the child reports them to main). */
	spentIds?(): string[];
	/** Main: records a worker took at launch, held until that worker exits. */
	lend?(holder: string, records: GrantRecord[]): void;
	/** Main: a worker exited; its taken grants it did not use (and that have not expired) return to the store. Returns how many. */
	returnLent?(holder: string, used: ReadonlySet<string>): number;
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
	addCleanupGrant(grant: CleanupGrant): void;
	peekCleanup(id: string): CleanupGrant | undefined;
	claimCleanup(id: string): CleanupGrant | undefined;
	importCleanup(incoming: CleanupGrant[]): void;
	findCleanup(candidate: string): CleanupGrant | undefined;
	takeCleanup(id: string): boolean;
	cleanupCount(): number;
	addArtifactCleanup(entries: ArtifactCleanup[]): void;
	takeArtifactCleanup(target: string): ArtifactCleanup | undefined;
}

function validateRecord(value: unknown): GrantRecord {
	const r = value as GrantRecord;
	if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[0-9a-f]{64}$/.test(String(r.bearer)) || !(r.role === null || typeof r.role === "string") || typeof r.candidate !== "string" || !path.isAbsolute(r.candidate) || typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) throw new TypeError("invalid grant record");
	validateOp(r.op);
	return r;
}

export type GrantMiss = "other-text" | "other-folder" | "used";
export function createGrantStore(now: () => number = () => Date.now()): GrantStore {
	let records: GrantRecord[] = [];
	// Keys of single-use grants already consumed, kept until the grant would have expired, only to explain a repeat block.
	let spent: { id: string; main: boolean; key: string; expiresAt: number }[] = [];
	// Field report (sms-live-retry): a worker takes every approval for its role and folder when it starts. One that exited without using
	// it (refused for shell syntax first) kept it, so the replacement worker launched with none and was refused as PROC_KILL. Main now
	// lends taken approvals to the worker and takes back, when it exits, every one it did not use.
	let lent: { holder: string; record: GrantRecord }[] = [];
	let leases: PushLease[] = [];
	let delivery: DeliveryGrant[] = [];
	let cleanup: CleanupGrant[] = [];
	let artifacts: ArtifactCleanup[] = [];
	const live = () => {
		const t = now();
		records = records.filter((r) => r.expiresAt > t);
		spent = spent.filter((s) => s.expiresAt > t);
		cleanup = cleanup.filter((c) => t - c.issuedAt <= CLEANUP_TTL_MS);
		artifacts = artifacts.filter((a) => t - a.issuedAt <= CLEANUP_TTL_MS);
		return t;
	};
	return {
		// Cleanup scopes are single-use and short-lived: revoked by abort and by shutdown, expired after CLEANUP_TTL_MS, claimed by one launch or consumed by one guard allow.
		addCleanupGrant(grant) {
			live();
			const next = normalizeCleanup(grant);
			cleanup = cleanup.filter((c) => normPath(c.candidate) !== normPath(next.candidate));
			if (cleanup.length >= MAX_CLEANUP_GRANTS) throw new RangeError(`at most ${MAX_CLEANUP_GRANTS} pending cleanup scopes`);
			cleanup.push(next);
		},
		peekCleanup(id) {
			live();
			const found = cleanup.find((c) => c.id === id);
			return found ? { ...found } : undefined;
		},
		claimCleanup(id) {
			live();
			const index = cleanup.findIndex((c) => c.id === id);
			return index < 0 ? undefined : cleanup.splice(index, 1)[0];
		},
		importCleanup(incoming) {
			const valid = incoming.map(normalizeCleanup);
			if (valid.length > MAX_CLEANUP_GRANTS) throw new RangeError("too many cleanup scopes");
			for (const g of valid) {
				if (g.task === undefined) cleanup.push(g);
				else for (const folder of cleanupTargets(g)) artifacts.push({ path: folder, primary: g.primary, issuedAt: g.issuedAt });
			}
		},
		findCleanup(candidate) {
			live();
			const found = cleanup.find((c) => normPath(c.candidate) === normPath(candidate));
			return found ? { ...found } : undefined;
		},
		takeCleanup(id) {
			live();
			const index = cleanup.findIndex((c) => c.id === id);
			if (index < 0) return false;
			cleanup.splice(index, 1);
			return true;
		},
		cleanupCount() {
			live();
			return cleanup.length;
		},
		// Artifact folders of a checkout whose exact removal the guard just allowed: one entry per folder, single use, same TTL.
		addArtifactCleanup(entries) {
			live();
			for (const e of entries) {
				artifacts = artifacts.filter((a) => normPath(a.path) !== normPath(e.path));
				artifacts.push({ ...e });
			}
		},
		takeArtifactCleanup(target) {
			live();
			const index = artifacts.findIndex((a) => normPath(a.path) === normPath(target));
			return index < 0 ? undefined : artifacts.splice(index, 1)[0];
		},
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
			const [used] = records.splice(index, 1);
			spent.push({ id: used.id, main: used.role === null, key: keyOf(used.op), expiresAt: used.expiresAt });
			return true;
		},
		spentIds() {
			return spent.map((s) => s.id);
		},
		lend(holder, taken) {
			for (const record of taken) lent.push({ holder, record });
		},
		returnLent(holder, used) {
			const t = live();
			const mine = lent.filter((l) => l.holder === holder);
			lent = lent.filter((l) => l.holder !== holder);
			const back = mine.map((l) => l.record).filter((r) => !used.has(r.id) && r.expiresAt > t && !records.some((x) => x.id === r.id));
			records.push(...back);
			// Used ones are remembered until they would have expired, only to tell the next launch why it received nothing.
			for (const { record } of mine) if (used.has(record.id)) spent.push({ id: record.id, main: false, key: `${record.role}\0${foldPath(record.candidate)}\0${keyOf(record.op)}`, expiresAt: record.expiresAt });
			return back.length;
		},
		grantMiss(scope, candidate, op) {
			live();
			if (op.kind !== "shell") return undefined;
			const mine = records.filter((r) => (scope === "main" ? r.role === null : r.role !== null) && r.op.kind === "shell");
			if (mine.some((r) => r.op.kind === "shell" && r.op.command === op.command)) return "other-folder";
			if (mine.some((r) => foldPath(r.candidate) === foldPath(candidate))) return "other-text";
			if (spent.some((s) => s.main === (scope === "main") && s.key === keyOf(op))) return "used";
			return undefined;
		},
		claim(role, candidate) {
			const t = live();
			// Folded like every other path check: on Windows a grant for C:\\Work\\App and a launch in c:\\work\\app are one folder.
			const taken = records.filter((r) => r.role === role && foldPath(r.candidate) === foldPath(candidate) && r.expiresAt > t);
			records = records.filter((r) => !taken.includes(r));
			return taken;
		},
		claimHint(role, candidate) {
			const t = live();
			const held = lent.find((l) => l.record.role === role && foldPath(l.record.candidate) === foldPath(candidate) && l.record.expiresAt > t);
			if (held) return `main's approval for ${role} in this folder is held by another ${role} worker that is still running; it returns to main if that worker exits without using it, so stop or wait for that worker and launch again`;
			if (!records.some((r) => r.role === role && foldPath(r.candidate) === foldPath(candidate)) && spent.some((s) => s.key.startsWith(`${role}\0${foldPath(candidate)}\0`))) return `an earlier ${role} worker in this folder used main's approval; approvals are single use, so ask for a new approval and launch again`;
			const liveRecords = records.filter((r) => r.expiresAt > t);
			const elsewhere = liveRecords.find((r) => r.role === role && foldPath(r.candidate) !== foldPath(candidate));
			if (elsewhere) return `main holds an approval for ${role} in folder ${elsewhere.candidate}, but this worker was launched in ${candidate}; launch it in that folder or ask for an approval with cwd set to this one`;
			const other = liveRecords.find((r) => r.role !== role && foldPath(r.candidate) === foldPath(candidate));
			if (other) return `main holds an approval for this folder bound to ${other.role === null ? "main" : `role ${other.role}`}, not ${role}`;
			return undefined;
		},
		importRecords(incoming) {
			const valid = incoming.map(validateRecord);
			records.push(...valid);
		},
		revokeAll(includeLeases = false) {
			records = [];
			spent = [];
			cleanup = [];
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
/** One line from main's launch: why this worker received no single-use approval although one was requested. Advisory text only. */
export const CHILD_GRANT_NOTE_ENV = "PI_SAFETY_GRANT_NOTE";

// Push target of the trusted release-engineer launch. `base` is the optional parent-supplied PR base: when present, PR create/edit must match it exactly; when absent the legacy syntactic-only base check applies.
export interface PushTarget { candidate: string; pushUrl: string; branch: string; base?: string }

export function serializeGrants(records: GrantRecord[], leases: PushLease[] = [], delivery: DeliveryGrant[] = [], gateCommits = false, pushTarget?: PushTarget, cleanup: CleanupGrant[] = []): string {
	// A known PR base travels under its own key (pushTargetBound), never inside pushTarget: a loader that predates it ignores the unknown key and sees no push target (every automatic PR/push path stays blocked) instead of rebuilding a legacy target that drops the base.
	// Action grants (merge/release) travel under their own key: an older loader ignores unknown keys and so sees no grant, never a broader one. The legacy delivery/deliveryBound keys are never written.
	return JSON.stringify({ v: 1, grants: records, ...(leases.length ? { leases } : {}), ...(delivery.length ? { deliveryActions: delivery } : {}), ...(cleanup.length ? { cleanupActions: cleanup } : {}), ...(gateCommits ? { gateCommits: true } : {}), ...(pushTarget ? (pushTarget.base !== undefined ? { pushTargetBound: pushTarget } : { pushTarget }) : {}) });
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
	if (store.cleanupCount()) lines.push(`cleanup scopes: ${store.cleanupCount()} (single-use, 10 min, checkout removal only; artifacts are never covered)`);
	const deliveries = store.listDelivery();
	lines.push(deliveries.length ? `merge/release grants: ${deliveries.length} (approved scope, session only)` : "merge/release grants: none");
	for (const d of deliveries) lines.push(`- ${d.action}: repo ${d.repo}, branch ${d.branch}, base ${d.base}, PR ${d.pr}, SHA ${d.sha.slice(0, 7)}${d.action === "release" ? `, version ${d.version}, latest ${d.latest ? "yes" : "no"}${d.afterMerge ? ", target: the PR's merge commit" : ""}` : ""}, artifact dir ${d.artifactDir ?? "none"}, ${validityOf(d.candidate, d.branch, d.pushUrl)}${d.bound ? `, fp ${d.bound.fingerprint.slice(0, 12)}, excl ${d.bound.exclude.length} (not rechecked in status), follows later commits on top when clean and checks pass` : ""}`);
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
// Field report: an approved squash merge with --subject "fix(db): Schedule backups" was refused as if no approval existed. The colon
// (conventional commit subjects; the commit -m text already allows it) is accepted, and a command that is not an accepted form now
// says which argument is wrong (deliveryFormWhy) instead of asking for another approval.
const TEXT_ARG = /^[A-Za-z0-9 .,:_\/#()+-]+$/;
const TEXT_ALLOWED = "ASCII letters, digits, space and . , : _ / # ( ) + -";
const BARE_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BARE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const BARE_NUM = /^[1-9][0-9]{0,8}$/;
const BARE_SHA = /^[0-9a-f]{40}$/;
const BARE_VERSION = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TEXT_LIMIT = { title: 120, subject: 120, body: 500 } as const;

// Fingerprint binding (mandatory for a merge grant): HEAD attached to ref, the candidate fingerprint and the exclusions it was computed with.
export interface BoundState { head: string; ref: string; fingerprint: string; exclude: string[] }
// One action per grant. merge: PR + reviewed HEAD sha + mandatory bound (bound.head === sha); it follows the PR: later commits on top of
// sha merge too when the clean local candidate equals the live PR head and no check failed. release: PR + version + target sha (the merge
// commit), never bound; or afterMerge (minted with the merge in one approval): sha is the approved PR head and the target must be the PR's
// live merge commit. Push, PR create and PR edit are automatic and no grant carries them.
export type DeliveryAction = "merge" | "release";
export interface DeliveryBinding { role: string; candidate: string; pushUrl: string; repo: string; branch: string; base: string; action: DeliveryAction; pr: number; sha: string; version?: string; latest?: boolean; afterMerge?: boolean; artifactDir?: string; bound?: BoundState }
export interface DeliveryGrant extends DeliveryBinding { issuedAt: number }
// Live readers, injectable for offline tests. Production uses the real git/gh calls below.
export interface DeliveryLive { bound?(candidate: string, exclude: string[]): BoundState; follow?(candidate: string, exclude: string[], approved: string): FollowState; env(): Record<string, string | undefined>; pushUrl(candidate: string, branch: string): string | undefined; ghJson(args: string[]): unknown; tagStatus(pushUrl: string, tag: string): number; now?(): number }

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
export function validateArtifactDir(input: string, candidate: string, create = false): string {
	// shortcut: any ~<digit> segment refuses as a possible 8.3 alias (may over-block a literal ~1 name), upgrade to native alias resolution when realpath can settle it.
	if (typeof input === "string" && input.split("/").some((seg) => /~\d/.test(seg))) throw new RangeError("artifact directory is an alias or link (8.3 short name)");
	if (typeof input !== "string" || !/^[\x20-\x7e]+$/.test(input) || input.includes("\\") || !PLACEMENT.test(input) || badSegments(input)) throw new RangeError("artifact directory must be an ASCII absolute forward-slash path under worktrees/<repo>/_scratch or _evidence");
	const cand = normPath(canonicalCwd(candidate));
	const dir = normPath(input);
	if (dir === cand || dir.startsWith(`${cand}/`) || cand.startsWith(`${dir}/`)) throw new RangeError("artifact directory overlaps the candidate");
	// Grant time only: a missing folder in the approved placement is created, then checked like an existing one (an alias or link still refuses).
	if (create && !fs.existsSync(input)) {
		try { fs.mkdirSync(input, { recursive: true }); } catch { throw new RangeError("artifact directory could not be created"); }
	}
	let stat: fs.Stats;
	try { stat = fs.statSync(input); } catch { throw new RangeError("artifact directory does not exist"); }
	if (!stat.isDirectory()) throw new RangeError("artifact directory is not a directory");
	if (normPath(fs.realpathSync.native(input)) !== normPath(input)) throw new RangeError("artifact directory is an alias or link");
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
		if (b.version !== undefined || b.latest !== undefined || b.afterMerge !== undefined) throw new RangeError("a merge grant carries no release fields");
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
		if (b.afterMerge !== undefined && b.afterMerge !== false) {
			if (b.afterMerge !== true) throw new RangeError("afterMerge must be a boolean");
			out.afterMerge = true;
		}
	}
	if (b.artifactDir !== undefined) out.artifactDir = validateArtifactDir(b.artifactDir as string, candidate);
	if (b.disposal !== undefined) throw new RangeError("delivery disposal is retired and not accepted");
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
	return normPath(a.candidate) === normPath(b.candidate) && a.pushUrl === b.pushUrl && a.repo === b.repo && a.branch === b.branch && a.base === b.base && a.action === b.action && a.pr === b.pr && a.sha === b.sha && a.version === b.version && a.latest === b.latest && a.afterMerge === b.afterMerge && (a.artifactDir === undefined ? b.artifactDir === undefined : b.artifactDir !== undefined && normPath(a.artifactDir) === normPath(b.artifactDir));
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

// Live state for a merge of a later PR head: HEAD, its ref, whether the candidate is clean (no staged, unstaged or untracked path outside
// the grant's exclusions) and whether HEAD descends from the approved SHA (commits on top, no rewrite). Throws like readBoundState.
export interface FollowState { head: string; ref: string; clean: boolean; descends: boolean }
export function readFollowState(candidate: string, exclude: string[], approved: string): FollowState {
	if (redirectedGitEnvironment()) throw new Error("git environment is redirected");
	const top = gitRead(candidate, ["rev-parse", "--show-toplevel"]);
	if (top?.length !== 1 || foldPath(canonicalCwd(top[0])) !== foldPath(canonicalCwd(candidate))) throw new Error("not the repository root of the candidate");
	const ref = gitRead(candidate, ["symbolic-ref", "-q", "HEAD"]);
	if (ref?.length !== 1) throw new Error("HEAD is not attached to a branch");
	const f = candidateFingerprint(candidate, exclude);
	return { head: f.head, ref: ref[0], clean: f.records.length === 0 && f.unsupported.length === 0, descends: descendsFrom(candidate, approved, f.head) };
}

/** Whether head is approved or a descendant of it in the candidate's history. */
export function descendsFrom(candidate: string, approved: string, head: string): boolean {
	if (!BARE_SHA.test(approved) || !BARE_SHA.test(head)) return false;
	return approved === head || gitExit(candidate, ["merge-base", "--is-ancestor", approved, head]) === 0;
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

// Why a value is refused, named without echoing it (it may carry a credential): the flag, the rule and at most one offending character.
function valueWhy(flag: string, kind: Exclude<ArgKind, "none">, tok: Tok): string {
	switch (kind) {
		case "repo": return `the ${flag} value must be an unquoted OWNER/REPO`;
		case "branch": return `the ${flag} value must be an unquoted branch name`;
		case "sha": return `the ${flag} value must be an unquoted full 40-character lowercase commit SHA`;
		case "path": return `the ${flag} value must be a double-quoted absolute forward-slash path (at most 240 characters; letters, digits, space and _ . , + ( ) # / -)`;
	}
	const max = TEXT_LIMIT[kind];
	if (tok.quoted === "") return `the ${flag} value must be in double quotes`;
	if (tok.text.length < 1 || tok.text.length > max) return `the ${flag} value must be 1 to ${max} characters (it has ${tok.text.length})`;
	const at = Array.from(tok.text).findIndex((ch) => !TEXT_ARG.test(ch));
	if (at >= 0) return `the ${flag} value contains an unsupported character (${JSON.stringify(tok.text[at])}, character ${at + 1} of the value); allowed: ${TEXT_ALLOWED}`;
	return `the ${flag} value contains credential-like text (a word such as token, password or secret followed by = or :); reword it`;
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
function readOptions(tokens: Tok[], spec: Record<string, ArgKind>, why?: { text?: string }): Record<string, string | true> | undefined {
	const out: Record<string, string | true> = {};
	const fail = (text: string) => { if (why) why.text = text; return undefined; };
	for (let i = 0; i < tokens.length; i++) {
		const flag = tokens[i];
		if (flag.quoted !== "" || !Object.hasOwn(spec, flag.text)) return fail(`${flag.quoted === "" && /^--?[a-z][a-z-]{0,30}$/.test(flag.text) ? `option ${flag.text}` : `argument ${i + 1} after the command`} is not supported here; supported: ${Object.keys(spec).join(", ")}`);
		if (Object.hasOwn(out, flag.text)) return fail(`option ${flag.text} is given more than once`);
		const kind = spec[flag.text];
		if (kind === "none") {
			out[flag.text] = true;
			continue;
		}
		const value = tokens[++i];
		const parsed = value ? argValue(kind, value) : undefined;
		if (parsed === undefined) return fail(value ? valueWhy(flag.text, kind, value) : `option ${flag.text} needs a value`);
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
export function parseDeliveryCommand(command: string, why?: { text?: string }): DeliveryCommand | undefined {
	const t = tokenizeDelivery(command);
	if (!t) return undefined;
	const fail = (text: string) => { if (why) why.text = text; return undefined; };
	const w = (i: number) => (t[i] && t[i].quoted === "" ? t[i].text : undefined);
	const s = (o: Record<string, string | true>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
	if (w(0) !== "gh") return undefined;
	if (w(1) === "pr" && w(2) === "create") {
		const o = readOptions(t.slice(3), { "--repo": "repo", "--base": "branch", "--head": "branch", "--title": "title", "--body": "body", "--body-file": "path" }, why);
		if (!o) return undefined;
		const repo = s(o, "--repo"), base = s(o, "--base"), head = s(o, "--head"), title = s(o, "--title"), body = s(o, "--body"), bodyFile = s(o, "--body-file");
		if (!repo || !base || !head || !title || (body === undefined) === (bodyFile === undefined)) return fail("gh pr create needs --repo, --base, --head, --title and exactly one of --body and --body-file");
		return { kind: "create", repo, base, head, title, body, bodyFile };
	}
	if (w(1) === "pr" && (w(2) === "edit" || w(2) === "merge")) {
		const num = w(3);
		if (!num || !BARE_NUM.test(num)) return fail(`gh pr ${w(2)} needs the PR number right after it`);
		if (w(2) === "edit") {
			const o = readOptions(t.slice(4), { "--repo": "repo", "--title": "title", "--body": "body", "--body-file": "path" }, why);
			if (!o) return undefined;
			const repo = s(o, "--repo"), title = s(o, "--title"), body = s(o, "--body"), bodyFile = s(o, "--body-file");
			if (!repo || (title === undefined && body === undefined && bodyFile === undefined) || (body !== undefined && bodyFile !== undefined)) return fail("gh pr edit needs --repo and --title or one of --body and --body-file");
			return { kind: "edit", pr: Number(num), repo, title, body, bodyFile };
		}
		const o = readOptions(t.slice(4), { "--repo": "repo", "--squash": "none", "--match-head-commit": "sha", "--subject": "subject", "--body": "body", "--body-file": "path" }, why);
		if (!o) return undefined;
		const repo = s(o, "--repo"), sha = s(o, "--match-head-commit"), subject = s(o, "--subject"), body = s(o, "--body"), bodyFile = s(o, "--body-file");
		if (!repo || !sha || o["--squash"] !== true || (body !== undefined && bodyFile !== undefined)) return fail("gh pr merge needs --repo, --squash and --match-head-commit, and at most one of --body and --body-file");
		return { kind: "merge", pr: Number(num), repo, sha, subject, body, bodyFile };
	}
	if (w(1) === "release" && w(2) === "create") {
		const tag = w(3);
		if (!tag || !BARE_VERSION.test(tag)) return fail("gh release create needs the version tag (1.2.3 or v1.2.3) right after it");
		const o = readOptions(t.slice(4), { "--repo": "repo", "--target": "sha", "--title": "title", "--notes": "body", "--notes-file": "path", "--generate-notes": "none", "--latest": "none" }, why);
		if (!o) return undefined;
		const repo = s(o, "--repo"), target = s(o, "--target"), title = s(o, "--title"), notes = s(o, "--notes"), notesFile = s(o, "--notes-file"), generate = o["--generate-notes"] === true;
		if (!repo || !target || !title || [notes !== undefined, notesFile !== undefined, generate].filter(Boolean).length !== 1) return fail("gh release create needs --repo, --target, --title and exactly one of --notes, --notes-file and --generate-notes");
		return { kind: "release", tag, repo, target, title, notes, notesFile, generate, latest: o["--latest"] === true };
	}
	return undefined;
}

/** For a gh PR create/edit/merge or release create that is not an accepted form: what is wrong with it. Undefined for an accepted form or any other command. */
export function deliveryFormWhy(command: string): string | undefined {
	if (!/^gh (pr (create|edit|merge)|release create)( |$)/.test(command)) return undefined;
	const why: { text?: string } = {};
	if (parseDeliveryCommand(command, why) !== undefined) return undefined;
	return why.text ?? "it must be one line of printable ASCII with single spaces between arguments and no chained commands, pipes or redirections";
}

function prView(pr: number, repo: string, live: DeliveryLive): Record<string, unknown> | undefined {
	const view = live.ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "state,baseRefName,headRefName,headRefOid,isCrossRepository,statusCheckRollup"]);
	return view && typeof view === "object" ? (view as Record<string, unknown>) : undefined;
}

// No failed, cancelled or still-running check on the PR head (a repository without checks passes). Any other shape refuses.
const CHECK_OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
export function checksPass(view: Record<string, unknown> | undefined): boolean {
	const rollup = view?.statusCheckRollup;
	if (rollup === undefined || rollup === null) return true;
	if (!Array.isArray(rollup)) return false;
	return rollup.every((c: any) => c && typeof c === "object" && (c.__typename === "StatusContext" ? c.state === "SUCCESS" : c.status === "COMPLETED" && CHECK_OK.has(c.conclusion)));
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

// A later PR head under a merge grant: the clean local candidate on the approved branch is at that head, which descends from the approved SHA.
function followHolds(g: DeliveryGrant, head: string, live: DeliveryLive): boolean {
	const b = g.bound;
	if (!b) return false;
	try {
		const now = (live.follow ?? readFollowState)(g.candidate, [...b.exclude], g.sha);
		return now.ref === b.ref && now.head === head && now.clean && now.descends;
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
			if (c.pr !== g.pr || !fileOk(c.bodyFile)) return false;
			const view = prView(c.pr, g.repo, live);
			if (!openSameRepo(view, g.branch) || view.baseRefName !== g.base || view.headRefOid !== c.sha || !checksPass(view)) return false;
			return c.sha === g.sha ? boundHolds(g, live) : followHolds(g, c.sha, live);
		}
		case "release": {
			// A tag that already exists (status 0) or an unreadable remote refuses: --target is never trusted on an existing tag. No time-based fallback.
			if (g.version !== c.tag || (!g.afterMerge && c.target !== g.sha) || (c.latest && g.latest !== true) || !fileOk(c.notesFile)) return false;
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
		if (g.afterMerge) {
			const view = prView(g.pr, g.repo, live);
			return openSameRepo(view, g.branch) && view.baseRefName === g.base ? undefined : "PR is not open, same-repo, on this branch and base";
		}
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

// ---- Post-merge CHECKOUT cleanup (narrow): exactly `git worktree remove "<abs path>"` for one merged, clean, task-owned checkout, run by a main-launched release-engineer in the primary checkout, outside the target.
// Main's request is only a selector plus a quiescence declaration: the scope is minted after independent live checks and every check runs again before the guard allows the one command. Its artifact folders (_scratch/_evidence) follow under the same scope once the checkout is gone (see ARTIFACT cleanup below).
export const CLEANUP_TTL_MS = 10 * 60_000;
const MAX_CLEANUP_GRANTS = 4;
const CLEANUP_WALK_MAX = 20_000;
const TASK_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CLEANUP_KEYS = "base,branch,candidate,headSha,id,issuedAt,mergeCommit,pr,primary,pushUrl,repo,role";
const CLEANUP_REQUEST_KEYS = "base,branch,checkout,headSha,knowledge,mergeCommit,pr,quiescent";
const PR_CLEANUP_FIELDS = "number,state,baseRefName,headRefName,headRefOid,isCrossRepository,mergeCommit";
export interface CleanupGrant { id: string; role: string; candidate: string; primary: string; pushUrl: string; repo: string; branch: string; base: string; pr: number; headSha: string; mergeCommit: string; issuedAt: number; task?: string; group?: string }
// Plain-branch variant: candidate = primary, plus the task and its artifact group (<primary-parent>/worktrees/<repo>); it covers only the two artifact folders.
const ARTIFACT_GRANT_KEYS = "base,branch,candidate,group,headSha,id,issuedAt,mergeCommit,pr,primary,pushUrl,repo,role,task";
const ARTIFACT_REQUEST_KEYS = "base,branch,headSha,knowledge,mergeCommit,pr,quiescent,task";

const slashed = (p: string) => p.replace(/\\/g, "/");

// Exactly <parent of primary>/worktrees/<basename of primary>/<task>: ASCII forward-slash, no dot segments, 8.3 aliases or underscore-led names (those are the artifact folders).
function cleanupPlacement(candidate: unknown, primary: unknown): boolean {
	const ok = (p: unknown): p is string => typeof p === "string" && p.length <= 240 && PATH_ARG.test(p) && !badSegments(p) && !p.split("/").some((s) => /~\d/.test(s));
	if (!ok(candidate) || !ok(primary)) return false;
	const cut = primary.lastIndexOf("/");
	if (cut <= 0) return false;
	const prefix = `${primary.slice(0, cut)}/worktrees/${primary.slice(cut + 1)}/`;
	if (!normPath(candidate).startsWith(normPath(prefix))) return false;
	const task = candidate.slice(prefix.length);
	return TASK_SEGMENT.test(task) && !/[. ]$/.test(task);
}

// The artifact group of a plain-branch task: exactly <parent of primary>/worktrees/<one segment>, no aliases.
function artifactGroupOk(group: unknown, primary: unknown): boolean {
	if (typeof group !== "string" || typeof primary !== "string" || group.length > 240 || !PATH_ARG.test(group) || badSegments(group) || group.split("/").some((seg) => /~\d/.test(seg))) return false;
	const parent = path.posix.dirname(group);
	return path.posix.basename(parent) === "worktrees" && normPath(path.posix.dirname(parent)) === normPath(path.posix.dirname(primary)) && TASK_SEGMENT.test(path.posix.basename(group));
}

function normalizeCleanup(input: unknown): CleanupGrant {
	const v = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
	const keys = Object.keys(v).sort().join();
	const artifacts = keys === ARTIFACT_GRANT_KEYS;
	if (keys !== CLEANUP_KEYS && !artifacts) throw new TypeError("invalid cleanup scope");
	if (v.role !== LEASE_ROLE || typeof v.id !== "string" || !/^[0-9a-f-]{36}$/.test(v.id)) throw new TypeError("invalid cleanup scope");
	if (artifacts ? !(typeof v.task === "string" && TASK_SEGMENT.test(v.task) && typeof v.primary === "string" && v.candidate === v.primary && PATH_ARG.test(v.primary) && !badSegments(v.primary) && artifactGroupOk(v.group, v.primary)) : !cleanupPlacement(v.candidate, v.primary)) throw new TypeError("invalid cleanup scope");
	assertPushUrl(v.pushUrl as string);
	const repo = parseRepoFromPushUrl(v.pushUrl);
	const branch = validatePushBranch(v.branch as string);
	if (repo === undefined || v.repo !== repo || !baseBranchOk(v.base) || v.base === branch) throw new TypeError("invalid cleanup scope");
	if (typeof v.pr !== "number" || !Number.isSafeInteger(v.pr) || v.pr < 1 || v.pr > 999999999) throw new TypeError("invalid cleanup scope");
	if (typeof v.headSha !== "string" || !BARE_SHA.test(v.headSha) || typeof v.mergeCommit !== "string" || !BARE_SHA.test(v.mergeCommit) || typeof v.issuedAt !== "number" || !Number.isFinite(v.issuedAt)) throw new TypeError("invalid cleanup scope");
	const grant: CleanupGrant = { id: v.id, role: LEASE_ROLE, candidate: v.candidate as string, primary: v.primary as string, pushUrl: v.pushUrl as string, repo, branch, base: v.base, pr: v.pr, headSha: v.headSha, mergeCommit: v.mergeCommit, issuedAt: v.issuedAt };
	if (artifacts) { grant.task = v.task as string; grant.group = v.group as string; }
	return grant;
}

/** What a cleanup scope may remove: the checkout (worktree task) or the task's two artifact folders (plain-branch task). Reserved against new workers. */
export function cleanupTargets(g: CleanupGrant): string[] {
	return g.task !== undefined && g.group !== undefined ? ["_evidence", "_scratch"].map((kind) => `${g.group}/${kind}/${g.task}`) : [g.candidate];
}

// Absent key grants nothing; a present but malformed one fails the whole envelope closed.
export function loadChildCleanup(text: string): CleanupGrant[] {
	const parsed = JSON.parse(text) as { v?: number; cleanupActions?: unknown };
	if (!parsed || parsed.v !== 1) throw new TypeError("invalid grant envelope");
	if (parsed.cleanupActions === undefined) return [];
	if (!Array.isArray(parsed.cleanupActions) || parsed.cleanupActions.length > MAX_CLEANUP_GRANTS) throw new TypeError("invalid cleanup list");
	return parsed.cleanupActions.map(normalizeCleanup);
}

// Exact whole-command form: git worktree remove "<absolute forward-slash path>". No flags, no -C, no second path, no operators.
export function parseCleanupCommand(command: string): string | undefined {
	const t = tokenizeDelivery(command);
	if (!t || t.length !== 4 || t.slice(0, 3).some((tok, i) => tok.quoted !== "" || tok.text !== ["git", "worktree", "remove"][i])) return undefined;
	const p = t[3];
	return p.quoted === '"' && p.text.length <= 240 && PATH_ARG.test(p.text) && !badSegments(p.text) ? p.text : undefined;
}

// The primary checkout a linked worktree belongs to: the parent of its git common dir (which must be named .git). Undefined when it cannot be proven.
function primaryOf(candidate: string): string | undefined {
	const common = gitRead(candidate, ["rev-parse", "--git-common-dir"]);
	if (common?.length !== 1) return undefined;
	const dir = canonicalCwd(path.resolve(candidate, common[0]));
	return path.basename(dir).toLowerCase() === ".git" ? slashed(path.dirname(dir)) : undefined;
}

// Field report: after a merge the task checkout was always retained, because any build or test run leaves ignored output and all
// ignored content was kept. A folder with one of these names is regenerable output when Git itself reports that whole folder as
// ignored; it is then removed with the checkout. Any other ignored content (.env files, local databases, logs) still retains it.
const BUILD_DIRS = new Set(["target", "node_modules", "dist", "build", "out", "bin", "obj", "coverage", ".serena", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".turbo", ".cache", ".gradle"]);

// With `skipped`, a real directory named like build output is recorded (relative, forward slashes) and not entered; the caller must
// then prove Git ignores each one as a whole. Without it every entry is walked.
function walkCheckout(root: string, skipped?: string[]): string | undefined {
	let seen = 0;
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (dir === root && e.name === ".git") continue;
			if (++seen > CLEANUP_WALK_MAX) return "checkout is too large to verify";
			const full = path.join(dir, e.name);
			if (e.isSymbolicLink()) return "checkout contains a link";
			if (e.name === ".git" || (dir === root && e.name === ".gitmodules")) return "checkout contains a nested repository or submodule";
			if (e.isDirectory() && skipped && BUILD_DIRS.has(e.name)) skipped.push(path.relative(root, full).replace(/\\/g, "/"));
			else if (e.isDirectory()) stack.push(full);
			else if (!e.isFile() || fs.lstatSync(full).nlink !== 1) return "checkout contains a hard link or special file";
		}
	}
	return undefined;
}

// Independent live proof for one cleanup scope; mint and guard both call it. Returns a fixed refusal reason, or undefined when the checkout is exactly the merged, clean, unlinked, unlocked task checkout. Any read problem refuses.
export function verifyCleanup(g: CleanupGrant, live: DeliveryLive = defaultDeliveryLive(livePushUrl)): string | undefined {
	try {
		if (redirectedGitEnvironment()) return "git environment is redirected";
		const env = live.env();
		if (env.GH_HOST !== undefined || env.GH_REPO !== undefined) return "gh environment is redirected";
		// Slow independent PR read FIRST (grant fields only): every local proof below runs after it, so nothing validated can go stale during the subprocess. The guard-to-shell window remains (not atomic).
		const pr = live.ghJson(["pr", "view", String(g.pr), "--repo", g.repo, "--json", PR_CLEANUP_FIELDS]) as Record<string, any> | undefined;
		if (!pr || typeof pr !== "object" || Array.isArray(pr)) return "the PR could not be read";
		if (pr.number !== g.pr || pr.state !== "MERGED" || pr.isCrossRepository !== false || pr.headRefName !== g.branch || pr.baseRefName !== g.base) return "the PR is not merged from this same-repo branch and base";
		if (pr.headRefOid !== g.headSha || pr.mergeCommit?.oid !== g.mergeCommit) return "the PR head or merge commit differs from the approved ones";
		const { candidate, primary } = g;
		if (!cleanupPlacement(candidate, primary)) return "checkout is not exactly worktrees/<repo>/<task> of the primary checkout";
		for (const p of [candidate, primary]) {
			const st = fs.lstatSync(p);
			if (!st.isDirectory() || st.isSymbolicLink()) return "path is not a plain directory";
			if (normPath(fs.realpathSync.native(p)) !== normPath(p)) return "path is an alias or link";
		}
		if (!fs.lstatSync(path.join(candidate, ".git")).isFile() || !fs.lstatSync(path.join(primary, ".git")).isDirectory()) return "checkout is not a linked worktree of the primary";
		const top = gitRead(candidate, ["rev-parse", "--show-toplevel"]);
		if (top?.length !== 1 || normPath(canonicalCwd(top[0])) !== normPath(candidate)) return "not the repository root of the checkout";
		if (primaryOf(candidate) === undefined || normPath(primaryOf(candidate)!) !== normPath(primary)) return "checkout does not belong to the primary checkout";
		const ref = gitRead(candidate, ["symbolic-ref", "-q", "HEAD"]);
		if (ref?.length !== 1 || ref[0] !== `refs/heads/${g.branch}`) return "HEAD is not attached to the approved branch";
		const head = gitRead(candidate, ["rev-parse", "HEAD"]);
		if (head?.length !== 1 || head[0] !== g.headSha) return "checkout HEAD differs from the approved PR head";
		if (live.pushUrl(candidate, g.branch) !== g.pushUrl || parseRepoFromPushUrl(g.pushUrl) !== g.repo) return "origin binding differs from the approved one";
		// Removal runs with cwd = primary: a primary-only local/worktree/conditional-include fsmonitor would execute and the target preflight below cannot see it. Config query only; no status or walk of unrelated primary state.
		try { assertNoRepoFsmonitor(primary); } catch { return "primary checkout fsmonitor configuration is not provable or would run a program during removal"; }
		const list = gitRead(primary, ["worktree", "list", "--porcelain"]);
		if (!list) return "registrations could not be read";
		const entries: { path: string; flags: Set<string>; branch?: string }[] = [];
		for (const line of list) {
			if (line.startsWith("worktree ")) entries.push({ path: line.slice(9), flags: new Set() });
			else if (entries.length && line.startsWith("branch ")) entries[entries.length - 1].branch = line.slice(7);
			else if (entries.length) entries[entries.length - 1].flags.add(line.split(" ")[0]);
		}
		const self = entries.filter((e) => normPath(e.path) === normPath(candidate));
		if (self.length !== 1 || ["locked", "prunable", "detached", "bare"].some((f) => self[0].flags.has(f)) || self[0].branch !== `refs/heads/${g.branch}`) return "registration is missing, locked, prunable or detached";
		if (entries.some((e) => e !== self[0] && overlaps(e.path, candidate) && normPath(e.path) !== normPath(primary))) return "nested or overlapping registered checkout";
		// Hardened local proof, shared with delivery fingerprints: refuses candidate-controlled programs (filters), hidden/skipped/sparse index states, gitlinks and linked directories BEFORE any Git command reads the working tree. fsmonitor is disabled inside the helper.
		try { checkoutPreflight(candidate); } catch { return "checkout state is not provable (filters, hidden or sparse index entries, submodules or links)"; }
		const buildDirs: string[] = [];
		const walked = walkCheckout(candidate, buildDirs);
		if (walked) return walked;
		let status: string[];
		try { status = hardenedGit(candidate, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]).toString("utf8").split(" ").filter(Boolean); } catch { return "git status could not be read"; }
		// The only ignored content allowed is whole build-output folders, and every folder the walk skipped must be one of them.
		const ignored = status.filter((line) => line.startsWith("!! ")).map((line) => line.slice(3));
		if (ignored.some((entry) => !entry.endsWith("/") || !buildDirs.includes(entry.slice(0, -1)))) return "ignored content is retained: only whole ignored build-output folders (target, node_modules, dist and similar) are assumed disposable";
		if (buildDirs.some((dir) => !ignored.includes(`${dir}/`))) return "a folder named like build output is not ignored by Git as a whole, so its content was not verified";
		if (status.length > ignored.length) return "tracked or untracked changes are present";
		return undefined;
	} catch {
		return "live state could not be read";
	}
}

export interface CleanupDeps { store: GrantStore; owners: OwnerTracker; live?: DeliveryLive; primary: string; mainCwd: string; jobRunning(jobId: string): boolean }

// Main-side mint, called from the subagent launch. The request is a selector and a quiescence declaration, never proof: ownership comes from the runtime tracker, everything else from live git and gh.
// Plain-branch task: the folders come from the artifact directory the operator saw in this session's merge approval, never from the
// request alone, so a task name cannot select another task's folders. The PR must be merged live, exactly as approved.
function prepareArtifactCleanup(r: Record<string, unknown>, deps: CleanupDeps, live: DeliveryLive): { ok: true; grant: CleanupGrant } | { ok: false; reason: string } {
	const refuse = (reason: string) => ({ ok: false as const, reason });
	if (r.quiescent !== true) return refuse("main must declare the artifact folders quiescent (quiescent: true)");
	if (typeof r.task !== "string" || !TASK_SEGMENT.test(r.task)) return refuse("task must be one folder name");
	const primary = slashed(canonicalCwd(deps.primary));
	const top = gitRead(primary, ["rev-parse", "--show-toplevel"]);
	if (top?.length !== 1 || normPath(slashed(canonicalCwd(top[0]))) !== normPath(primary) || primaryOf(primary) === undefined || normPath(primaryOf(primary)!) !== normPath(primary)) return refuse("the launch folder is not a primary checkout root");
	const branch = validatePushBranch(r.branch as string);
	const approved = deps.store.listDelivery().find((d) => d.action === "merge" && normPath(slashed(d.candidate)) === normPath(primary) && d.branch === branch && d.base === r.base && d.pr === r.pr && d.sha === r.headSha);
	if (!approved) return refuse("no merge approval in this session matches this primary checkout, branch, base, PR and head");
	const dir = approved.artifactDir === undefined ? undefined : slashed(approved.artifactDir);
	if (dir === undefined || !/\/_(?:evidence|scratch)\/[^/]+$/.test(dir) || path.posix.basename(dir) !== r.task) return refuse("the merge approval names no artifact directory for this task");
	const group = path.posix.dirname(path.posix.dirname(dir));
	const pushUrl = live.pushUrl(primary, branch);
	if (pushUrl === undefined || pushUrl !== approved.pushUrl) return refuse("origin binding differs from the approved one");
	const grant = normalizeCleanup({ id: randomUUID(), role: LEASE_ROLE, candidate: primary, primary, pushUrl, repo: parseRepoFromPushUrl(pushUrl), branch, base: r.base, pr: r.pr, headSha: r.headSha, mergeCommit: r.mergeCommit, issuedAt: live.now?.() ?? Date.now(), task: r.task, group });
	const main = slashed(canonicalCwd(deps.mainCwd));
	for (const folder of cleanupTargets(grant)) {
		if (overlaps(main, folder)) return refuse("the main session runs inside an artifact folder");
		if (deps.owners.reserved(folder)) return refuse("a cleanup for this task is already pending");
		const busy = deps.owners.active(folder, deps.jobRunning);
		if (busy) return refuse(busy);
	}
	if (redirectedGitEnvironment()) return refuse("git environment is redirected");
	const env = live.env();
	if (env.GH_HOST !== undefined || env.GH_REPO !== undefined) return refuse("gh environment is redirected");
	const pr = live.ghJson(["pr", "view", String(grant.pr), "--repo", grant.repo, "--json", PR_CLEANUP_FIELDS]) as Record<string, any> | undefined;
	if (!pr || typeof pr !== "object" || Array.isArray(pr)) return refuse("the PR could not be read");
	if (pr.number !== grant.pr || pr.state !== "MERGED" || pr.isCrossRepository !== false || pr.headRefName !== grant.branch || pr.baseRefName !== grant.base) return refuse("the PR is not merged from this same-repo branch and base");
	if (pr.headRefOid !== grant.headSha || pr.mergeCommit?.oid !== grant.mergeCommit) return refuse("the PR head or merge commit differs from the approved ones");
	deps.store.addCleanupGrant(grant);
	return { ok: true, grant };
}

// Field report: cleanup deletes the task's checkout and its _evidence and _scratch folders, the only place a lesson's evidence lives,
// and nothing made main settle the LEARN checkpoint first. The request now carries it: NO LESSON, or the saved record, which must
// exist outside everything the cleanup deletes. The runtime cannot judge whether a lesson existed; it only refuses an unsettled one.
// A saved record is one file in docs/knowledge/, committed with the task's PR: inside the task checkout it is durable only when the
// approved PR head contains it (the cleanup then proves that head merged); anywhere else it must exist on disk.
function knowledgeWhy(knowledge: unknown, checkout: string | undefined, primary: string, headSha: unknown): string | undefined {
	const need = "cleanup needs the LEARN checkpoint in knowledge: the exact text NO LESSON, or the absolute path of the saved knowledge record; settle LEARN first (a BLOCKED checkpoint keeps the folders)";
	if (typeof knowledge !== "string" || !knowledge.trim()) return need;
	if (knowledge === "NO LESSON") return undefined;
	if (!path.isAbsolute(knowledge) || !/\.md$/i.test(knowledge)) return need;
	const record = normPath(slashed(knowledge));
	if (/\/_(evidence|scratch)(\/|$)/.test(record)) return "the knowledge record lies inside a folder this cleanup deletes; save it in docs/knowledge/ and commit it with the PR";
	for (const root of [checkout, primary]) {
		if (root === undefined || !record.startsWith(normPath(slashed(root)) + "/")) continue;
		const rel = slashed(knowledge).slice(slashed(root).length + 1);
		let committed = false;
		try { committed = typeof headSha === "string" && BARE_SHA.test(headSha) && gitExit(root, ["cat-file", "-e", `${headSha}:${rel}`]) === 0; } catch { committed = false; }
		if (committed) return undefined;
		if (root === checkout) return "the knowledge record lies inside the checkout this cleanup deletes and is not committed in the PR head; commit it with the PR (docs/knowledge/) first";
		break;
	}
	try { const st = fs.lstatSync(knowledge); if (!st.isFile() || st.size < 1) return "the knowledge record is not a non-empty regular file"; } catch { return "the knowledge record does not exist; SAVED needs the written record and its readback before cleanup"; }
	return undefined;
}

export function prepareCleanup(request: unknown, deps: CleanupDeps): { ok: true; grant: CleanupGrant } | { ok: false; reason: string } {
	const refuse = (reason: string) => ({ ok: false as const, reason });
	const live = deps.live ?? defaultDeliveryLive(livePushUrl);
	try {
		const r = (request && typeof request === "object" && !Array.isArray(request) ? request : {}) as Record<string, unknown>;
		const unsaved = knowledgeWhy(r.knowledge, typeof r.checkout === "string" ? r.checkout : undefined, deps.primary, r.headSha);
		if (unsaved) return refuse(unsaved);
		if (Object.keys(r).filter((k) => r[k] !== undefined).sort().join() === ARTIFACT_REQUEST_KEYS) return prepareArtifactCleanup(r, deps, live);
		if (Object.keys(r).filter((k) => r[k] !== undefined).sort().join() !== CLEANUP_REQUEST_KEYS) return refuse("cleanup needs exactly checkout (worktree task) or task (plain-branch task), plus branch, base, pr, headSha, mergeCommit and quiescent, and knowledge");
		if (r.quiescent !== true) return refuse("main must declare the checkout quiescent (quiescent: true)");
		if (typeof r.checkout !== "string" || !cleanupPlacement(r.checkout, slashed(canonicalCwd(deps.primary)))) return refuse("checkout is not exactly worktrees/<repo>/<task> of the launch primary");
		const candidate = slashed(canonicalCwd(r.checkout));
		if (normPath(candidate) !== normPath(r.checkout)) return refuse("checkout path is not canonical");
		const primary = primaryOf(candidate);
		if (primary === undefined || normPath(primary) !== normPath(slashed(canonicalCwd(deps.primary)))) return refuse("the launch folder is not the primary checkout of this checkout");
		const main = slashed(canonicalCwd(deps.mainCwd));
		if (normPath(main) === normPath(candidate) || normPath(main).startsWith(`${normPath(candidate)}/`)) return refuse("the main session runs inside the target");
		const branch = validatePushBranch(r.branch as string);
		const pushUrl = live.pushUrl(candidate, branch);
		if (pushUrl === undefined) return refuse("the checkout has no verifiable origin binding");
		const grant = normalizeCleanup({ id: randomUUID(), role: LEASE_ROLE, candidate, primary, pushUrl, repo: parseRepoFromPushUrl(pushUrl), branch, base: r.base, pr: r.pr, headSha: r.headSha, mergeCommit: r.mergeCommit, issuedAt: live.now?.() ?? Date.now() });
		if (deps.owners.reserved(candidate)) return refuse("a cleanup for this checkout is already pending");
		const owner = deps.owners.check(candidate, deps.jobRunning);
		if (owner) return refuse(owner);
		const why = verifyCleanup(grant, live);
		if (why) return refuse(why);
		deps.store.addCleanupGrant(grant);
		return { ok: true, grant };
	} catch (error) {
		return refuse(error instanceof RangeError || error instanceof TypeError ? `cleanup request is invalid: ${error.message}` : "live state could not be read");
	}
}

// Child guard: exact form, only GIT_DESTRUCTIVE, cwd is the primary and outside the target, scope present and fresh, live proof holds. Consumes the scope on allow, so a second attempt (replay) is denied.
function cleanupAllows(store: GrantStore, decision: Extract<Decision, { action: "block" }>, live: DeliveryLive): boolean {
	if (decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "GIT_DESTRUCTIVE") return false;
	const target = parseCleanupCommand(decision.op.command);
	if (!target) return false;
	try {
		const grant = store.findCleanup(target);
		if (!grant || (live.now?.() ?? Date.now()) - grant.issuedAt > CLEANUP_TTL_MS) return false;
		if (normPath(decision.op.cwd) !== normPath(grant.primary) || overlaps(decision.op.cwd, grant.candidate)) return false;
		if (verifyCleanup(grant, live) !== undefined) return false;
		if (!store.takeCleanup(grant.id)) return false;
		const issuedAt = live.now?.() ?? Date.now();
		store.addArtifactCleanup(artifactFolders(grant.candidate).map((folder) => ({ path: folder, candidate: grant.candidate, primary: grant.primary, issuedAt })));
		return true;
	} catch {
		return false;
	}
}

// ---- Post-merge ARTIFACT cleanup: after the guard allowed the exact checkout removal, the same scope covers that task's two artifact
// folders, <worktrees>/<repo>/_evidence/<task> and _scratch/<task>, with one exact removal each. A folder is removable only once the checkout
// and its registration are gone, from the primary as cwd, and only when it is a plain directory holding no links, hard links or special files.
export interface ArtifactCleanup { path: string; candidate?: string; primary: string; issuedAt: number } // no candidate: plain-branch task, nothing to remove first

/** The two artifact folders of a task checkout `<group>/<task>`: `<group>/_evidence/<task>` and `<group>/_scratch/<task>`. */
export function artifactFolders(candidate: string): string[] {
	const c = slashed(candidate).replace(/\/+$/, "");
	const task = path.posix.basename(c);
	const group = path.posix.dirname(c);
	return ["_evidence", "_scratch"].map((kind) => `${group}/${kind}/${task}`);
}

// Exact whole-command forms, one folder each: bash `rm -rf "<abs path>"`, PowerShell `Remove-Item -LiteralPath "<abs path>" -Recurse -Force`.
export function parseArtifactRemoval(command: string): string | undefined {
	const t = tokenizeDelivery(command);
	if (!t) return undefined;
	const bare = (i: number, word: string) => t[i].quoted === "" && t[i].text === word;
	let target: Tok | undefined;
	if (t.length === 3 && bare(0, "rm") && bare(1, "-rf")) target = t[2];
	else if (t.length === 5 && bare(0, "Remove-Item") && bare(1, "-LiteralPath") && bare(3, "-Recurse") && bare(4, "-Force")) target = t[2];
	if (!target || target.quoted !== '"' || target.text.length > 240 || !PATH_ARG.test(target.text) || badSegments(target.text)) return undefined;
	return target.text;
}

/** Live proof for one artifact folder; returns a refusal reason, or undefined when the folder may be removed. Any read problem refuses. */
export function verifyArtifactCleanup(a: ArtifactCleanup): string | undefined {
	try {
		if (redirectedGitEnvironment()) return "git environment is redirected";
		if (a.candidate !== undefined) {
			const checkout = a.candidate;
			if (fs.existsSync(checkout)) return "the task checkout still exists; remove it first";
			const list = gitRead(a.primary, ["worktree", "list", "--porcelain"]);
			if (!list) return "registrations could not be read";
			if (list.some((line) => line.startsWith("worktree ") && normPath(line.slice(9)) === normPath(checkout))) return "the task checkout is still registered";
		}
		const st = fs.lstatSync(a.path);
		if (!st.isDirectory() || st.isSymbolicLink()) return "artifact folder is not a plain directory";
		if (normPath(slashed(fs.realpathSync.native(a.path))) !== normPath(a.path)) return "artifact folder is an alias or link";
		return walkCheckout(a.path);
	} catch {
		return "artifact folder state could not be read";
	}
}

// Child guard: exact form, only DESTRUCTIVE_FS, cwd is the primary and outside the folder, entry present and fresh, live proof holds. Consumes the entry.
function artifactCleanupAllows(store: GrantStore, decision: Extract<Decision, { action: "block" }>, live: DeliveryLive): boolean {
	if (decision.op.kind !== "shell" || decision.rules.length !== 1 || decision.rules[0] !== "DESTRUCTIVE_FS") return false;
	const target = parseArtifactRemoval(decision.op.command);
	if (!target) return false;
	try {
		const entry = store.takeArtifactCleanup(target);
		if (!entry) return false;
		const fresh = (live.now?.() ?? Date.now()) - entry.issuedAt <= CLEANUP_TTL_MS;
		const placed = normPath(decision.op.cwd) === normPath(entry.primary) && !overlaps(decision.op.cwd, entry.path);
		if (fresh && placed && verifyArtifactCleanup(entry) === undefined) return true;
		store.addArtifactCleanup([entry]); // a refused attempt consumes nothing
		return false;
	} catch {
		return false;
	}
}

export interface CleanupPendingEntry { state: "PENDING_UNVERIFIED" | "RETAINED"; checkout?: string; task?: string; reason?: string; request?: { checkout?: string; task?: string; branch: string; base: string; pr: number; headSha: string }; retainedArtifacts: { path: string; reason: string }[] }

// Discovery is advisory and must stay cheap: a bounded projection of in-memory runtime records (merge delivery grants this session issued, owner tracker). ZERO Git, gh, subprocess or filesystem I/O, because it runs on every background completion and list. It never claims READY or MERGED and omits mergeCommit and launchCwd: main obtains those with its own explicit live PR query when it schedules cleanup, and prepareCleanup and the child guard independently re-verify everything live.
export function cleanupPending(store: GrantStore, owners: OwnerTracker, jobRunning: (jobId: string) => boolean): CleanupPendingEntry[] {
	const out: CleanupPendingEntry[] = [];
	const seen = new Set<string>();
	for (const d of store.listDelivery()) {
		if (d.action !== "merge") continue;
		try {
			const candidate = d.candidate.replace(/\\/g, "/").replace(/\/+$/, "");
			if (seen.has(normPath(candidate))) continue;
			seen.add(normPath(candidate));
			if (path.posix.basename(path.posix.dirname(path.posix.dirname(candidate))) !== "worktrees") {
				// Plain-branch task (candidate = primary): only the artifact folders the merge approval named, never the primary checkout.
				const dir = d.artifactDir?.replace(/\\/g, "/");
				if (dir === undefined || !/\/_(?:evidence|scratch)\/[^/]+$/.test(dir)) continue;
				const task = path.posix.basename(dir);
				const group = path.posix.dirname(path.posix.dirname(dir));
				const artifacts = ["_evidence", "_scratch"].map((kind) => ({ path: `${group}/${kind}/${task}`, reason: "plain-branch task: removed by a task cleanup once the knowledge checkpoint is SAVED outside every target or NO LESSON" }));
				const busy = artifacts.map((a) => owners.active(a.path, jobRunning)).find(Boolean);
				out.push(busy === undefined ? { state: "PENDING_UNVERIFIED", task, request: { task, branch: d.branch, base: d.base, pr: d.pr, headSha: d.sha }, retainedArtifacts: artifacts } : { state: "RETAINED", task, reason: busy, retainedArtifacts: artifacts });
				continue;
			}
			const task = path.posix.basename(candidate);
			const group = path.posix.dirname(candidate);
			const retainedArtifacts = ["_evidence", "_scratch"].map((kind) => ({ path: `${group}/${kind}/${task}`, reason: "removed by the same cleanup after the checkout, once the knowledge checkpoint is SAVED outside every target or NO LESSON" }));
			const why = owners.check(candidate, jobRunning);
			out.push(why === undefined ? { state: "PENDING_UNVERIFIED", checkout: candidate, request: { checkout: candidate, branch: d.branch, base: d.base, pr: d.pr, headSha: d.sha }, retainedArtifacts } : { state: "RETAINED", checkout: candidate, reason: why, retainedArtifacts });
		} catch { /* unknown state is not pending */ }
	}
	return out;
}

export function formatCleanupPending(entries: CleanupPendingEntry[]): string {
	if (!entries.length) return "";
	return ["CLEANUP_PENDING (runtime metadata only: no live Git or PR check was made and nothing here is verified, merged or ready; derived from this session's merge grants and worker records, not from child text). Once the release-engineer has reported the PR merged, cleanup is part of finishing the task, before the completion report (skip it only when the user said to keep the folders): for each PENDING_UNVERIFIED entry main queries the PR live for mergeCommit and the primary checkout, then launches ONE release-engineer via subagent (single mode, cwd = primary, outside the target) with cleanup = request plus mergeCommit, quiescent: true and knowledge, only after its own quiescence check and after the LEARN checkpoint is settled (knowledge = the exact text NO LESSON, or the absolute path of the saved record: the docs/knowledge file committed with the PR, never one under _evidence or _scratch; the folders hold the task's evidence, so decide before they are deleted, and with a BLOCKED checkpoint keep them); the launch verifies everything live and refuses otherwise. RETAINED entries stay; name each one and its reason in the completion report, and report a refused cleanup launch the same way. A worktree entry's cleanup removes the checkout, then its artifact folders; a plain-branch entry (task, no checkout) removes only the artifact folders its merge approval named.", ...entries.map((e) => JSON.stringify(e))].join("\n");
}

/** A worker's guard announces each single-use approval it used, so main can take back the unused ones when the worker exits. */
export const GRANT_USED_PREFIX = "pi-worker-grant-used ";

export interface ChildGuardLaunch {
	entry: string;
	grantCount: number;
	claimed: GrantRecord[]; // the single-use grants this launch took (main lends them, see GrantStore.lend)
	leaseCount: number;
	deliveryCount: number;
	cleanupCount: number; // 1 only for the launch that actually claimed the cleanup scope
	gateCommits: boolean;
	childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

// One logical child job's claim window. Its first actual spawn closes the window, even when no grant exists or the spawn fails; fallback spawns of that job never claim.
export interface ClaimWindow { open: boolean; claimed?: number }

// Claims this role's grants for one child spawn (single use) and returns the guard entry plus the child's environment.
export function claimChildGuard(store: GrantStore, role: string, candidate: string, guardFile: string, window: ClaimWindow = { open: true }, withLeases = false, prBase?: string, cleanupId?: string): ChildGuardLaunch {
	if (!fs.existsSync(guardFile)) throw new Error("Safety guard missing: child launch refused (fail closed).");
	// A cleanup launch is its own context: trusted release-engineer only, started in the primary and outside the target, never combined with a PR base. Every refusal precedes the claim.
	if (cleanupId !== undefined) {
		const scope = store.peekCleanup(cleanupId);
		if (!(withLeases && role === LEASE_ROLE) || prBase !== undefined) throw new RangeError("cleanup needs a trusted release-engineer launch without a PR base");
		if (!scope) throw new RangeError("cleanup scope is missing, expired or revoked");
		const cwd = canonicalCwd(candidate);
		if (normPath(cwd) !== normPath(scope.primary) || cleanupTargets(scope).some((target) => overlaps(cwd, target))) throw new RangeError("cleanup must be launched in the primary checkout, outside the target");
	}
	// A supplied PR base narrows the trusted release-engineer context only. Refuse before any grant is claimed or the window closes.
	if (prBase !== undefined && (!(withLeases && role === LEASE_ROLE) || !baseBranchOk(prBase))) throw new RangeError("prBase needs a trusted release-engineer launch and a valid branch name");
	// Lease copies are non-consuming: every legitimate release-engineer spawn of this candidate gets them, including fallback and later spawns.
	const leases = withLeases && role === LEASE_ROLE && cleanupId === undefined ? store.copyLeases(canonicalCwd(candidate)) : [];
	// Delivery copies follow the lease rule: non-consuming, release-engineer only, same absolute expiry for every spawn of this candidate.
	const delivery = withLeases && role === LEASE_ROLE && cleanupId === undefined ? store.copyDelivery(canonicalCwd(candidate)) : [];
	// Normal commits are gated only in the trusted release-engineer launch (same trust signal as the lease copies).
	const gateCommits = withLeases && role === LEASE_ROLE;
	let pushTarget: PushTarget | undefined;
	if (gateCommits && cleanupId === undefined && !redirectedGitEnvironment()) {
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
	if (mayClaim) window.claimed = claimed.length;
	// Field report: a worker refused for an approved command could not tell why; the launch now carries the reason it received none.
	const grantNote = claimed.length ? undefined : !mayClaim && (window.claimed ?? 0) > 0
		? "this is a retry or fallback attempt of the job, and its single-use approvals went to the first attempt; an approval it did not use returns to main when it exits, so ask main to launch again (or request the approval again if it was used)"
		: mayClaim ? store.claimHint?.(role, canonicalCwd(candidate)) : undefined;
	const cleanup = mayClaim && cleanupId !== undefined ? [store.claimCleanup(cleanupId)].filter((c): c is CleanupGrant => c !== undefined) : [];
	const value = claimed.length || leases.length || delivery.length || cleanup.length || gateCommits ? serializeGrants(claimed, leases, delivery, gateCommits, pushTarget, cleanup) : undefined;
	return {
		entry: guardFile,
		grantCount: claimed.length,
		claimed,
		leaseCount: leases.length,
		deliveryCount: delivery.length,
		cleanupCount: cleanup.length,
		gateCommits,
		childEnv(base) {
			const env: NodeJS.ProcessEnv = { ...base };
			delete env[CHILD_GRANT_ENV];
			delete env[CHILD_GRANT_NOTE_ENV];
			if (value !== undefined) env[CHILD_GRANT_ENV] = value;
			if (grantNote !== undefined) env[CHILD_GRANT_NOTE_ENV] = grantNote.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 400);
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
	const check = commitTargetCheck(target, root, liveUrl);
	return "branch" in check ? check.branch : undefined;
}
// Field report: a trusted release-engineer concluding an integration merge (MERGE_HEAD present) at the right root on the right branch was
// told "a normal commit is automatic only with cwd = the candidate root on its feature branch", and the root and branch were checked by
// hand before anyone found the merge state. Each refusal now names the condition that failed.
const GIT_STATE_LABEL: Record<string, string> = { MERGE_HEAD: "a merge", CHERRY_PICK_HEAD: "a cherry-pick", REVERT_HEAD: "a revert", "rebase-merge": "a rebase", "rebase-apply": "a rebase or git am", sequencer: "a multi-commit cherry-pick or revert" };
function commitTargetCheck(target: { candidate: string; pushUrl: string; branch: string; base?: string }, root: string, liveUrl: (candidate: string, branch: string) => string | undefined): { branch: string } | { why: string } {
	if (foldPath(canonicalCwd(root)) !== foldPath(target.candidate)) return { why: `this folder (${slashed(root)}) is not the candidate root this worker was launched for (${slashed(target.candidate)}); run it from there` };
	if (redirectedGitEnvironment()) return { why: "Git is redirected by environment variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_* or similar); unset them" };
	const top = gitRead(root, ["rev-parse", "--show-toplevel"]);
	if (top?.length !== 1) return { why: "git could not read this folder as a repository" };
	if (foldPath(canonicalCwd(top[0])) !== foldPath(root)) return { why: `this folder is inside the repository whose top level is ${slashed(top[0])}, not at its root; run it from the candidate root` };
	const head = gitRead(root, ["symbolic-ref", "-q", "HEAD"]);
	if (head?.length !== 1 || !head[0].startsWith("refs/heads/")) return { why: "HEAD is not on a branch (detached); check out the feature branch" };
	const branch = validatePushBranch(head[0].slice("refs/heads/".length));
	if (branch !== target.branch) return { why: `the checked-out branch is ${branch}, not the launch's feature branch ${target.branch}` };
	if (liveUrl(root, branch) !== target.pushUrl) return { why: `the push URL of ${branch} no longer matches the one this worker was launched with` };
	const gitDir = gitRead(root, ["rev-parse", "--absolute-git-dir"]);
	if (gitDir?.length !== 1) return { why: "git could not report the repository's .git folder" };
	const states = UNSAFE_GIT_STATE.filter((s) => fs.existsSync(path.join(gitDir[0], s)));
	if (states.length === 1 && states[0] === "MERGE_HEAD") {
		const notBase = baseMergeRefusal(root, gitDir[0], target);
		if (notBase === undefined) return { branch };
		return { why: `a merge is in progress (MERGE_HEAD in ${slashed(gitDir[0])}) and ${notBase}: only a merge of the PR's base branch concludes automatically; any other merge records another history, so ask main to request a single-use approval for this exact command` };
	}
	const state = states[0];
	if (state) return { why: `${GIT_STATE_LABEL[state]} is in progress (${state} in ${slashed(gitDir[0])}): a commit that concludes it records another history, so it is not a normal commit; ask main to request a single-use approval for this exact command` };
	return { branch };
}
// Owner decision (field report: an integration merge of the base into the feature branch needed a single-use approval): a trusted
// release-engineer may conclude a merge automatically when it merges exactly one commit that the remote's base branch already contains,
// that is, it brings the PR's own base into the feature branch, which the PR's review and checks then cover. The base is the one main
// bound at launch, else origin's default branch. Undefined when allowed; otherwise why not.
function baseMergeRefusal(root: string, gitDir: string, target: { branch: string; base?: string }): string | undefined {
	let heads: string[];
	try { heads = fs.readFileSync(path.join(gitDir, "MERGE_HEAD"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { return "MERGE_HEAD cannot be read"; }
	if (heads.length !== 1 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(heads[0])) return "it merges more than one commit";
	let base = target.base;
	if (base === undefined) {
		const remoteHead = gitRead(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
		base = remoteHead?.length === 1 && remoteHead[0].startsWith("refs/remotes/origin/") ? remoteHead[0].slice("refs/remotes/origin/".length) : undefined;
	}
	if (base === undefined) return "no base branch is known (none was bound at launch and origin has no default branch)";
	if (!baseBranchOk(base)) return `the base branch name ${base} is not valid`;
	if (base === target.branch) return "the base branch is the feature branch itself";
	const ref = `refs/remotes/origin/${base}`;
	if (gitExit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== 0) return `origin/${base} is not fetched here`;
	if (gitExit(root, ["merge-base", "--is-ancestor", heads[0], ref]) !== 0) return `the merged commit is not on origin/${base}`;
	return undefined;
}
/** Why a trusted release-engineer's normal commit was not automatic, for the refusal text; undefined when the cause is not one of these. */
export function commitRefusalWhy(target: { candidate: string; pushUrl: string; branch: string } | undefined, command: string, root: string, liveUrl: (candidate: string, branch: string) => string | undefined): string | undefined {
	if (!target) return "this worker was launched without a feature-branch push target, so no commit is automatic; ask main";
	const normal = parseNormalCommit(command);
	if (!normal) return undefined;
	try {
		const check = commitTargetCheck(target, root, liveUrl);
		if ("why" in check) return check.why;
		if (normal.file !== undefined && !automaticArtifactAllowed(normal.file, target)) return `the -F message file ${normal.file} is not in this task's _scratch or _evidence folder next to the candidate; write it there`;
	} catch { return undefined; }
	return undefined;
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
// ---- Redacted .env read: `node "<this folder>/read-env-redacted.mjs" "<absolute .env path>"` is the one way an agent may see .env settings.
// The script prints keys with secret-like values hidden. Allowed only in that exact form and only while the script's bytes match the pinned
// digest, so an edited copy cannot turn it into a raw read. Every other .env read or write stays SECRET (never grantable).
export const REDACTED_ENV_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "read-env-redacted.mjs").replace(/\\/g, "/");
export const REDACTED_ENV_SCRIPT_SHA256 = "ea8cbec2847ecb35c93596024170ceda229ef090ef3942824cd969137321b336";
export function redactedEnvRead(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const t = tokenizeDelivery(String(input?.command ?? ""));
	if (!t || t.length !== 3 || t[0].quoted !== "" || t[0].text !== "node" || t[1].quoted !== '"' || t[2].quoted !== '"') return false;
	if (normPath(t[1].text) !== normPath(REDACTED_ENV_SCRIPT)) return false;
	const target = t[2].text;
	if (!PATH_ARG.test(target) || badSegments(target) || !/^\.env(\..+)?$/.test(path.posix.basename(target))) return false;
	try {
		return createHash("sha256").update(fs.readFileSync(REDACTED_ENV_SCRIPT).toString("latin1").replace(/\r\n/g, "\n"), "latin1").digest("hex") === REDACTED_ENV_SCRIPT_SHA256;
	} catch {
		return false;
	}
}

// ---- Read-only roles (capability-scoped, CapScope-style): a worker whose role has no edit/write tool, or whose launch declared
// readOnly, may not change its candidate checkout through the shell either. Lexical and best-effort like the rest of the guard: it covers
// redirections, file-writing commands, in-place editors, mutating git and package-manager subcommands, and edit/write tools. Writes
// outside the candidate (the packet's _evidence/_scratch REPORT and artifact paths) stay allowed. Never grantable: the owning worker writes.
export const CHILD_READONLY_ENV = "PI_SAFETY_READONLY";
const RO_GIT_READS: Record<string, string[]> = { worktree: ["list"], submodule: ["status", "summary"], notes: ["list", "show"] };
const RO_GIT = new Set(["add", "commit", "checkout", "switch", "restore", "reset", "apply", "am", "cherry-pick", "merge", "rebase", "revert", "rm", "mv", "clean", "push", "pull", "init", "clone", "worktree", "submodule", "notes", "update-index", "update-ref", "gc", "prune"]);
const RO_PKG = new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "ci", "link", "unlink", "dedupe", "prune", "init", "version", "pkg"]);
const RO_DEST_LAST = new Set(["cp", "copy", "copy-item", "install", "rsync"]);
// A move or rename changes its source as well as its destination: every path is checked (moving a file out of the candidate removes it).
const RO_DEST_ALL = new Set(["tee", "touch", "truncate", "mkdir", "md", "mv", "move", "move-item", "mi", "rename-item", "ren", "rni"]);
// PowerShell writers take named parameters: only the path parameters (or the first positional) name the file. Field report: treating
// every argument as a target made -Value script text, -ItemType Directory and -Encoding utf8 look like paths inside the candidate, so
// a read-only worker could not write its Betterwright script to the packet's sibling _scratch folder.
const PS_WRITERS = new Set(["set-content", "add-content", "out-file", "new-item", "ni", "sc", "ac", "tee-object", "export-csv", "epcsv", "export-clixml"]);
const PS_PATH_PARAMS = ["path", "filepath", "literalpath", "pspath"];
const PS_VALUE_PARAMS = ["value", "inputobject", "encoding", "itemtype", "type", "stream", "width", "delimiter", "credential", "filter", "include", "exclude", "name"];
const PS_SWITCHES = ["force", "append", "noclobber", "nonewline", "passthru", "whatif", "confirm", "asbytestream", "raw"];
function psParam(arg: string, names: string[]): string | undefined {
	const bare = arg.replace(/^-+/, "").split(":")[0].toLowerCase();
	if (bare.length < 2) return undefined;
	const hits = names.filter((n) => n === bare || n.startsWith(bare));
	return hits.length === 1 || hits.includes(bare) ? (hits.includes(bare) ? bare : hits[0]) : undefined;
}
/** The files a PowerShell writer targets. Unknown parameters are treated as switches, so their values stay possible targets (fail closed). */
export function psWriteTargets(args: string[]): string[] {
	const paths: string[] = [], positionals: string[] = [];
	let name: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!/^-[A-Za-z]/.test(arg)) { positionals.push(arg); continue; }
		const inline = arg.includes(":") ? arg.slice(arg.indexOf(":") + 1) : undefined;
		const pathParam = psParam(arg, PS_PATH_PARAMS);
		const valueParam = pathParam ? undefined : psParam(arg, PS_VALUE_PARAMS);
		if (pathParam || valueParam) {
			const value = inline !== undefined && inline !== "" ? inline : args[++i];
			if (value === undefined) continue;
			if (pathParam) paths.push(value); else if (valueParam === "name") name = value;
			continue;
		}
		if (psParam(arg, PS_SWITCHES) && inline === undefined) continue;
		// unknown parameter: no value consumed
	}
	const targets = paths.length ? paths : positionals.slice(0, 1); // positional 0 is Path / FilePath; later positionals are values
	if (name !== undefined) return (targets.length ? targets : ["."]).map((t) => `${t.replace(/[\\/]+$/, "")}/${name}`);
	return targets;
}
const RO_SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const shownTarget = (target: string) => (target.length > 120 ? `${target.slice(0, 119)}…` : target);
// Windows drive-letter paths resolve with Windows rules on every host (C:/a and C:\a are one path; a relative path joins a C: cwd).
const DRIVE = /^[A-Za-z]:[\\/]/;
function resolveTarget(cwd: string, target: string): string {
	return slashed(DRIVE.test(target) || DRIVE.test(cwd) ? path.win32.resolve(cwd, target) : path.resolve(cwd, target));
}
const protectedRoot = (root: string) => slashed(DRIVE.test(root) ? path.win32.resolve(root) : path.resolve(root)).replace(/\/+$/, "");
/** Why a write target is refused: inside the candidate, not resolvable here, or missing; undefined when allowed. Names the resolved destination and the protected root. */
function roTarget(what: string, target: string, cwd: string, root: string): string | undefined {
	if (target === "") return `${what} with no target the guard can read; write to the literal absolute _scratch or _evidence path from the packet (protected root ${protectedRoot(root)})`;
	if (/[$`%]/.test(target) && !/^(\$null)$/i.test(target)) return `${what} to a target with a variable or substitution the guard cannot resolve (${shownTarget(target)}); use the literal absolute _scratch or _evidence path from the packet`;
	return insideRoot(target, cwd, root) ? `${what} into the candidate checkout (${shownTarget(target)} resolves to ${shownTarget(resolveTarget(cwd, target))}, inside protected root ${protectedRoot(root)})` : undefined;
}
function insideRoot(target: string, cwd: string, root: string): boolean {
	if (/[$`%]/.test(target) || target === "") return true; // unexpandable here: assume the candidate (fail closed)
	if (/^(\/dev\/null|nul|\$null)$/i.test(target) || /^&\d$/.test(target)) return false;
	const full = normPath(resolveTarget(cwd, target));
	const r = normPath(protectedRoot(root));
	return full === r || full.startsWith(`${r}/`);
}
// Field report: 'cat > <_scratch>/run.js <<'EOF' … EOF' was refused as "redirects output into the candidate checkout ()" because the
// heredoc body (JavaScript such as "page.evaluate(() =>") was checked as shell, and a line ending in "=>" looked like a redirect with
// no target. A heredoc body is data unless a shell reads it; PowerShell here-strings are string literals.
const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g;
const SHELL_NAME = "(?:\\S*[\\\\/])?(?:bash|sh|zsh|dash|ksh|pwsh|powershell)(?:\\.exe)?\\b";
// Field report: a read-only test-engineer could create its _scratch browser script but not fix it with sed -i, because every in-place
// edit was refused whatever the file. sed -i and perl -i are now judged by the files they edit, like every other write.
/** Whether sed/perl edits in place, and which files. Option values (-e script, -f file, -l N, -M module, -I dir) are not files. */
export function inPlaceFiles(name: "sed" | "perl", args: string[]): { inPlace: boolean; files: string[] } {
	const takesValue = name === "sed" ? new Set(["e", "f", "l"]) : new Set(["e", "E", "M", "m", "I", "x", "C", "d", "D"]);
	const scriptOpts = name === "sed" ? new Set(["e", "f"]) : new Set(["e", "E"]);
	let inPlace = false, hasScript = false;
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") { positionals.push(...args.slice(i + 1)); break; }
		if (arg.startsWith("--")) {
			const [key, inline] = arg.slice(2).split(/=(.*)/s);
			if (key === "in-place") inPlace = true;
			else if (name === "sed" && (key === "expression" || key === "file")) { hasScript = true; if (inline === undefined) i++; }
			else if (name === "sed" && key === "line-length" && inline === undefined) i++;
			continue;
		}
		if (!arg.startsWith("-") || arg === "-") { positionals.push(arg); continue; }
		for (let k = 1; k < arg.length; k++) {
			const c = arg[k];
			if (c === "i") { inPlace = true; break; } // the rest of the cluster is the backup suffix
			if (takesValue.has(c)) { if (scriptOpts.has(c)) hasScript = true; if (k === arg.length - 1) i++; break; }
			if (name === "perl" && c === "0") break; // -0[octal]
		}
	}
	const files = hasScript ? positionals : positionals.slice(1); // without -e/-f the first positional is the script (perl: the program)
	return { inPlace, files };
}

export function withoutDataBodies(text: string): string {
	const literal = text.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "'here-string'");
	const lines = literal.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		out.push(line);
		for (const m of line.matchAll(HEREDOC)) {
			const reader = line.slice(0, m.index).split(/[;&|]+/).pop() ?? "";
			// A shell runs the body when it reads the heredoc (bash <<EOF) or when the reader's output is piped into one (cat <<EOF | bash).
			const shell = new RegExp(`^\\s*${SHELL_NAME}`, "i").test(reader) || new RegExp(`\\|\\s*${SHELL_NAME}`, "i").test(line.slice(m.index));
			const end = m[3];
			let j = i + 1;
			while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, "") : lines[j]) !== end) j++;
			if (shell) continue; // a shell reads these lines: keep them as commands
			lines.splice(i + 1, Math.max(0, j - i - 1)); // drop the body, keep the delimiter line
		}
	}
	return out.join("\n");
}
// For the risk rules (classifyShell): a heredoc body is data only when this command writes it to a file or prints it - `cat > f <<EOF`,
// `cat <<EOF > f`, `tee f <<EOF`, `cat <<EOF` - and nothing is piped onward; likewise a PowerShell here-string piped straight to
// Set-Content, Out-File or Add-Content, or redirected to a file. Bodies a shell, an interpreter (python -, node -) or a pipe reads stay
// checked: they run. Field report: a read-only test-engineer's `cat > _scratch/.../x.mjs <<'EOF'` was refused five times in a row,
// as SECRET (the script mentioned .env) or PROC_KILL (it contained Stop-Process), though writing a file runs none of it.
const FILE_READER = /^\s*(?:\S*[\\/])?(?:cat|tee)(?:\.exe)?(?:\s|$)/i;
export function withoutFileBodies(text: string): string {
	const literal = text.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@(?=\s*(?:\|\s*(?:Set-Content|Out-File|Add-Content)\b|>))/gi, "'here-string'");
	const lines = literal.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		out.push(line);
		for (const m of line.matchAll(HEREDOC)) {
			const reader = line.slice(0, m.index).split(/[;&|]+/).pop() ?? "";
			if (!FILE_READER.test(reader) || line.slice(m.index).includes("|")) continue; // run or piped onward: keep the lines as commands
			const end = m[3];
			let j = i + 1;
			while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, "") : lines[j]) !== end) j++;
			lines.splice(i + 1, Math.max(0, j - i - 1)); // drop the body, keep the delimiter line
		}
	}
	return out.join("\n");
}
// Field report: a read-only database-specialist's report appeared inside the checkout while planner and test-engineer writes there were
// refused. Writes that name no shell redirect or listed command went unchecked: .NET file methods in PowerShell, inline interpreter code
// (python -c, python - <<EOF, node -e) and dd of=. Their path arguments are now checked like any other target; a path that is not a
// plain string literal cannot be resolved here and is refused. Code run from a script file (python _scratch/x.py) is not inspected.
/** The top-level arguments of a call whose "(" is at open, up to its matching ")". */
function callArgs(text: string, open: number): string[] {
	const args: string[] = [];
	let depth = 0, quote = "", cur = "";
	for (let i = open + 1; i < text.length; i++) {
		const c = text[i];
		if (quote) { cur += c; if (c === "\\" && quote !== "'") { cur += text[++i] ?? ""; continue; } if (c === quote) quote = ""; continue; }
		if (c === "'" || c === '"' || c === "`") { quote = c; cur += c; continue; }
		if (c === "(" || c === "[" || c === "{") depth++;
		if (c === ")" || c === "]" || c === "}") { if (depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; } depth--; }
		if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
		cur += c;
	}
	if (cur.trim()) args.push(cur.trim());
	return args;
}
/** A plain string literal's text, or "" when the argument is anything else (a variable, an expression, an interpolating string). */
function literalArg(arg: string | undefined): string {
	const m = /^(?:[rRbBuU]{0,2})(['"`])([\s\S]*)\1$/.exec((arg ?? "").trim());
	if (!m || (m[1] === "`" && m[2].includes("${")) || (m[1] === '"' && /\$\w|\$\(/.test(m[2]))) return "";
	return m[2];
}
// .NET file and directory methods that create, change, move or delete: the path arguments they write (Copy/Move/Replace: both paths).
const DOTNET_WRITE = /\[(?:System\.)?IO\.(File|Directory)\]::(Write\w*|Append\w*|Create\w*|Copy|Move|Replace|Delete|Open|OpenWrite|SetAttributes|Encrypt|Decrypt)\s*\(/gi;
const DOTNET_STREAM = /(?:New-Object\s+(?:-TypeName\s+)?|\[)(?:System\.)?IO\.(?:StreamWriter|FileStream)\]?(?:::new)?\s*\(/gi;
function dotnetTargets(text: string): string[] {
	const targets: string[] = [];
	for (const m of text.matchAll(DOTNET_WRITE)) {
		const args = callArgs(text, m.index! + m[0].length - 1);
		// Copy(source, dest) writes only dest; Move and Replace(source, dest, backup) change every path they name.
		const writes = /^copy$/i.test(m[2]) ? [1] : /^move$/i.test(m[2]) ? [0, 1] : /^replace$/i.test(m[2]) ? [0, 1, 2] : [0];
		for (const k of writes) if (!/^\$?null$/i.test(args[k]?.trim() ?? "") && !(k === 2 && args[k] === undefined)) targets.push(literalArg(args[k]));
	}
	for (const m of text.matchAll(DOTNET_STREAM)) targets.push(literalArg(callArgs(text, m.index! + m[0].length - 1)[0]));
	return targets;
}
// Inline interpreter code: file writes, moves and deletes, with the arguments that name paths.
// Inline interpreter code: file writes, moves and deletes, with the arguments each one writes. A copy writes only its destination: its
// source is read (field report: copying the built backend executable from the checkout to the _evidence folder was refused as a write
// into the checkout). A move or rename changes both paths.
const CODE_WRITES: { re: RegExp; writes: number[]; mode?: boolean }[] = [
	{ re: /\bopen\s*\(/g, writes: [0], mode: true }, // Python open(path, "w"); Perl/Ruby open with a write mode
	{ re: /\bPath\s*\(/g, writes: [0] }, // pathlib: checked only when a write method follows (below)
	{ re: /\bshutil\.(?:copy\w*)\s*\(/g, writes: [1] }, // copy, copy2, copyfile, copytree(src, dst)
	{ re: /\b(?:shutil\.move|os\.(?:rename|renames|replace))\s*\(/g, writes: [0, 1] },
	{ re: /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs|mkdir|makedirs|truncate))\s*\(/g, writes: [0] },
	{ re: /\b(?:fs(?:\.promises)?\.|fsp\.)?(?:writeFile|appendFile|createWriteStream|truncate|unlink|rm|rmdir|mkdir)(?:Sync)?\s*\(/g, writes: [0] },
	{ re: /\b(?:fs(?:\.promises)?\.|fsp\.)?(?:copyFile|cp|link|symlink)(?:Sync)?\s*\(/g, writes: [1] }, // (source or target, new path)
	{ re: /\b(?:fs(?:\.promises)?\.|fsp\.)?rename(?:Sync)?\s*\(/g, writes: [0, 1] },
	{ re: /\bFile\.(?:write|binwrite|delete|unlink)\s*\(/g, writes: [0] }, // Ruby
	{ re: /\bFile\.rename\s*\(/g, writes: [0, 1] }, // Ruby; Ruby File.open is covered by the open rule and its mode
];
const PATHLIB_WRITE = /^\s*\)\s*\.\s*(?:write_text|write_bytes|touch|unlink|rename|replace|mkdir|rmdir|open\s*\([^)]*['"][wax+])/;
function codeTargets(code: string): string[] {
	const targets: string[] = [];
	for (const { re, writes, mode } of CODE_WRITES) for (const m of code.matchAll(re)) {
		const open = m.index! + m[0].length - 1;
		const args = callArgs(code, open);
		if (/Path\s*\($/.test(m[0])) {
			let close = open, depth = 0; // the matching ")" of Path(...), then the method called on it
			for (; close < code.length; close++) { if (code[close] === "(") depth++; else if (code[close] === ")" && --depth === 0) break; }
			if (!PATHLIB_WRITE.test(code.slice(close))) continue;
		}
		if (mode) {
			const m2 = args.slice(1).map((a) => a.replace(/^mode\s*=\s*/, ""));
			const perlMode = /^['"]\s*(?:\+?>|>>|\+<)/.test(args[1] ?? "") || /^['"]\s*(?:\+?>|>>)/.test(args[0] ?? "");
			if (!perlMode && !m2.some((a) => /^(?:[rRbBuU]{0,2})(['"])[^'"]*[wax+][^'"]*\1$/.test(a))) continue; // reads stay allowed
			if (/^['"]\s*(?:\+?>|>>)/.test(args[0] ?? "")) { targets.push(literalArg(args[0]).replace(/^\s*\+?>{1,2}\s*/, "")); continue; } // Perl 2-arg open(">file")
			if (perlMode) { targets.push(literalArg(args[2])); continue; }
		}
		for (const k of writes) targets.push(literalArg(args[k]));
	}
	return targets;
}
// Names only, to inspect the code they would run; this file never launches an interpreter.
const INTERPRETERS = { has: (name: string) => /^(?:python3?|py|node|nodejs|perl|ruby|deno|bun)$/.test(name) };
const CODE_FLAGS = new Set(["-c", "-e", "-p", "--eval", "--print", "-E"]);
/** Code bodies an interpreter runs from a heredoc (python3 - <<'EOF' ... EOF); read before the bodies are dropped as data. */
function interpreterHeredocs(text: string): string[] {
	const bodies: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) for (const m of lines[i].matchAll(HEREDOC)) {
		const reader = lines[i].slice(0, m.index).split(/[;&|]+/).pop() ?? "";
		if (!INTERPRETERS.has(commandName(reader.trim().split(/\s+/)[0] ?? ""))) continue;
		let j = i + 1;
		while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, "") : lines[j]) !== m[3]) j++;
		bodies.push(lines.slice(i + 1, j).join("\n"));
	}
	return bodies;
}
function readOnlyShell(text: string, cwd: string, root: string, depth = 0): string | undefined {
	if (depth > 3) return "command nesting is too deep to check";
	for (const raw of splitSegments(text)) {
		const tokens = tokenize(raw);
		for (let i = 0; i < tokens.length; i++) if (tokens[i].op && tokens[i].text.includes(">") && !/>&$/.test(tokens[i].text)) { const why = roTarget("redirects output", tokens[i + 1]?.text ?? "", cwd, root); if (why) return why; } // >& targets a descriptor
		const words = argvOf(tokens);
		if (!words.length) continue;
		const name = commandName(words[0]);
		const args = words.slice(1);
		const lower = args.map((a) => a.toLowerCase());
		const positionals = args.filter((a) => !a.startsWith("-"));
		if (RO_SHELLS.has(name)) { const at = lower.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)); if (at >= 0 && args[at + 1] !== undefined) { const inner = readOnlyShell(args[at + 1], cwd, root, depth + 1); if (inner) return inner; } continue; }
		if (name === "cmd") { const at = lower.findIndex((a) => a === "/c" || a === "/k"); if (at >= 0 && args[at + 1] !== undefined) { const inner = readOnlyShell(args.slice(at + 1).join(" "), cwd, root, depth + 1); if (inner) return inner; } continue; }
		if (INTERPRETERS.has(name)) { const at = args.findIndex((a) => CODE_FLAGS.has(a)); if (at >= 0 && args[at + 1] !== undefined) for (const t of codeTargets(args[at + 1])) { const why = roTarget(`${name} inline code writes`, t, cwd, root); if (why) return why; } }
		if (name === "dd") for (const a of args) if (/^of=/i.test(a)) { const why = roTarget("dd writes", a.slice(3), cwd, root); if (why) return why; }
		if (name === "pwsh" || name === "powershell") { const at = lower.findIndex((a) => a === "-c" || a === "-command"); if (at >= 0 && args[at + 1] !== undefined) { const inner = readOnlyShell(args.slice(at + 1).join(" "), cwd, root, depth + 1); if (inner) return inner; } continue; }
		if (name === "git") {
			const sub = positionals[0]?.toLowerCase() ?? "";
			// Listing subcommands of otherwise mutating groups only read (field report: a planner's `git worktree list` was refused).
			const reads = RO_GIT_READS[sub]?.includes(positionals[1]?.toLowerCase() ?? "");
			if (RO_GIT.has(sub) && !reads) return `git ${sub} changes the repository`;
			if (sub === "stash" && !["list", "show"].includes(positionals[1]?.toLowerCase() ?? "")) return "git stash changes the working tree";
			// Field report: a read-only scout's branch listing was refused. Listing forms pass (-a, -r, -v, --list <pattern>, --show-current,
			// --contains, --merged and peers); a changing flag, or a name without a listing flag (which creates the ref), is refused.
			if (sub === "branch" || sub === "tag") {
				const rest = args.slice(lower.indexOf(sub) + 1);
				const changes = rest.some((a) => (sub === "branch" ? /^-[a-zA-Z]*[dDmMcCfut]/ : /^-[a-zA-Z]*[dasufmFe]/).test(a) || /^--(delete|move|copy|force|set-upstream|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog|annotate|sign|local-user|message|file|edit|cleanup)(=|$)/.test(a));
				const lists = rest.some((a) => (sub === "branch" ? /^-[arvl]+$/ : /^-(l|n\d*|v)$/).test(a) || /^--(list|show-current|all|remotes|verbose|contains|no-contains|merged|no-merged|points-at|sort|format|column|verify)(=|$)/.test(a));
				if (changes || (rest.some((a) => !a.startsWith("-")) && !lists)) return `git ${sub} changes refs`;
			}
			continue;
		}
		if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "dotnet", "go"].includes(name) && RO_PKG.has(positionals[0]?.toLowerCase() ?? "")) return `${name} ${positionals[0]} changes dependencies`;
		if (name === "sed" || name === "perl") {
			const edit = inPlaceFiles(name, args);
			if (edit.inPlace) for (const file of edit.files) { const why = roTarget(`${name} -i edits`, file, cwd, root); if (why) return why; }
		}
		if (RO_DEST_LAST.has(name) && positionals.length) { const why = roTarget(`${name} writes`, positionals[positionals.length - 1], cwd, root); if (why) return why; }
		if (RO_DEST_ALL.has(name)) for (const p of positionals) { const why = roTarget(`${name} writes`, p, cwd, root); if (why) return why; }
		if (PS_WRITERS.has(name)) for (const p of psWriteTargets(args)) { const why = roTarget(`${name} writes`, p, cwd, root); if (why) return why; }
	}
	return undefined;
}
/** Where a candidate's artifact folders sit by the harness convention: <x>/worktrees/<repo> for a task checkout <x>/worktrees/<repo>/<task>,
 * else <parent>/worktrees/<checkout name> beside a primary checkout. A hint for the refusal; the packet's own paths are authoritative. */
export function artifactGroupHint(root: string): string {
	const r = protectedRoot(root);
	const parent = path.posix.dirname(r);
	return path.posix.basename(path.posix.dirname(parent)) === "worktrees" ? parent : `${parent}/worktrees/${path.posix.basename(r)}`;
}
/** Why a read-only worker's tool call would change its candidate checkout, or undefined when it does not. */
export function readOnlyViolation(toolName: string, input: Record<string, unknown>, cwd: string, root: string): string | undefined {
	if (toolName === "edit" || toolName === "write") {
		const p = typeof input?.path === "string" ? input.path : typeof (input as any)?.file_path === "string" ? (input as any).file_path : "";
		return insideRoot(p, cwd, root) ? `${toolName} changes a file in the candidate checkout` : undefined;
	}
	if (toolName !== "bash" && toolName !== "powershell") return undefined;
	const command = withLiteralVariables(String(input?.command ?? ""));
	for (const code of interpreterHeredocs(command)) for (const t of codeTargets(code)) { const why = roTarget("interpreter code writes", t, cwd, root); if (why) return why; }
	const shell = withoutDataBodies(command);
	// Scanned over the whole command: segment splitting treats "(" as a subshell and would cut a .NET call apart.
	for (const t of dotnetTargets(shell)) { const why = roTarget(".NET file method writes", t, cwd, root); if (why) return why; }
	return readOnlyShell(shell, cwd, root);
}

// Field report: a read-only debugger's PowerShell `$R='C:\...\_scratch\sms-test\r1-compile-debug'` followed by
// `cargo check ... *> "$R\check-fixed.log"` was refused: the target holds a variable the guard cannot resolve, although the same command
// assigned it a literal _scratch path two lines earlier. A variable is replaced by its value only when that is certain: assigned exactly
// once, as a whole line or ;-statement (PowerShell `$R = '...'`, Bash `R='...'` or `export R=...`), to a literal with no $, backtick or %,
// and used after the assignment; and the command has nothing that could change it later (Set-/New-/Remove-/Clear-Variable, read, unset,
// declare, typeset, local, for, foreach). Anything else stays unresolved, and so refused as before.
const VAR_CHANGERS = /\b(?:Set-Variable|New-Variable|Remove-Variable|Clear-Variable|sv|read|unset|declare|typeset|local|readonly|for|foreach|mapfile|readarray|getopts)\b/i;
const PS_LITERAL_SET = /^\s*\$([A-Za-z_]\w*)\s*=\s*(?:'([^'$`%]*)'|"([^"$`%]*)")\s*$/;
const SH_LITERAL_SET = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(?:'([^'$`%]*)'|"([^"$`%]*)"|([^\s$`%'";&|<>()]+))\s*$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function withLiteralVariables(text: string): string {
	if (VAR_CHANGERS.test(text)) return text;
	const found: { name: string; value: string; end: number; ps: boolean }[] = [];
	let offset = 0;
	for (const line of text.split(/(?<=\n)/)) {
		let at = offset;
		for (const piece of line.split(/(?<=;)/)) {
			const statement = piece.replace(/;$/, "").replace(/\r?\n$/, "");
			const ps = PS_LITERAL_SET.exec(statement);
			const sh = ps ? null : SH_LITERAL_SET.exec(statement);
			const m = ps ?? sh;
			if (m) found.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? "", end: at + piece.length, ps: !!ps });
			at += piece.length;
		}
		offset += line.length;
	}
	// Every replacement is found in the original text, then applied in one pass.
	const edits: { at: number; length: number; value: string }[] = [];
	for (const v of found) {
		const name = escapeRe(v.name);
		const same = (n: string) => (v.ps ? n.toLowerCase() === v.name.toLowerCase() : n === v.name);
		if (found.filter((w) => same(w.name)).length !== 1) continue; // assigned more than once: not certain
		// Any other assignment of this name (inside a block, with a computed value, a one-command prefix) makes it uncertain too.
		const assigns = v.ps ? new RegExp(`\\$${name}\\s*=(?!=)`, "gi") : new RegExp(`(?:^|[\\s;&|(])${name}=`, "g");
		if ((text.match(assigns) ?? []).length !== 1) continue;
		const use = v.ps ? new RegExp(`\\$(?:\\{${name}\\}|${name}(?![\\w:]))`, "gi") : new RegExp(`\\$(?:\\{${name}\\}|${name}(?!\\w))`, "g");
		for (const m of text.matchAll(use)) if ((m.index ?? 0) >= v.end) edits.push({ at: m.index ?? 0, length: m[0].length, value: v.value });
	}
	if (!edits.length) return text;
	edits.sort((a, b) => a.at - b.at);
	let out = "";
	let from = 0;
	for (const e of edits) { if (e.at < from) continue; out += text.slice(from, e.at) + e.value; from = e.at + e.length; }
	return out + text.slice(from);
}

// ---- User permission rules: <agent dir>/harness-permissions.json, written by the user only (agents cannot: it is a CONFIG_WRITE path).
//   { "allow": ["Stop-Process -Id *", "rm -rf build"], "deny": ["git push --force*"] }
// Each entry is an exact shell command, or a prefix when it ends with "*" (whitespace collapsed, case kept). An allow entry lets a command
// through that an operator could approve anyway (grantable rules only; never merge or release, which keep their own approvals). A deny
// entry blocks a matching command for main and every worker as USER_DENY, never grantable. Missing file: no rules. Malformed: no allows.
export const PERMISSIONS_FILE = "harness-permissions.json";
let permissionsCache: { file: string; mtime: number; allow: string[]; deny: string[] } | undefined;
const squash = (text: string) => text.trim().replace(/\s+/g, " ");
export function loadPermissions(agentDir: string): { allow: string[]; deny: string[] } {
	const file = path.join(agentDir, PERMISSIONS_FILE);
	try {
		const stat = fs.statSync(file);
		if (permissionsCache && permissionsCache.file === file && permissionsCache.mtime === stat.mtimeMs) return permissionsCache;
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { allow?: unknown; deny?: unknown };
		const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && squash(x).length > 0 && squash(x) !== "*").map(squash) : []);
		permissionsCache = { file, mtime: stat.mtimeMs, allow: list(raw.allow), deny: list(raw.deny) };
		return permissionsCache;
	} catch (error) {
		// No file: no rules. A file that exists but cannot be parsed keeps its deny-nothing, allow-nothing default (fail closed for allows).
		return { allow: [], deny: [] };
	}
}
export function permissionMatches(pattern: string, command: string): boolean {
	const c = squash(command);
	return pattern.endsWith("*") ? c.startsWith(pattern.slice(0, -1)) : c === pattern;
}

// ---- Block messages: rule ids, the op digest, the program (never its arguments: a command may carry a credential), whether a grant can
// ever help, and the exact next step.
const COMMIT_FORMS = 'not a normal commit form: use git commit -m "<text>" or git commit -F "<absolute .md/.txt file>" (double quotes, one command, cwd = candidate root); the -m text is one line of plain ASCII with no \\n escapes, the -F file lives in the task\'s _evidence or _scratch folder, and these forms need no grant';
const RULE_ADVICE: Partial<Record<RiskRule, string>> = {
	SECRET: `agents never read or write secret files (.env*, keys, credentials, .ssh/.aws/.gnupg) or name them in a command; to check .env settings run node "${REDACTED_ENV_SCRIPT}" "<absolute .env path>" (secret-like values hidden); .env.example, .env.sample and .env.template are ordinary files when named alone`,
	OPAQUE_UNPARSEABLE: "the guard cannot parse this command (inline scripts with nested quotes, eval, encoded or deeply nested commands); write the script to a file in the task's _scratch folder and run it by path or pipe it on stdin (for example betterwright run < \"<absolute file>\")",
	PI_PACKAGE: "this changes your installed Pi packages or settings (install, update, remove, config), which loads new code into later sessions; the operator can also run it directly in a terminal outside Pi",
	PATH_AMBIGUOUS: "use an exact absolute path without aliases, links or 8.3 short names; a delete never takes a variable, substitution, root, home, '.', '..' or bare glob target",
};
function programOf(op: GuardOp): string {
	if (op.kind !== "shell") return `${op.kind} ${op.path}`;
	const words = op.command.trim().split(/\s+/);
	const name = path.basename(words[0] ?? "").replace(/\.(exe|cmd|bat)$/i, "");
	return ["git", "gh", "npm", "pnpm", "yarn"].includes(name.toLowerCase()) && /^[a-z][a-z-]*$/.test(words[1] ?? "") ? `${name} ${words[1]}` : name || "(empty)";
}
export function blockReason(decision: Extract<Decision, { action: "block" }>, scope: GuardScope, gateCommits: boolean, commitWhy?: string): string {
	const head = `Blocked by harness safety guard [${decision.rules.join(", ")}] op ${decision.digest}: `;
	if (scope === "child" && gateCommits && decision.rules.length === 1 && decision.rules[0] === "GIT_COMMIT" && decision.op.kind === "shell") {
		const bare = decision.op.command.replace(/"[^"]*"|'[^']*'/g, "Q");
		if (parseNormalCommit(decision.op.command) === undefined && /^git commit -[mF] \S+$/.test(bare)) return `${head}${COMMIT_FORMS}.`;
		if (parseNormalCommit(decision.op.command) !== undefined) return commitWhy ? `${head}git commit; not automatic here: ${commitWhy}.` : `${head}git commit; a normal commit is automatic only with cwd = the candidate root on its feature branch; run it there (no grant is needed).`;
		return `${head}git commit; only plain git commit -m/-F forms are automatic: amend, --no-verify, -a and other flags are not, and need an operator grant for the exact command.`;
	}
	// A delivery command in a form the guard does not accept is a command error, not a missing approval.
	const form = decision.op.kind === "shell" && decision.rules.length === 1 && decision.rules[0] === "GIT_PUBLISH" ? deliveryFormWhy(decision.op.command) : undefined;
	if (form) return `${head}${programOf(decision.op)}; not an accepted command form: ${form}. Correct the command and run it again; this is not a missing approval, and an approval already given for this merge or release still applies.`;
	const advice = decision.rules.map((r) => RULE_ADVICE[r]).filter(Boolean);
	const credential = decision.grantable && decision.op.kind === "shell" ? credentialFinding(decision.op.command) : undefined;
	const how = credential
		? `not approvable as written: the command text carries a credential-like literal (${credential}), which an approval cannot show or store; generate the value when the command runs (for example $env:NAME = [guid]::NewGuid().ToString()) and request approval for that text, or have the operator run it directly`
		: !decision.grantable
		? "not grantable: no approval unblocks this for an agent; the operator can run it directly"
		: scope === "main"
			? "grantable: the operator can approve this exact operation with request_authorization; the approval must name this folder and the exact command text, and is used once"
			: `grantable: a worker receives only grants requested for its role and its launch folder before it was launched, with the exact command text; ask main to request one with role and cwd ${decision.op.kind === "shell" ? decision.op.cwd : "set to this folder"} and relaunch the worker in that folder, or have the operator run it`;
	return `${head}${programOf(decision.op)}; ${how}${advice.length ? `; ${advice.join("; ")}` : ""}.`;
}

// Shared hook logic for main and child: allow, consume one exact grant, use a live child lease, or block with rule ids and a digest only (no raw command).
export function guardToolCall(guard: { scope: GuardScope; store: GrantStore; agentDir: string; live?: DeliveryLive; gateCommits?: boolean; pushTarget?: PushTarget; readOnlyRoot?: string; reads?: Set<string>; grantNote?: string }, toolName: string, input: Record<string, unknown>, cwd: string, liveUrl: (candidate: string, branch: string) => string | undefined = livePushUrl): GuardBlock | undefined {
	// Commit gating is a trusted-child policy only; the main guard never gates commits.
	if (guard.scope === "child" && guard.readOnlyRoot !== undefined) {
		const why = readOnlyViolation(toolName, input, cwd, guard.readOnlyRoot);
		if (why) {
			const digest = createHash("sha256").update(`${toolName}\0${JSON.stringify(input ?? {})}`).digest("hex").slice(0, 16);
			return { block: true, reason: `Blocked by harness safety guard [READ_ONLY_ROLE] op ${digest}: ${why}; not grantable: this role is read-only for its candidate, so write REPORT and evidence files to the packet's _evidence or _scratch paths (for this candidate: ${artifactGroupHint(guard.readOnlyRoot)}/_evidence/<task>/ or _scratch/<task>/) and return code or config changes to main for the owning worker.` };
		}
	}
	if ((toolName === "bash" || toolName === "powershell") && typeof input?.command === "string") {
		const denied = loadPermissions(guard.agentDir).deny.find((p) => permissionMatches(p, String(input.command)));
		if (denied) {
			const digest = createHash("sha256").update(`${toolName}\0${input.command}`).digest("hex").slice(0, 16);
			return { block: true, reason: `Blocked by harness safety guard [USER_DENY] op ${digest}: ${String(input.command).trim().split(/\s+/)[0]}; not grantable: it matches a deny rule in your ${PERMISSIONS_FILE}.` };
		}
	}
	if (redactedEnvRead(toolName, input)) return undefined;
	const decision = decideToolCall(toolName, input, cwd, guard.agentDir, guard.scope === "child" && guard.gateCommits === true);
	if (decision.action === "allow") {
		if (guard.reads !== undefined && toolName === "read" && typeof input?.path === "string") guard.reads.add(normPath(slashed(path.resolve(cwd, piPathInput(input.path)))));
		// Only an edit the guard would otherwise allow: a secret or config write keeps its own, unfixable reason.
		// Read before edit: a worker may edit or overwrite an existing file only after reading it in this run, so it never changes what it has not seen.
		if (guard.reads !== undefined && (toolName === "edit" || toolName === "write") && typeof input?.path === "string") {
			const target = normPath(slashed(path.resolve(cwd, piPathInput(input.path))));
			let exists = false;
			try { exists = fs.statSync(target).isFile(); } catch { exists = false; }
			if (exists && !guard.reads.has(target)) {
				const digest = createHash("sha256").update(`${toolName}\0${target}`).digest("hex").slice(0, 16);
				return { block: true, reason: `Blocked by harness safety guard [READ_BEFORE_EDIT] op ${digest}: ${toolName} ${target}; read this file with the read tool in this run first, then ${toolName} it (no grant is needed).` };
			}
		}
		return undefined;
	}
	// A single-use record never carries PR merge or release create (defense in depth for envelopes or stores that hold one): only the action grants do.
	if (decision.grantable && !(decision.op.kind === "shell" && isMergeOrRelease(decision.op.command)) && guard.store.consume(guard.scope, canonicalCwd(cwd), decision.op)) return undefined;
	if (guard.scope === "child" && normalTrustedPush(guard.pushTarget, decision, liveUrl)) return undefined;
	const live = guard.live ?? defaultDeliveryLive(liveUrl);
	if (guard.scope === "child" && (guard.gateCommits === true || guard.pushTarget !== undefined) && (normalTrustedPrCreate(guard.pushTarget, decision, liveUrl, live) || normalTrustedPrEdit(guard.pushTarget, decision, liveUrl, live))) return undefined;
	if (guard.scope === "child" && leasedPush(guard.store, decision, liveUrl)) return undefined;
	if (guard.scope === "child" && guard.gateCommits === true && normalTrustedCommit(guard.pushTarget, decision, liveUrl)) return undefined;
	if (guard.scope === "child" && guard.gateCommits === true && leasedCommit(guard.store, decision, liveUrl)) return undefined;
	if (guard.scope === "child" && deliveryAllows(guard.store, decision, live)) return undefined;
	if (guard.scope === "child" && cleanupAllows(guard.store, decision, live)) return undefined;
	if (guard.scope === "child" && artifactCleanupAllows(guard.store, decision, live)) return undefined;
	// User allow rules: only what an operator could approve anyway, and never merge or release (they keep their own action grants).
	if (decision.grantable && decision.op.kind === "shell" && !isMergeOrRelease(decision.op.command) && loadPermissions(guard.agentDir).allow.some((p) => permissionMatches(p, (decision.op as { command: string }).command))) return undefined;
	const miss = decision.grantable ? guard.store.grantMiss?.(guard.scope, canonicalCwd(cwd), decision.op) : undefined;
	const commitWhy = guard.scope === "child" && guard.gateCommits === true && decision.op.kind === "shell" && decision.rules.length === 1 && decision.rules[0] === "GIT_COMMIT" ? commitRefusalWhy(guard.pushTarget, decision.op.command, decision.op.cwd, liveUrl) : undefined;
	const reason = blockReason(decision, guard.scope, guard.gateCommits === true, commitWhy);
	// Only a refusal that invites an approval gets the launch note: a commit-form refusal ("use git commit -F ...") needs no approval,
	// and a note about approvals there sent a worker looking for one it did not need.
	const invitesApproval = /; grantable: /.test(reason);
	const note = !miss && invitesApproval && guard.scope === "child" ? (guard.grantNote ? ` At launch: ${guard.grantNote}.` : guard.store.size() === 0 ? " This worker was launched with no approved operations." : "") : "";
	return { block: true, reason: reason + (miss ? ` ${GRANT_MISS_TEXT[miss]}` : "") + note };
}
const GRANT_MISS_TEXT: Record<GrantMiss, string> = {
	"other-text": "An approval exists in this folder for a different command text: run the approved command exactly as approved, with nothing added (no redirection such as 2>&1, no cd, no chained command), or ask for a new approval.",
	"other-folder": "An approval exists for this exact command in a different folder: run it from the approved folder, or ask for a new approval.",
	"used": "This exact command was already approved and that approval was used; approvals are single use, so a retry needs a new approval.",
};

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
