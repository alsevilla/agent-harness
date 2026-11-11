// Behavior tests for bounded QMD output recovery. Active tools, the QMD process and the Pi API are fakes; the filesystem is in-memory fake or real files under the scratch TEMP. Recovery commands are executed for real (node, and Git Bash when present) and each command's stdout is then decoded/sanitized independently the way SDK 1.5 bash does it; no SDK session, read tool, QMD or model is involved. Counts are controlled synthetic counts, not real cost/quality evidence.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { capQmdOutput, trustedNode } from "../spill.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
const QMD_DIR = path.resolve(HERE, "..");
const LIMIT = 10000;
const norm = (p: string) => p.replaceAll("\\", "/");
const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const HEX = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];
const rows = (n: number, eol = "\n") => Array.from({ length: n }, (_, i) => `row ${i + 1} ${"x".repeat(60)}${eol}`).join("");
const marker = (text: string) => text.indexOf("\n\n[qmd output capped");
const preview = (text: string) => text.slice(0, marker(text));
const savedPath = (text: string) => /^saved file: (.+)$/m.exec(text)?.[1];

type FsOpts = { pre?: Record<string, string>; writeFail?: boolean; closeFail?: boolean; statDelta?: number; statThrow?: boolean; openErr?: string; tmp?: string };
function fakeFs(opts: FsOpts = {}) {
  const files = new Map<string, Buffer>();
  const log: string[] = [];
  let hex = 0;
  const tmp = opts.tmp ?? path.resolve("/qmdtmp");
  for (const [name, body] of Object.entries(opts.pre ?? {})) files.set(norm(path.join(tmp, name)), Buffer.from(body));
  const deps = {
    tmpdir: () => { log.push("tmpdir"); return tmp; },
    randomHex: () => HEX[hex++] ?? "dddddddddddddddd",
    open: async (p: string, flag: string, mode: number) => {
      log.push(`open ${flag} ${mode.toString(8)}`);
      if (opts.openErr) throw Object.assign(new Error(opts.openErr), { code: opts.openErr });
      const key = norm(p);
      if (files.has(key)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(key, Buffer.alloc(0));
      return {
        writeFile: async (data: Uint8Array) => {
          if (opts.writeFail) { files.set(key, Buffer.from(data).subarray(0, 10)); throw new Error("ENOSPC"); }
          files.set(key, Buffer.from(data));
        },
        close: async () => { log.push("close"); if (opts.closeFail) throw new Error("EIO"); },
      };
    },
    stat: async (p: string) => {
      log.push("stat");
      if (opts.statThrow) throw new Error("EIO");
      return { size: files.get(norm(p))!.length + (opts.statDelta ?? 0) };
    },
  };
  return { files, log, deps };
}
const both = () => ["read", "bash", "edit"];

/** Fake of the built-in read tool: 1-indexed line offset, 2000 lines / 50000 bytes per page, a line over the byte cap cannot be shown. */
function fakeRead(files: Map<string, Buffer>, p: string, offset: number) {
  const lines = files.get(norm(p))!.toString("utf8").split("\n");
  const out: string[] = [];
  let bytes = 0;
  let i = offset - 1;
  for (; i < lines.length && out.length < 2000; i++) {
    const size = Buffer.byteLength(lines[i]) + 1;
    if (size > 50000) { if (out.length === 0) throw new Error("line exceeds read limit"); break; }
    if (bytes + size > 50000) break;
    out.push(lines[i]); bytes += size;
  }
  return { lines: out, next: i < lines.length ? i + 1 : undefined };
}
// ---- recovery of very long lines: the advertised bash command is really executed, one process per chunk ----
const NODE = process.execPath.replaceAll("\\", "/");
const GIT_BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
// Dedicated fixture root owned by this file: every real-file fixture lives below it, whatever the ambient temp dir is called. TEMP/TMP/TMPDIR point inside it so the producer's own os.tmpdir() spill files stay in it too; both are restored and the root removed afterwards.
const FIXTURE_ROOT = mkdtempSync(path.join(os.tmpdir(), "qmd-spill-test-"));
const probeTmp = path.join(FIXTURE_ROOT, "tmp");
mkdirSync(probeTmp);
const savedTmpEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = process.env.TMP = process.env.TMPDIR = probeTmp;
after(() => {
  for (const [k, v] of Object.entries(savedTmpEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(FIXTURE_ROOT, { recursive: true, force: true, maxRetries: 3 });
});
const scratchDir = (name: string) => { const d = path.join(mkdtempSync(path.join(FIXTURE_ROOT, "qmd-rec-")), name); mkdirSync(d, { recursive: true }); return d; };
const realDeps = (dir: string) => ({ tmpdir: () => dir, nodePath: () => NODE });
/** Splits a command into words; supports bare words, single quotes and a backslash-escaped character outside quotes (the `'\''` idiom the notice emits). */
function shellWords(line: string) {
  const words: string[] = [];
  let cur = "", open = false, quoted = false, escaped = false;
  for (const ch of line) {
    if (escaped) { cur += ch; escaped = false; }
    else if (quoted) { if (ch === "'") quoted = false; else cur += ch; }
    else if (ch === "\\") { escaped = true; open = true; }
    else if (ch === "'") { quoted = true; open = true; }
    else if (ch === " ") { if (open) words.push(cur); cur = ""; open = false; }
    else { cur += ch; open = true; }
  }
  assert.ok(!quoted, "unbalanced quote in recipe");
  if (open) words.push(cur);
  return words;
}
/** Model-visible result of ONE bash command in SDK 1.5: its own TextDecoder, ANSI strip, binary sanitize, CR removal; 50 KB / 2000 line output cap. */
function sdkBashView(stdout: Buffer) {
  assert.ok(stdout.length <= 50 * 1024, `command output ${stdout.length} bytes exceeds the bash cap`);
  const text = new TextDecoder().decode(stdout).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "").replace(/\r/g, "");
  assert.ok(text.split("\n").filter(Boolean).length <= 2000);
  return text;
}
const recipeLine = (text: string) => /^bash: (.+)$/m.exec(text)![1];
const viaWords = (command: string) => { const w = shellWords(command); const r = spawnSync(w[0], w.slice(1)); assert.equal(r.status, 0, String(r.stderr)); return r.stdout; };
const viaBash = (command: string) => { const r = spawnSync(GIT_BASH, ["-c", command]); assert.equal(r.status, 0, String(r.stderr)); return r.stdout; };
/** Preview + every chunk, each chunk decoded and sanitized independently, joined as TEXT. Offsets are UTF-16 units of the saved output. */
function recover(text: string, run: (c: string) => Buffer, counter = { calls: 0 }, source?: string) {
  const cmd = recipeLine(text);
  const parts = [preview(text)];
  let at = Number(/ (\d+)$/.exec(cmd)![1]);
  assert.equal(at, preview(text).length, "first offset is where the preview stopped, in saved-output units");
  for (;;) {
    counter.calls++;
    const view = sdkBashView(run(cmd.replace(/ \d+$/, ` ${at}`)));
    const j = JSON.parse(view) as { start: number; next: number | null; total: number; text: string };
    assert.equal(j.start, at);
    assert.ok(wellFormed(j.text), "chunk never splits a surrogate pair");
    if (source !== undefined) { assert.equal(j.total, source.length); assert.equal(j.text, source.slice(at, j.next ?? source.length)); }
    parts.push(j.text);
    if (j.next === null) break;
    assert.ok(j.next > at, "continuation must advance");
    at = j.next;
  }
  return parts.join("");
}
function reconstructByRead(files: Map<string, Buffer>, text: string, counter = { read: 0 }) {
  const p = savedPath(text)!;
  const first = Number(/offset=(\d+)/.exec(text)![1]);
  const prev = preview(text);
  const kept = prev.slice(0, prev.lastIndexOf("\n") + 1);
  assert.equal(kept.split("\n").length - 1, first - 1);
  const rest: string[] = [];
  for (let offset: number | undefined = first; offset;) {
    counter.read++;
    const page = fakeRead(files, p, offset);
    rest.push(...page.lines); offset = page.next;
  }
  return kept + rest.join("\n");
}

test("under or exactly at the limit: byte-identical, no tool lookup, no I/O", async () => {
  const boom = () => { throw new Error("must not be called"); };
  const deps = { tmpdir: boom, randomHex: boom, open: boom, stat: boom };
  for (const raw of ["", "short", "é".repeat(LIMIT), "😀".repeat(LIMIT / 2)]) {
    assert.equal((await capQmdOutput(raw, boom, deps)).text, raw);
  }
  assert.equal(((await capQmdOutput("x".repeat(LIMIT), boom, deps)) as { saved?: unknown }).saved, undefined);
});

test("one character over: saves exact stdout, total preview+notice stays within 10000 UTF-16 units", async () => {
  for (const size of [LIMIT + 1, 12345, 90000]) {
    const raw = "é".repeat(size);
    const fs = fakeFs();
    const out = await capQmdOutput(raw, both, fs.deps);
    assert.ok(out.text.length <= LIMIT, `total ${out.text.length}`);
    assert.ok(out.text.length >= LIMIT - 2500, "notice overhead must stay small (the giant-line recipe adds ~1 KB)");
    assert.ok(preview(out.text).length > 5000);
    assert.ok(raw.startsWith(preview(out.text)));
    assert.equal(out.saved?.bytes, Buffer.byteLength(raw));
    assert.equal(savedPath(out.text), out.saved?.path);
    assert.equal(fs.files.get(norm(out.saved!.path))!.toString("utf8"), raw);
    assert.deepEqual(fs.log.filter((l) => l.startsWith("open")), ["open wx 600"]);
    assert.match(out.text, /requested range/);
    assert.match(out.text, /not the whole document/);
    assert.match(out.text, /not the source document/);
  }
});

test("UTF-8 and surrogate pairs: never cut a pair, saved file is lossless", async () => {
  for (let pad = 0; pad < 6; pad++) {
    const raw = "a".repeat(pad) + "😀é".repeat(6000);
    const fs = fakeFs();
    const out = await capQmdOutput(raw, both, fs.deps);
    assert.ok(out.text.length <= LIMIT);
    assert.ok(wellFormed(out.text), `pad ${pad}`);
    assert.ok(wellFormed(preview(out.text)));
    assert.equal(fs.files.get(norm(out.saved!.path))!.toString("utf8"), raw);
  }
});

test("CRLF multi-line: next offset counts saved-file lines; read paging reconstructs exactly", async () => {
  const raw = rows(400, "\r\n");
  const fs = fakeFs();
  const out = await capQmdOutput(raw, both, fs.deps);
  assert.ok(!/bash:/.test(out.text), "no byte recipe needed without giant lines");
  assert.match(out.text, /read path=.+ offset=\d+/);
  const counter = { read: 0 };
  assert.equal(reconstructByRead(fs.files, out.text, counter), raw);
  assert.ok(counter.read >= 1);
  const noTrailing = rows(400).slice(0, -1);
  const again = await capQmdOutput(noTrailing, both, fakeFs().deps);
  assert.equal(again.text.includes("offset="), true);
});

test("defect model: cutting UTF-8 at a fixed byte count and decoding each command alone loses characters", () => {
  const bytes = Buffer.from("漢".repeat(30000));
  const first = new TextDecoder().decode(bytes.subarray(0, 50000));
  const second = new TextDecoder().decode(bytes.subarray(50000));
  assert.ok(first.includes("\uFFFD") && second.includes("\uFFFD"));
  assert.notEqual(first + second, "漢".repeat(30000));
});

test("trustedNode: only a verified Node executable is used; standalone/Bun/relative/odd paths are refused", () => {
  assert.equal(trustedNode("C:\\Program Files\\nodejs\\node.exe"), "C:/Program Files/nodejs/node.exe");
  assert.equal(trustedNode("/usr/local/bin/node"), "/usr/local/bin/node");
  for (const p of ["C:\\Users\\x\\pi.exe", "/opt/pi/pi", "C:\\x\\node-wrapper.exe", "node", "./node", "", "/tmp/a\nb/node", "/tmp/nodex"]) assert.equal(trustedNode(p), undefined, p);
  assert.equal(trustedNode("/usr/bin/node", "1.2.3"), undefined, "Bun reports its version here");
  assert.equal(trustedNode(undefined as unknown as string), undefined);
});

test("giant CJK line + CRLF + controls: each command decoded alone reconstructs the exact received text", async () => {
  const CTRL = "\x00\x01\x07\x08\x0b\x0c\x0e\x1b[31m\x1f\x7f\u0085\u009f\ufff9\ufffb\u2028\u2029\ufeff\"\\' \t";
  const raw = CTRL + "漢".repeat(30000) + "\r\n" + "😀".repeat(20000) + "\r\nline\r\n" + "\x01".repeat(60000) + CTRL;
  const dir = scratchDir("giant");
  const out = await capQmdOutput(raw, both, realDeps(dir));
  assert.ok(out.text.length <= LIMIT && wellFormed(out.text));
  assert.equal(readFileSync(out.saved!.path, "utf8"), raw);
  assert.throws(() => fakeRead(new Map([[norm(out.saved!.path), readFileSync(out.saved!.path)]]), out.saved!.path, 1), /exceeds/, "read alone cannot page this line");
  const counter = { calls: 0 };
  assert.equal(recover(out.text, viaWords, counter, raw), raw);
  assert.ok(counter.calls >= 10, `calls ${counter.calls}`);
});

test("chunk boundaries never split supplementary characters; worst-case escaping stays under the cap", async () => {
  for (let pad = 0; pad < 4; pad++) {
    const raw = "a".repeat(pad) + "😀".repeat(25000) + "é".repeat(30000);
    const out = await capQmdOutput(raw, both, realDeps(scratchDir(`pad${pad}`)));
    assert.equal(recover(out.text, viaWords, { calls: 0 }, raw), raw, `pad ${pad}`);
  }
  const worst = "\x01".repeat(100000); // 6 bytes per UTF-16 unit once escaped
  const out = await capQmdOutput(worst, both, realDeps(scratchDir("worst")));
  let at = Number(/ (\d+)$/.exec(recipeLine(out.text))![1]);
  let calls = 0;
  for (; ; calls++) {
    const stdout = viaWords(recipeLine(out.text).replace(/ \d+$/, ` ${at}`));
    assert.ok(stdout.length <= 40200, `payload ${stdout.length}`);
    const j = JSON.parse(sdkBashView(stdout));
    if (j.next === null) break;
    at = j.next;
  }
  assert.ok(calls >= 2);
});

test("recipe quoting: space, apostrophe and non-ASCII path; real Git Bash when present; offsets refer to the saved output", async (t) => {
  const raw = "é漢".repeat(40000) + "\r\nend";
  const dir = scratchDir("it's é 漢 dir");
  const out = await capQmdOutput(raw, both, realDeps(dir));
  const words = shellWords(recipeLine(out.text));
  assert.deepEqual([words[0], words[1], words[3]], [NODE, "-e", norm(out.saved!.path)]);
  assert.match(out.text, /^bash: .+ \d+$/m, "recipe line ends with the offset, nothing glued to it");
  assert.match(out.text, /\nEnd of qmd notice\.\]$/);
  assert.match(out.text, /saved file, not the source document/);
  assert.equal(recover(out.text, viaWords, { calls: 0 }, raw), raw);
  if (!existsSync(GIT_BASH)) return t.skip(`no bash at ${GIT_BASH}`);
  assert.equal(recover(out.text, viaBash, { calls: 0 }, raw), raw);
});

test("a node path with spaces is single-quoted as the first word", async () => {
  const out = await capQmdOutput("é".repeat(120000), both, { ...fakeFs().deps, nodePath: () => "C:/Program Files/nodejs/node.exe" });
  assert.equal(shellWords(recipeLine(out.text))[0], "C:/Program Files/nodejs/node.exe");
  assert.match(recipeLine(out.text), /^'C:\/Program Files\/nodejs\/node\.exe' -e '/);
});

test("later giant line: next offset reaches it and the recipe is advertised", async () => {
  const raw = rows(5) + "y".repeat(120000) + "\n" + rows(3);
  const out = await capQmdOutput(raw, both, realDeps(scratchDir("later")));
  assert.ok(out.text.length <= LIMIT);
  assert.equal(recover(out.text, viaWords, { calls: 0 }, raw), raw);
  const wholeLines = preview(out.text).split("\n").length;
  assert.equal(Number(/offset=(\d+)/.exec(out.text)![1]), wholeLines);
});

test("very long line without a verified Node (or with a throwing runtime lookup): truthful unavailable notice, nothing written", async () => {
  const giant = "é".repeat(120000);
  for (const nodePath of [() => undefined, () => { throw new Error("x"); }]) {
    const fs = fakeFs();
    const out = await capQmdOutput(giant, both, { ...fs.deps, nodePath: nodePath as () => string });
    assert.equal((out as { saved?: unknown }).saved, undefined);
    assert.equal(fs.files.size, 0);
    assert.match(out.text, /not retained/);
    assert.match(out.text, /recovery unavailable/);
    assert.doesNotMatch(out.text, /saved file|bash:|-e /);
    assert.ok(out.text.length <= LIMIT);
  }
});

test("ordinary multi-line output does not need Node: read paging only", async () => {
  const fs = fakeFs();
  const out = await capQmdOutput(rows(400), both, { ...fs.deps, nodePath: () => undefined });
  assert.ok(out.saved && !/bash:/.test(out.text));
});

test("missing, throwing or insufficient tools: truthful capped notice, no path, no I/O", async () => {
  const raw = rows(400);
  const giant = "y".repeat(60000) + "\n" + rows(10);
  const cases: [string, () => string[], string][] = [
    ["getter throws", () => { throw new Error("boom"); }, raw],
    ["no tools", () => [], raw],
    ["bash only", () => ["bash"], raw],
    ["powershell only", () => ["powershell"], raw],
    ["non-array", (() => undefined) as unknown as () => string[], raw],
    ["giant line without bash", () => ["read", "powershell"], giant],
  ];
  for (const [name, tools, body] of cases) {
    const fs = fakeFs();
    const out = await capQmdOutput(body, tools, fs.deps);
    assert.equal((out as { saved?: unknown }).saved, undefined, name);
    assert.deepEqual(fs.log, [], name);
    assert.ok(out.text.length <= LIMIT, name);
    assert.ok(body.startsWith(preview(out.text)) && preview(out.text).length > 8000, name);
    assert.match(out.text, /not retained/, name);
    assert.match(out.text, /recovery unavailable/, name);
    assert.doesNotMatch(out.text, /saved file|offset=|tail -c|qmdtmp/, name);
  }
});

test("storage failures never advertise a path or hide the original outcome; no file is ever deleted", async () => {
  const raw = rows(400);
  const failing: [string, FsOpts][] = [
    ["unwritable tmpdir", { openErr: "EACCES" }],
    ["partial write", { writeFail: true }],
    ["close failure", { closeFail: true }],
    ["size mismatch", { statDelta: -1 }],
    ["stat failure", { statThrow: true }],
    ["two collisions", { pre: { "pi-qmd-aaaaaaaaaaaaaaaa.txt": "OLD1", "pi-qmd-bbbbbbbbbbbbbbbb.txt": "OLD2" } }],
  ];
  for (const [name, opts] of failing) {
    const fs = fakeFs(opts);
    const before = new Map(fs.files);
    const out = await capQmdOutput(raw, both, fs.deps);
    assert.equal((out as { saved?: unknown }).saved, undefined, name);
    assert.doesNotMatch(out.text, /saved file|offset=|qmdtmp/, name);
    assert.match(out.text, /not retained/, name);
    assert.ok(out.text.length <= LIMIT, name);
    for (const [k, v] of before) assert.equal(fs.files.get(k)!.toString(), v.toString(), `${name}: preexisting file preserved`);
    assert.ok(fs.files.size >= before.size, `${name}: nothing deleted`);
  }
  const partial = fakeFs({ writeFail: true });
  await capQmdOutput(raw, both, partial.deps);
  assert.equal([...partial.files.values()][0].length, 10, "partial file kept, not unlinked");
});

test("EEXIST retries once with a new random name and preserves the old file", async () => {
  const raw = rows(400);
  const fs = fakeFs({ pre: { "pi-qmd-aaaaaaaaaaaaaaaa.txt": "OLD" } });
  const out = await capQmdOutput(raw, both, fs.deps);
  assert.match(out.saved!.path, /pi-qmd-bbbbbbbbbbbbbbbb\.txt$/);
  assert.equal(fs.files.get(norm(path.join(path.resolve("/qmdtmp"), "pi-qmd-aaaaaaaaaaaaaaaa.txt")))!.toString(), "OLD");
  assert.equal(fs.log.filter((l) => l.startsWith("open")).length, 2);
});

test("unsafe text or unsafe temp path: nothing written", async () => {
  const lone = rows(400) + "\uD800tail";
  let fs = fakeFs();
  let out = await capQmdOutput(lone, both, fs.deps);
  assert.equal(fs.files.size, 0);
  assert.match(out.text, /not retained/);
  for (const tmp of ["/tmp/new\nline", "relative-dir", "/" + "d".repeat(600)]) {
    fs = fakeFs({ tmp });
    out = await capQmdOutput(rows(400), both, fs.deps);
    assert.equal(fs.files.size, 0, tmp.slice(0, 20));
    assert.equal((out as { saved?: unknown }).saved, undefined);
    assert.match(out.text, /not retained/);
  }
});

test("tmpdir is read per call", async () => {
  const a = fakeFs({ tmp: path.resolve("/qmdtmp-a") });
  const b = fakeFs({ tmp: path.resolve("/qmdtmp-b") });
  const deps = { ...a.deps, tmpdir: () => (deps.n++ === 0 ? a.deps.tmpdir() : b.deps.tmpdir()), n: 0, open: (p: string, f: string, m: number) => (p.includes("qmdtmp-a") ? a : b).deps.open(p, f, m), stat: (p: string) => (p.includes("qmdtmp-a") ? a : b).deps.stat(p) };
  const one = await capQmdOutput(rows(400), both, deps);
  const two = await capQmdOutput(rows(400), both, deps);
  assert.match(one.saved!.path, /qmdtmp-a/);
  assert.match(two.saved!.path, /qmdtmp-b/);
});

// ---- producer-shaped wiring: real index.ts + spill.ts copied beside a synthetic config; fake Pi API and fake QMD process ----
const spawns: { args: string[] }[] = [];
let nextOut: { stdout: string[]; code: number; stderr?: string } = { stdout: [], code: 0 };
(globalThis as Record<string, unknown>).__qmdFakeSpawn = (_node: string, args: string[]) => {
  spawns.push({ args });
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const plan = nextOut;
  setImmediate(() => {
    for (const chunk of plan.stdout) child.stdout.emit("data", Buffer.from(chunk));
    if (plan.stderr) child.stderr.emit("data", Buffer.from(plan.stderr));
    child.emit("close", plan.code);
  });
  return child;
};
async function loadProducer(activeTools: () => string[], configured = true) {
  const dir = mkdtempSync(path.join(probeTmp, "qmd-wiring-"));
  copyFileSync(path.join(QMD_DIR, "spill.ts"), path.join(dir, "spill.ts"));
  const source = readFileSync(path.join(QMD_DIR, "index.ts"), "utf8").replace('from "node:child_process"', 'from "./fake-child.mjs"')
    .replace('../../skills/qmd/scripts/qmd.mjs', pathToFileURL(path.resolve(QMD_DIR, '../../skills/qmd/scripts/qmd.mjs')).href);
  assert.ok(source.includes("./fake-child.mjs"));
  writeFileSync(path.join(dir, "index.ts"), source);
  writeFileSync(path.join(dir, "fake-child.mjs"), "export const spawn = (...a) => globalThis.__qmdFakeSpawn(...a);\n");
  if (configured) writeFileSync(path.join(dir, "config.json"), JSON.stringify({ nodePath: process.execPath, cliPath: path.join(dir, "spill.ts"), timeoutMs: 5000 }));
  const types = path.join(dir, "node_modules", "typebox");
  mkdirSync(types, { recursive: true });
  writeFileSync(path.join(types, "package.json"), '{"name":"typebox","type":"module","main":"index.js"}');
  writeFileSync(path.join(types, "index.js"), "const f = (k) => (...a) => ({ kind: k, a });\nexport const Type = { Object: f('o'), String: f('s'), Optional: f('opt'), Integer: f('i') };\n");
  const tools: Record<string, any> = {};
  const pi = { registerTool: (t: any) => { tools[t.name] = t; }, getActiveTools: activeTools };
  const mod = await import(pathToFileURL(path.join(dir, "index.ts")).href);
  mod.default(pi);
  return tools;
}
const ctx = { cwd: "." };
const run = (tool: any, params: object) => tool.execute("id", params, undefined, () => {}, ctx);

test("wiring: qmd_get under the limit keeps the exact legacy result", async () => {
  const tools = await loadProducer(() => { throw new Error("must not be asked"); });
  nextOut = { stdout: ["hello\n"], code: 0 };
  const r = await run(tools.qmd_get, { document: "d.md" });
  assert.deepEqual(r, { content: [{ type: "text", text: "hello\n" }], details: { document: "d.md", fromLine: 1, requestedLines: 40, truncated: false } });
});

test("wiring: over-limit qmd_get and qmd_status save once, keep legacy details, add path/bytes only when saved; one QMD execution, zero reruns", async () => {
  const tools = await loadProducer(both);
  const raw = rows(400, "\r\n");
  spawns.length = 0;
  nextOut = { stdout: [raw.slice(0, 7001), raw.slice(7001)], code: 0 };
  const r = await run(tools.qmd_get, { document: "my doc.md", fromLine: 3, lines: 100 });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(-2), ["get", "my doc.md:3:100"]);
  const d = r.details;
  assert.equal(d.document, "my doc.md"); assert.equal(d.fromLine, 3); assert.equal(d.requestedLines, 100); assert.equal(d.truncated, true);
  assert.equal(d.fullOutputBytes, Buffer.byteLength(raw));
  assert.ok(path.isAbsolute(d.fullOutputPath) && d.fullOutputPath.startsWith(norm(probeTmp)));
  assert.equal(readFileSync(d.fullOutputPath, "utf8"), raw);
  const text = r.content[0].text;
  assert.ok(text.length <= LIMIT && savedPath(text) === d.fullOutputPath);
  const files = new Map([[norm(d.fullOutputPath), readFileSync(d.fullOutputPath)]]);
  const counter = { read: 0 };
  assert.equal(reconstructByRead(files, text, counter), raw);
  assert.equal(spawns.length, 1, "recovery never re-executes QMD");
  assert.ok(counter.read >= 1);
  nextOut = { stdout: [raw], code: 0 };
  const s = await run(tools.qmd_status, {});
  assert.equal(s.details.backend, "qmd");
  assert.ok(s.details.fullOutputPath && s.details.fullOutputPath !== d.fullOutputPath, "separate temp file per call");
  assert.deepEqual(Object.keys(s.details).sort(), ["backend", "fullOutputBytes", "fullOutputPath"]);
});

test("wiring: giant CJK/CRLF qmd_get output is recoverable through the advertised command; one QMD execution, zero reruns", async () => {
  const tools = await loadProducer(both);
  const raw = "\x1b[1m" + "\u6f22".repeat(30000) + "\r\n" + "tail\r\n";
  spawns.length = 0;
  nextOut = { stdout: [raw.slice(0, 20001), raw.slice(20001)], code: 0 };
  const r = await run(tools.qmd_get, { document: "d.md" });
  const counter = { calls: 0 };
  assert.equal(recover(r.content[0].text, viaWords, counter, raw), raw);
  assert.ok(counter.calls >= 2, `calls ${counter.calls}`);
  assert.equal(spawns.length, 1, "recovery never re-executes QMD");
});

test("wiring: tmpdir env is honored per call", async () => {
  const tools = await loadProducer(both);
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const roots = ["a", "b"].map((n) => { const d = path.join(mkdtempSync(path.join(probeTmp, "qmd-env-")), n); mkdirSync(d); return d; });
  try {
    const seen: string[] = [];
    for (const root of roots) {
      process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
      nextOut = { stdout: [rows(400)], code: 0 };
      seen.push((await run(tools.qmd_status, {})).details.fullOutputPath);
    }
    assert.ok(seen[0].startsWith(norm(roots[0])) && seen[1].startsWith(norm(roots[1])));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("wiring: no read tool or throwing getter keeps the successful outcome with a truthful capped notice", async () => {
  for (const active of [() => ["bash"], () => { throw new Error("x"); }]) {
    const tools = await loadProducer(active);
    nextOut = { stdout: [rows(400)], code: 0 };
    const r = await run(tools.qmd_get, { document: "d" });
    assert.deepEqual(Object.keys(r.details).sort(), ["document", "fromLine", "requestedLines", "truncated"]);
    assert.equal(r.details.truncated, true);
    assert.ok(r.content[0].text.length <= LIMIT);
    assert.match(r.content[0].text, /not retained/);
    const s = await run(tools.qmd_status, {});
    assert.deepEqual(s.details, { backend: "qmd" });
    assert.match(s.content[0].text, /not retained/);
  }
});

test("wiring: genuine QMD failures and the 256000 stdout guard are unchanged and never consult tools", async () => {
  let asked = 0;
  const tools = await loadProducer(() => { asked++; return both(); });
  nextOut = { stdout: ["partial"], code: 3, stderr: "bad doc" };
  await assert.rejects(run(tools.qmd_get, { document: "d" }), { message: "QMD exited 3: bad doc" });
  nextOut = { stdout: ["x".repeat(256001)], code: 0 };
  await assert.rejects(run(tools.qmd_status, {}), { message: "QMD output exceeded retrieval limit." });
  assert.equal(asked, 0);
});

test("wiring: tool descriptions state the cap and temp-file recovery", async () => {
  const tools = await loadProducer(both);
  for (const name of ["qmd_get", "qmd_status"]) assert.match(tools[name].description, /10000 characters.*temp/s, name);
  assert.ok(existsSync(path.join(QMD_DIR, "spill.ts")));
});

// ---- complete success notice must fit in 10000 units for any accepted runtime path (pure fake path strings, no real install) ----
const apostropheNode = (n: number) => `/${"'".repeat(n)}/node`;
const giantLine = "a".repeat(60000);

test("notice bound: a 2515-byte apostrophe-heavy Node path never yields an oversized notice or a false handle", async () => {
  const node = "/" + ("'".repeat(250) + "/").repeat(10) + "node";
  assert.equal(trustedNode(node), node);
  const fs = fakeFs();
  const out = await capQmdOutput(giantLine, both, { ...fs.deps, nodePath: () => node });
  assert.ok(out.text.length <= LIMIT, `total ${out.text.length}`);
  assert.equal(out.saved, undefined);
  assert.doesNotMatch(out.text, /saved file:|bash:|offset=/);
  assert.doesNotMatch(out.text, /'{5}/, "no raw path reflection");
  assert.match(out.text, /retention|unavailable/);
  assert.ok(preview(out.text).length > 5000, "truthful unavailable notice keeps a preview");
  assert.deepEqual(fs.log.filter((l) => l.startsWith("open")), [], "rejected before I/O");
});

test("notice bound: ordinary long and spaced Node paths keep a complete, copyable, in-cap notice", async () => {
  const node = "/opt/" + "long dir name/".repeat(40) + "node";
  const fs = fakeFs();
  const out = await capQmdOutput(giantLine, both, { ...fs.deps, nodePath: () => node });
  assert.ok(out.text.length <= LIMIT);
  assert.ok(out.saved);
  assert.equal(shellWords(recipeLine(out.text))[0], node);
  assert.equal(shellWords(recipeLine(out.text))[3], out.saved!.path);
});

test("notice bound: exact cap boundary, complete notice on one side and truthful unavailable on the other", async () => {
  const run = async (n: number, hex?: () => string) => {
    const fs = fakeFs();
    const out = await capQmdOutput(giantLine, both, { ...fs.deps, nodePath: () => apostropheNode(n), ...(hex ? { randomHex: hex } : {}) });
    assert.ok(out.text.length <= LIMIT, `n=${n} total ${out.text.length}`);
    return { out, fs };
  };
  let lo = 0, hi = 2600; // lo fits, hi does not
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((await run(mid)).out.saved) lo = mid; else hi = mid; }
  const fit = await run(lo);
  assert.ok(fit.out.saved && fit.out.text.includes("End of qmd notice.]"));
  assert.equal(shellWords(recipeLine(fit.out.text))[0], apostropheNode(lo));
  const over = await run(hi);
  assert.equal(over.out.saved, undefined);
  assert.doesNotMatch(over.out.text, /saved file:|bash:/);
  assert.equal(over.fs.files.size, 0);
  // a saved name longer than the pre-I/O estimate: the file is created, kept, never advertised
  const late = await run(lo, () => "e".repeat(80));
  assert.equal(late.out.saved, undefined);
  assert.equal(late.fs.files.size, 1, "created file is preserved, not cleaned up");
  assert.doesNotMatch(late.out.text, /saved file:|bash:/);
});


test("wiring: absent adjacent config uses the profile config and preserves its named index", async () => {
  const profile = mkdtempSync(path.join(probeTmp, "qmd-profile-"));
  const configDir = path.join(profile, "extensions", "qmd");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ nodePath: process.execPath, cliPath: path.join(QMD_DIR, "spill.ts"), indexName: "decisions" }));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  try {
    const tools = await loadProducer(both, false);
    nextOut = { stdout: ["[]"], code: 0 };
    await run(tools.qmd_search, { query: "queue" });
    assert.deepEqual(spawns.at(-1)!.args.slice(1, 3), ["--index", "decisions"]);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  }
});

test("wiring: missing configured CLI does not break registration and fails only the lookup", async () => {
  const before = process.env.HARNESS_QMD_CLI;
  process.env.HARNESS_QMD_CLI = path.join(probeTmp, "absent-qmd.js");
  try {
    const tools = await loadProducer(both, false);
    assert.deepEqual(Object.keys(tools).sort(), ["qmd_get", "qmd_search", "qmd_status"]);
    await assert.rejects(run(tools.qmd_status, {}), /HARNESS_QMD_CLI does not name a file/);
    // A missing QMD is not remembered: once it is installed, the next lookup in the same session finds it.
    writeFileSync(process.env.HARNESS_QMD_CLI, "");
    nextOut = { stdout: ["ok"], code: 0 };
    await run(tools.qmd_status, {});
    assert.equal(spawns.at(-1)!.args[0], process.env.HARNESS_QMD_CLI);
  } finally {
    if (before === undefined) delete process.env.HARNESS_QMD_CLI;
    else process.env.HARNESS_QMD_CLI = before;
  }
});
