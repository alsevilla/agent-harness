// Path case rules, in one place. Windows (NTFS) and macOS (APFS and HFS+ by default) treat paths that differ only in case as the same file,
// so every path comparison folds case there. A case-sensitive macOS volume is rare; folding on it only makes checks stricter (two spellings
// are treated as one), which is the safe direction for the guard, admission and cleanup. Command text is never folded.
export const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<string> = new Set(["win32", "darwin"]);
export const foldsCase = (platform: string = process.platform): boolean => CASE_INSENSITIVE_PLATFORMS.has(platform);
export const foldCase = (text: string, platform: string = process.platform): string => (foldsCase(platform) ? text.toLowerCase() : text);
