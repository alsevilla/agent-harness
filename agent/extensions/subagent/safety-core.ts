// Stage 1 safety core: pure guard rules, a bounded lexical shell matcher and a single-use in-memory grant store.
// Not an OS sandbox and not a shell parser: documented bypasses (scripts, env, aliases, variables, operator shell) are in subagent/README.md.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type RiskRule =
	| "GIT_PUBLISH" | "GIT_DESTRUCTIVE" | "PKG_PUBLISH_AUTH" | "DESTRUCTIVE_FS" | "LINKS" | "PRIVILEGE_PERSIST" | "PROC_KILL"
	| "LAUNCH_PI" | "CURL_SHELL" | "OPAQUE_UNPARSEABLE" | "SECRET" | "CONFIG_WRITE" | "PATH_AMBIGUOUS";

export type GuardOp = { kind: "shell"; command: string; cwd: string } | { kind: "write"; path: string } | { kind: "read"; path: string };
export type Decision = { action: "allow" } | { action: "block"; rules: RiskRule[]; grantable: boolean; op: GuardOp; digest: string };
export interface ShellClassification { rules: RiskRule[]; grantable: boolean }

export const MAX_GRANT_OPS = 5;
export const GRANT_TTL_DEFAULT_MS = 30 * 60_000;
export const GRANT_TTL_MAX_MS = 60 * 60_000;
const MAX_NESTING = 4;

