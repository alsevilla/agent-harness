// Retired: pi-package generation was removed from this candidate; the script only refuses (see the throw below).
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PI_PACKAGE_OUT: absolute isolated output (tests); it must lie outside the repository and must not contain it.
const out = process.env.PI_PACKAGE_OUT;
// Exact boundary: ".." or ".."+sep leads out; "..evil" is a child name, and an absolute relative path is another volume.
const escapes = (rel) => rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
if (out !== undefined && (!path.isAbsolute(out) || !escapes(path.relative(repo, out)) || !escapes(path.relative(out, repo)))) throw new Error(`PI_PACKAGE_OUT must be an absolute path outside the repository and not containing it: ${out}`);
// Retired: pi-package/ was intentionally removed and its migration is not implemented. Refuse before any write.
throw new Error("pi-package generation is retired: the obsolete pi-package/ tree was intentionally removed and no migration is implemented; nothing was generated.");
