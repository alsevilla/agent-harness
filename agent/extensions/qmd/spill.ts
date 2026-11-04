// Bounded recovery for qmd_get/qmd_status stdout above the 10000-character preview limit (UTF-16 units, preview + notice together).
import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const PREVIEW_LIMIT = 10000;
const READ_PAGE_BYTES = 50000; // built-in read pages at ~50 KB: longer lines need the bash byte recipe
const MAX_TMP_PATH = 500;
const CHUNK_BYTES = 40000; // escaped JSON text per recovery command; SDK bash caps one command's output at 50 KB / 2000 lines

// Node script run through bash: prints ONE JSON line {start,next,total,text}. Offsets are UTF-16 units of the saved file, chunks end on code point boundaries,
// and everything the SDK bash tool would strip or rewrite (controls, ESC, CR, U+2028/9, BOM, U+FFF9-B) is \u-escaped so each command decodes cleanly on its own.
// No single quote, slash or regex inside, so it survives single-quoting and MSYS argument conversion.
const RECOVERY_SCRIPT = [
  'var s=require("fs").readFileSync(process.argv[1],"utf8"),a=Math.max(0,+process.argv[2]||0),i=a,b=0,t="",B=String.fromCharCode(92),Q=String.fromCharCode(34);',
  "for(;i<s.length;){var n=s.codePointAt(i)>65535?2:1,k=s.charCodeAt(i),j=JSON.stringify(s.slice(i,i+n)).slice(1,-1);",
  'if(n==1&&(k>126&&k<160||k==8232||k==8233||k==65279||k>65528&&k<65532))j=B+"u"+("000"+k.toString(16)).slice(-4);',
  `if(b+Buffer.byteLength(j)>${CHUNK_BYTES})break;t+=j;b+=Buffer.byteLength(j);i+=n}`,
  'console.log(JSON.stringify({start:a,next:i<s.length?i:null,total:s.length}).slice(0,-1)+","+Q+"text"+Q+":"+Q+t+Q+"}")',
].join("");

/** Absolute path of the running interpreter only if it is plainly Node (not Bun, not a standalone Pi binary). Pure: no probing, no spawning. */
export function trustedNode(execPath: string, bunVersion?: string): string | undefined {
  if (typeof execPath !== "string" || bunVersion || /[\x00-\x1f\x7f]/.test(execPath)) return undefined;
  const win = /^[A-Za-z]:\\/.test(execPath);
  if (!win && !execPath.startsWith("/")) return undefined;
  if (!/(^|[\\/])node(\.exe)?$/i.test(execPath)) return undefined;
  return win ? execPath.replaceAll("\\", "/") : execPath;
}

