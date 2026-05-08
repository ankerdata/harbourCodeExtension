import * as path from "path";
import {
    isHarbourSourceFile,
    hasCArtefactExtension,
    isHarbourGeneratedCContent,
    isHarbourGeneratedCFile,
} from "../src/workspaceScan";

const fixtureDir = path.join(__dirname, "fixtures");

describe("workspaceScan.isHarbourSourceFile", () => {
    it("accepts .prg sources", () => {
        expect(isHarbourSourceFile("/proj/foo.prg")).toBe(true);
    });
    it("accepts .ch headers", () => {
        expect(isHarbourSourceFile("/proj/inkey.ch")).toBe(true);
    });
    it("is case-insensitive", () => {
        expect(isHarbourSourceFile("/proj/Foo.PRG")).toBe(true);
        expect(isHarbourSourceFile("/proj/Foo.CH")).toBe(true);
    });
    it("rejects .c source", () => {
        expect(isHarbourSourceFile("/proj/foo.c")).toBe(false);
    });
    it("rejects .h header", () => {
        expect(isHarbourSourceFile("/proj/foo.h")).toBe(false);
    });
});

describe("workspaceScan.hasCArtefactExtension", () => {
    it("flags .c", () => {
        expect(hasCArtefactExtension("/proj/foo.c")).toBe(true);
    });
    it("flags .h", () => {
        expect(hasCArtefactExtension("/proj/foo.h")).toBe(true);
    });
    it("flags .cpp", () => {
        expect(hasCArtefactExtension("/proj/foo.cpp")).toBe(true);
    });
    it("does NOT flag the Harbour .ch header", () => {
        expect(hasCArtefactExtension("/proj/inkey.ch")).toBe(false);
    });
    it("does NOT flag .prg", () => {
        expect(hasCArtefactExtension("/proj/foo.prg")).toBe(false);
    });
});

describe("workspaceScan.isHarbourGeneratedCContent", () => {
    it("detects the canonical 'Generated C source from' header comment", () => {
        const head =
            "/*\n" +
            " * Harbour 3.2.0dev (r2602080306)\n" +
            " * Microsoft Visual C 19.50.35728 (32-bit)\n" +
            " * Generated C source from \"sharedx\\seterror.prg\"\n" +
            " */\n" +
            "#include \"hbvmpub.h\"\n";
        expect(isHarbourGeneratedCContent(head)).toBe(true);
    });

    it("detects HB_INIT_SYMBOLS_BEGIN even if the header was stripped", () => {
        const head =
            "#include \"hbvmpub.h\"\n" +
            "#include \"hbinit.h\"\n" +
            "HB_INIT_SYMBOLS_BEGIN( hb_vm_SymbolInit_FOO )\n";
        expect(isHarbourGeneratedCContent(head)).toBe(true);
    });

    it("detects HB_FUNC_INITSTATICS", () => {
        const head =
            "#include \"hbvmpub.h\"\n" +
            "HB_FUNC_INITSTATICS()\n" +
            "{ ... }\n";
        expect(isHarbourGeneratedCContent(head)).toBe(true);
    });

    it("does NOT flag a hand-written HB_FUNC implementation", () => {
        const head =
            "#include \"hbapi.h\"\n" +
            "HB_FUNC( MYFUNC )\n" +
            "{\n" +
            "   hb_retc( \"hello\" );\n" +
            "}\n";
        expect(isHarbourGeneratedCContent(head)).toBe(false);
    });

    it("does NOT flag a comment that merely *mentions* Harbour", () => {
        const head =
            "/* Hand-written wrapper around a Harbour API. */\n" +
            "#include \"hbapi.h\"\n" +
            "HB_FUNC( WRAPPER ) { hb_retni( 0 ); }\n";
        expect(isHarbourGeneratedCContent(head)).toBe(false);
    });
});

describe("workspaceScan.isHarbourGeneratedCFile", () => {
    it("flags the synthetic generated.c fixture", () => {
        const p = path.join(fixtureDir, "generated.c");
        expect(isHarbourGeneratedCFile(p)).toBe(true);
    });

    it("does NOT flag the hand-written handwritten.c fixture", () => {
        const p = path.join(fixtureDir, "handwritten.c");
        expect(isHarbourGeneratedCFile(p)).toBe(false);
    });

    it("returns false for a non-existent file (fail open: treat as hand-written)", () => {
        const p = path.join(fixtureDir, "this-file-does-not-exist-xyz.c");
        expect(isHarbourGeneratedCFile(p)).toBe(false);
    });
});
