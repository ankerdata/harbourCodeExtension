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
export function isHarbourGeneratedCFile(filePath: string, peekBytes: number = HEAD_PEEK_BYTES): boolean {
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
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}
