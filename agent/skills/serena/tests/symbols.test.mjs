// serena skill, heuristic fallback (symbols.mjs): symbol ranges for Rust, TSX and Python, masking of strings, comments, regex literals and JSX, and the three commands.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findCommand, maskCode, refsCommand, symbolsOf } from "../scripts/symbols.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/symbols.mjs", import.meta.url));
const names = (symbols) => symbols.map((s) => `${s.kind} ${s.path} ${s.start}-${s.end}`);

const RUST = `use std::fmt;

/// Doc with a brace { that must not count
pub struct Queue {
    items: Vec<String>,
}

impl Queue {
    pub fn push(&mut self, s: &str) {
        let close = "}";
        let c = '{';
        self.items.push(format!("{}{}", s, close));
    }

    fn len<'a>(&'a self) -> usize { self.items.len() }
}

impl fmt::Display for Queue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, r#"queue "{" {}"#, self.items.len())
    }
}

pub trait Sender {
    fn send(&self, to: &str) -> bool;
}

pub(crate) const LIMIT: usize = 3;

pub async fn drain(q: &mut Queue) {
    fn helper() {}
    q.push("x");
}
`;

const TSX = `import { For } from "solid-js";

export type Props = {
  items: string[];
};

const PATTERN = /[{}]/g;

export function List(props: Props) {
  return (
    <ul>
      <For each={props.items}>{(item) => <li class="x">{item === "}" ? "close" : item}</li>}</For>
    </ul>
  );
}

export const Row = ({ label }: { label: string }) => {
  const inner = () => label;
  return <span>{\`row \${inner()} }\`}</span>;
};

export class Store {
  private count = 0;
  add(n: number): void {
    this.count += n;
  }
  reset = () => {
    this.count = 0;
  };
}

interface Api {
  get(id: string): Promise<string>;
}
`;

const PY = `class Repo:
    """A brace { in a docstring."""

    def get(self, key):
        return self.data[key]

    def put(self, key, value):
        self.data[key] = value


def build(name):
    def inner():
        return name
    return inner
`;

test("Rust: items, impl methods, trait methods and ranges; strings, chars, raw strings and lifetimes do not break braces", () => {
	assert.deepEqual(names(symbolsOf(RUST, "rust")), [
		"struct Queue 4-6", "impl Queue 8-16", "method Queue/push 9-13", "method Queue/len 15-15",
		"impl Queue 18-22", "method Queue/fmt 19-21", "trait Sender 24-26", "method Sender/send 25-25",
		"const LIMIT 28-28", "fn drain 30-33",
	]);
	assert.equal(symbolsOf(RUST, "rust")[4].name, "fmt::Display for Queue", "an impl names its trait and type");
});

test("TSX: functions, arrow components, classes with members, types and interfaces; JSX, templates and regex literals are masked", () => {
	assert.deepEqual(names(symbolsOf(TSX, "ts")), [
		"type Props 3-5", "const PATTERN 7-7", "fn List 9-15", "fn Row 17-20",
		"class Store 22-30", "method Store/add 24-26", "method Store/reset 27-29", "interface Api 32-34", "method Api/get 33-33",
	]);
	const masked = maskCode('const a = "{"; // }\nconst b = /}/;', "ts");
	assert.equal(masked.includes("{") || masked.includes("}"), false, "no brace survives in strings, comments or regex literals");
	assert.equal(maskCode("x = <a>b</a>; y = <br />;", "ts"), "x = <a>b</a>; y = <br />;", "JSX closing and self-closing tags are code");
});

test("Python: classes, methods and functions by indentation; nested functions stay out", () => {
	assert.deepEqual(names(symbolsOf(PY, "py")), ["class Repo 1-8", "method Repo/get 4-5", "method Repo/put 7-8", "fn build 11-14"]);
});

test("commands: outline, find with body, refs without strings, comments or the definition", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-heuristic-"));
	try {
		fs.mkdirSync(path.join(dir, "src"));
		fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
		fs.writeFileSync(path.join(dir, "src", "queue.rs"), RUST);
		fs.writeFileSync(path.join(dir, "src", "use.rs"), 'fn main() {\n    let mut q = Queue { items: vec![] };\n    drain(&mut q); // drain again later\n    println!("drain");\n}\n');
		fs.writeFileSync(path.join(dir, "node_modules", "dep", "x.rs"), "fn drain() {}\n");
		const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
		const outline = run("outline", "src/queue.rs");
		assert.equal(outline.status, 0, outline.stderr);
		assert.match(outline.stdout, /^src\/queue\.rs \(34 lines, 10 symbols\)\n  struct Queue  L4-6\n  impl Queue  L8-16\n    method push  L9-13/);
		const found = run("find", "Queue/push", "--body").stdout;
		assert.match(found, /^1 definition of Queue\/push\nsrc\/queue\.rs:9-13  method  Queue\/push\n {5}9 {6}pub fn push/);
		assert.match(run("find", "drain").stdout, /^1 definition of drain\nsrc\/queue\.rs:30-33  fn  drain$/m, "node_modules is skipped");
		const refs = run("refs", "drain").stdout.trim();
		assert.match(refs, /^1 reference to drain in 1 file\nsrc\/use\.rs:3  \[main\]  drain\(&mut q\); \/\/ drain again later$/);
		assert.equal(run("refs", "drain", "src/queue.rs").stdout.trim(), "no code references to drain (strings and comments are excluded; grep finds those)");
		assert.match(findCommand("Missing", [dir]), /no definition of Missing found/);
		assert.throws(() => refsCommand("a b", [dir]), /one identifier/);
		const bad = run("frobnicate");
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /usage:/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