const NOT_GRANTABLE = new Set<RiskRule>(["OPAQUE_UNPARSEABLE", "SECRET", "PATH_AMBIGUOUS"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
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
	for (const ch of segment) {
		if (quote) {
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
const ENV_VALUE = new Set(["-u", "--unset", "-c", "--chdir"]);
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
		if (quote === "'") {
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
		} else if (";&|()`{}\n\r".includes(ch)) {
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

// Index of the wrapped command, or the text an env -S string carries (classified as a command line).
function wrappedStart(name: string, args: string[]): number | string {
	const lower = args.map((a) => a.toLowerCase());
	let i = 0;
	if (name === "env") {
		while (i < args.length) {
			const a = lower[i];
			if (a === "-s" || a === "--split-string") return args[i + 1] ?? "";
			if (a.startsWith("-s") && !a.startsWith("--")) return args[i].slice(2);
			if (a.startsWith("--split-string=")) return args[i].slice(15);
			if (ENV_VALUE.has(a)) i += 2;
			else if (a.startsWith("-") || /^[a-z_][a-z0-9_]*=/i.test(args[i])) i++;
			else break;
		}
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
		if (typeof start === "string") return classifyText(start, out, depth + 1);
		return classifySegment(args.slice(start), out, depth + 1);
	}
	if (name === "eval") return add(out, "OPAQUE_UNPARSEABLE");
	if (SHELLS.has(name)) {
		const inner = after(["-c", "-lc", "-ic"]);
		if (inner !== undefined) classifyText(inner, out, depth + 1);
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
		if (sub === "commit" && lower.includes("--amend")) add(out, "GIT_DESTRUCTIVE");
		if (sub === "config" && lower.some((a) => a === "--global" || a === "--system")) add(out, "PRIVILEGE_PERSIST");
		if (sub === "config" && lower.some((a) => a.includes("hookspath"))) add(out, "CONFIG_WRITE");
		if (lower.some((a) => a.startsWith("core.hookspath="))) add(out, "CONFIG_WRITE");
		return;
	}
	if (name === "gh") {
		const [sub1 = "", sub2 = ""] = positionals(lower, GH_VALUE);
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
export function classifyShell(command: string): ShellClassification {
	const text = String(command ?? "");
	const out = new Set<RiskRule>();
	classifyText(text, out, 0);
	classifyText(text.replace(/\\\\/g, "\\"), out, 0);
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

export function decideToolCall(toolName: string, input: Record<string, unknown>, cwd: string, agentDir: string): Decision {
	if (toolName === "bash" || toolName === "powershell") {
		const command = String(input.command ?? "");
		const { rules } = classifyShell(command);
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
	revokeAll(): void;
	size(): number;
}

function validateRecord(value: unknown): GrantRecord {
	const r = value as GrantRecord;
	if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[0-9a-f]{64}$/.test(String(r.bearer)) || !(r.role === null || typeof r.role === "string") || typeof r.candidate !== "string" || !path.isAbsolute(r.candidate) || typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) throw new TypeError("invalid grant record");
	validateOp(r.op);
	return r;
}

export function createGrantStore(now: () => number = () => Date.now()): GrantStore {
	let records: GrantRecord[] = [];
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
		revokeAll() {
			records = [];
		},
		size() {
			return records.length;
		},
	};
}

export const CHILD_GRANT_ENV = "PI_SAFETY_GRANTS";

export function serializeGrants(records: GrantRecord[]): string {
	return JSON.stringify({ v: 1, grants: records });
}

export function loadChildGrants(text: string): GrantRecord[] {
	const parsed = JSON.parse(text) as { v?: number; grants?: unknown };
	if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.grants)) throw new TypeError("invalid grant envelope");
	return parsed.grants.map(validateRecord);
}

export interface ChildGuardLaunch {
	entry: string;
	grantCount: number;
	childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

// One logical child job's claim window. Its first actual spawn closes the window, even when no grant exists or the spawn fails; fallback spawns of that job never claim.
export interface ClaimWindow { open: boolean }

// Claims this role's grants for one child spawn (single use) and returns the guard entry plus the child's environment.
export function claimChildGuard(store: GrantStore, role: string, candidate: string, guardFile: string, window: ClaimWindow = { open: true }): ChildGuardLaunch {
	if (!fs.existsSync(guardFile)) throw new Error("Safety guard missing: child launch refused (fail closed).");
	const mayClaim = window.open;
	window.open = false;
	const claimed = mayClaim ? store.claim(role, canonicalCwd(candidate)) : [];
	const value = claimed.length ? serializeGrants(claimed) : undefined;
	return {
		entry: guardFile,
		grantCount: claimed.length,
		childEnv(base) {
			const env: NodeJS.ProcessEnv = { ...base };
			delete env[CHILD_GRANT_ENV];
			if (value !== undefined) env[CHILD_GRANT_ENV] = value;
			return env;
		},
	};
}

export interface GuardBlock { block: true; reason: string }

// Shared hook logic for main and child: allow, consume one exact grant, or block with rule ids and a digest only (no raw command).
export function guardToolCall(guard: { scope: GuardScope; store: GrantStore; agentDir: string }, toolName: string, input: Record<string, unknown>, cwd: string): GuardBlock | undefined {
	const decision = decideToolCall(toolName, input, cwd, guard.agentDir);
	if (decision.action === "allow") return undefined;
	if (decision.grantable && guard.store.consume(guard.scope, canonicalCwd(cwd), decision.op)) return undefined;
	const how = decision.grantable ? "needs exact operator authorization via request_authorization" : "not grantable to a model: use the operator out-of-band";
	return { block: true, reason: `Blocked by harness safety guard [${decision.rules.join(", ")}] op ${decision.digest}: ${how}.` };
}

// Authorization requests are accepted only for operations the guard would actually block and that are grantable.
export function authorizableOp(kind: "shell" | "write", value: string, candidate: string, agentDir: string): GuardOp {
	const decision = kind === "shell" ? decideToolCall("bash", { command: value }, candidate, agentDir) : decideToolCall("write", { path: value }, candidate, agentDir);
	if (decision.action !== "block" || !decision.grantable) throw new RangeError("operation is not a grantable risky operation");
	validateOp(decision.op);
	return decision.op;
}

// One prompt shows the whole batch: 1 to 5 operations, each displayable, total bounded (nothing truncated).
export function assertBatchDisplayable(ops: GuardOp[]): void {
	if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_GRANT_OPS) throw new RangeError(`a batch carries 1 to ${MAX_GRANT_OPS} operations`);
	ops.forEach(validateOp);
	if (ops.reduce((sum, op) => sum + describeOp(op).length, 0) > MAX_BATCH_CHARS) throw new RangeError(`operation batch exceeds ${MAX_BATCH_CHARS} characters`);
}
