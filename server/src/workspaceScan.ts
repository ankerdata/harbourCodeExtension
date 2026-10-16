import * as fs from "fs";
import * as path from "path";

// Markers emitted exclusively by the Harbour→C code generator (genc.c).
// Their presence in a .c file's header is a strong signal that the file
// is a compiled artefact whose `HB_FUNC( NAME )` blocks are p-code shims
// duplicating the original .prg PROCEDURE/FUNCTION — indexing those
// shims makes go-to-definition land in the generated artefact instead
// of the user's source.
const GENERATED_C_MARKERS: RegExp[] = [
  /Generated C source from/,
  /\bHB_INIT_SYMBOLS_BEGIN\s*\(/,
  /\bHB_FUNC_INITSTATICS\s*\(/,
  /\bHB_FUNC_INITLINES\s*\(/,
];

const HEAD_PEEK_BYTES = 8192;

export function isHarbourSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".prg" || ext === ".ch";
}

// Companion C/H files that sit next to .prg sources (extension starts
// with `.c` or is `.h`, but not the Harbour `.ch` header).
export function hasCArtefactExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ch") return false;
  return ext === ".h" || ext.startsWith(".c");
}

// Content-based detection: returns true if the supplied head-of-file
// text looks like Harbour compiler output. Pure function — used by
// tests and by isHarbourGeneratedCFile.
export function isHarbourGeneratedCContent(head: string): boolean {
  return GENERATED_C_MARKERS.some((re) => re.test(head));
}

// Reads the first ~8KB of `filePath` and applies isHarbourGeneratedCContent.
// Returns false on any read error: callers should fall back to "treat
// as hand-written" rather than silently dropping the file.
export function isHarbourGeneratedCFile(
  filePath: string,
  peekBytes: number = HEAD_PEEK_BYTES,
): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(peekBytes);
    const read = fs.readSync(fd, buf, 0, peekBytes, 0);
    return isHarbourGeneratedCContent(buf.toString("utf8", 0, read));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// stat() that follows symlinks but reports unreadable entries as
// undefined instead of throwing. Workspace folders routinely contain
// entries Node cannot stat and one such entry must not take down the
// language server.
export function tryStat(
  filePath: string,
  statFn: (p: string) => fs.Stats = fs.statSync,
): fs.Stats | undefined {
  try {
    return statFn(filePath);
  } catch {
    return undefined;
  }
}

export function tryReadDir(
  dir: string,
  readDirFn: (p: string) => string[] = (p) => fs.readdirSync(p),
): string[] {
  try {
    return readDirFn(dir);
  } catch {
    return [];
  }
}

export interface ScannedEntry {
  name: string;
  completePath: string;
  info: fs.Stats;
}

// Stats each name in `dir`, dropping entries that cannot be stat'ed.
export function statDirEntries(
  dir: string,
  names: string[],
  statFn: (p: string) => fs.Stats = fs.statSync,
): ScannedEntry[] {
  const entries: ScannedEntry[] = [];
  for (const name of names) {
    const completePath = path.join(dir, name);
    const info = tryStat(completePath, statFn);
    if (info) entries.push({ name, completePath, info });
  }
  return entries;
}

// Hidden directories (.git, .vscode, .venv-*, ...) and node_modules
// hold tooling state and third-party trees, never Harbour sources, and
// are where unreadable symlinks and huge file counts tend to live.
export function isScannableDirectory(name: string): boolean {
  return !name.startsWith(".") && name !== "node_modules";
}