export type SpillDeps = {
  tmpdir(): string;
  randomHex(): string;
  open(file: string, flags: string, mode: number): Promise<{ writeFile(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  stat(file: string): Promise<{ size: number }>;
  nodePath(): string | undefined;
};
export type Capped = { text: string; saved?: { path: string; bytes: number } };

const defaults: SpillDeps = { tmpdir, randomHex: () => randomBytes(8).toString("hex"), open: (f, fl, m) => open(f, fl, m), stat, nodePath: () => trustedNode(process.execPath, process.versions.bun) };
const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** Prefix of at most n UTF-16 units that never ends inside a surrogate pair. */
function prefix(raw: string, n: number): string {
  let end = Math.max(0, Math.min(n, raw.length));
  const c = raw.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end--;
  return raw.slice(0, end);
}

/** Saves the exact output to a new exclusive temp file, or returns why it could not. Never deletes or overwrites anything. */
async function retain(raw: string, getActiveTools: () => string[], d: SpillDeps, giant: boolean, fits: (file: string, bytes: number, node?: string) => boolean): Promise<{ path: string; bytes: number; node?: string } | string> {
  let tools: unknown;
  try { tools = getActiveTools(); } catch { return "active tools unreadable"; }
  if (!Array.isArray(tools) || !tools.includes("read")) return "read tool inactive";
  if (giant && !tools.includes("bash")) return "bash tool inactive (needed for very long lines)";
  const node = giant ? d.nodePath() : undefined;
  if (giant && !node) return "no verified Node runtime for very long lines";
  if (!wellFormed(raw)) return "output is not valid Unicode";
  const data = Buffer.from(raw, "utf8");
  const dir = d.tmpdir();
  // Complete success notice (quoted runtime, quoted saved path, script, wrappers) must fit before any I/O; checked again on the real path below.
  if (!fits(path.join(dir, `pi-qmd-${"0".repeat(16)}.txt`).replaceAll("\\", "/"), data.length, node)) return "runtime or temp path too long for a complete recovery notice";
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = path.join(dir, `pi-qmd-${d.randomHex()}.txt`);
    if (!path.isAbsolute(file) || file.length > MAX_TMP_PATH || /[\x00-\x1f\x7f]/.test(file) || (path.sep !== "\\" && file.includes("\\"))) return "temp path unsafe";
    let handle;
    try { handle = await d.open(file, "wx", 0o600); }
    catch (error) { if (attempt === 0 && (error as { code?: string })?.code === "EEXIST") continue; return "temp storage unavailable"; }
    try { await handle.writeFile(data); await handle.close(); }
    catch { try { await handle.close(); } catch { /* partial file is kept, never advertised */ } return "temp write failed"; }
    try { if ((await d.stat(file)).size !== data.length) return "temp size check failed"; } catch { return "temp size check failed"; }
    const advertised = path.sep === "\\" ? file.replaceAll("\\", "/") : file;
    if (!fits(advertised, data.length, node)) return "runtime or temp path too long for a complete recovery notice"; // file kept, never advertised
    return { path: advertised, bytes: data.length, node };
  }
  return "temp storage unavailable";
}

const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;

export async function capQmdOutput(raw: string, getActiveTools: () => string[], deps: Partial<SpillDeps> = {}): Promise<Capped> {
  if (raw.length <= PREVIEW_LIMIT) return { text: raw };
  const total = raw.length;
  let saved: Awaited<ReturnType<typeof retain>>;
  try {
    const giant = raw.split("\n").some((line) => Buffer.byteLength(line) > READ_PAGE_BYTES);
    const lineCount = raw.split("\n").length;
    const mk = (file: string, bytes: number, node: string | undefined) => (shown: number | string, line: number | string, at: number | string) => [
        "", "",
        `[qmd output capped: first ${shown} of ${total} characters shown (${bytes} bytes, ${lineCount} lines received from QMD for the requested range; not the whole document).`,
        "Full received output saved as UTF-8 for this call only; no automatic cleanup.",
        `saved file: ${file}`,
        `Line numbers below refer to the saved file, not the source document. Continue with read path=${file} offset=${line} (line ${line} may be partly shown above).`,
        ...(giant ? [`Lines over ${READ_PAGE_BYTES} bytes cannot be paged by read. Run the bash command below: it prints one JSON line {start,next,total,text}. Decode the JSON escapes in text to get the exact characters (CR and control characters are escaped, not dropped). start/next/total are UTF-16 offsets in the saved file, not the source document. Re-run with the last argument set to next until next is null:`, `bash: ${quote(node!)} -e ${quote(RECOVERY_SCRIPT)} ${quote(file)} ${at}`] : []),
        "End of qmd notice.]", // keeps the closing bracket off the copyable recipe line
      ].join("\n");
    const fits = (file: string, bytes: number, node?: string) => mk(file, bytes, node)(PREVIEW_LIMIT, 9999999, 9999999).length <= PREVIEW_LIMIT;
    saved = await retain(raw, getActiveTools, { ...defaults, ...deps }, giant, fits);
    if (typeof saved !== "string") {
      const { path: file, bytes, node } = saved;
      const notice = mk(file, bytes, node);
      const head = prefix(raw, PREVIEW_LIMIT - notice(PREVIEW_LIMIT, 9999999, 9999999).length);
      const next = head.split("\n").length;
      return { text: head + notice(head.length, next, head.length), saved: { path: file, bytes } };
    }
  } catch {
    saved = "unexpected error";
  }
  const notice = (shown: number | string) => `\n\n[qmd output capped at ${PREVIEW_LIMIT} characters: first ${shown} of ${total} characters received from QMD for the requested range are shown; the rest was not retained (full-output recovery unavailable: ${saved}). Re-request a narrower fromLine/lines range if more is needed.]`;
  const head = prefix(raw, PREVIEW_LIMIT - notice(PREVIEW_LIMIT).length);
  return { text: head + notice(head.length) };
}
