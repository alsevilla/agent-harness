---
name: code-symbols
description: Outline a source file, find where a symbol is defined (with its body) and list its code references, for Rust, TypeScript/JavaScript and Python, through one dependency-free Node helper. Use it before reading a large source file whole and before grep or find when the packet does not locate the code.
---

# code-symbols

One read-only Node script, `scripts/symbols.mjs` in this folder. It needs no language server, package install or tool schema; run it with the shell from the candidate root. Paths in its output are relative to that folder.

```
node "<this folder>/scripts/symbols.mjs" outline <file>...
node "<this folder>/scripts/symbols.mjs" find <Name or Owner/name> [path...] [--body] [--kind <kind>]
node "<this folder>/scripts/symbols.mjs" refs <name> [path...]
```

- `outline`: every symbol of the file with its kind and line range (`fn`, `method`, `struct`, `enum`, `trait`, `impl`, `mod`, `type`, `const`, `class`, `interface`, `namespace`, `macro`). Then read only the range you need with `read` offset/limit.
- `find`: where a name is defined (`file:start-end kind Owner/name`). `Owner/name` narrows to a method or nested item, for example `ScanResult/response`. `--body` prints the numbered body of the first five matches (up to 300 lines each). `--kind fn` keeps one kind. Without a path it searches the current folder.
- `refs`: every code reference to an identifier, with the enclosing symbol (`[Owner/name]`), excluding its own definition, strings and comments. Use it to find callers before changing a signature or behavior.

When to use it:
- A large source file (several hundred lines): `outline` first, then a targeted read or `find --body`, instead of reading the whole file.
- A symbol the packet names but does not place: `find`.
- Callers of a function you change: `refs`.

When not to: small files and exact ranges the packet names (read them), literal text, strings, comments, config, docs and renames (grep finds every textual occurrence; `refs` deliberately skips strings and comments).

Limits: a heuristic parser, not a compiler. Macros, generated code and unusual formatting can hide or misplace a symbol; when the result looks wrong, fall back to grep and read. It skips dot folders, `node_modules`, `target`, `dist`, `build`, `out`, `coverage`, `vendor`, `worktrees` and files over 1 MB.
