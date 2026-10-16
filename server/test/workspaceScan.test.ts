import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isHarbourSourceFile,
  hasCArtefactExtension,
  isHarbourGeneratedCContent,
  isHarbourGeneratedCFile,
  isScannableDirectory,
  statDirEntries,
  tryReadDir,
  tryStat,
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
      ' * Generated C source from "sharedx\\seterror.prg"\n' +
      " */\n" +
      '#include "hbvmpub.h"\n';
    expect(isHarbourGeneratedCContent(head)).toBe(true);
  });

  it("detects HB_INIT_SYMBOLS_BEGIN even if the header was stripped", () => {
    const head =
      '#include "hbvmpub.h"\n' +
      '#include "hbinit.h"\n' +
      "HB_INIT_SYMBOLS_BEGIN( hb_vm_SymbolInit_FOO )\n";
    expect(isHarbourGeneratedCContent(head)).toBe(true);
  });

  it("detects HB_FUNC_INITSTATICS", () => {
    const head =
      '#include "hbvmpub.h"\n' + "HB_FUNC_INITSTATICS()\n" + "{ ... }\n";
    expect(isHarbourGeneratedCContent(head)).toBe(true);
  });

  it("does NOT flag a hand-written HB_FUNC implementation", () => {
    const head =
      '#include "hbapi.h"\n' +
      "HB_FUNC( MYFUNC )\n" +
      "{\n" +
      '   hb_retc( "hello" );\n' +
      "}\n";
    expect(isHarbourGeneratedCContent(head)).toBe(false);
  });

  it("does NOT flag a comment that merely *mentions* Harbour", () => {
    const head =
      "/* Hand-written wrapper around a Harbour API. */\n" +
      '#include "hbapi.h"\n' +
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

function fsError(
  code: string,
  syscall: string,
  p: string,
): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: ${syscall} '${p}'`);
  err.code = code;
  err.syscall = syscall;
  err.path = p;
  return err;
}

describe("workspaceScan.tryStat", () => {
  it("returns stats for a readable file", () => {
    const info = tryStat(path.join(fixtureDir, "class.prg"));
    expect(info?.isFile()).toBe(true);
  });

  it("returns undefined for a missing path", () => {
    expect(tryStat(path.join(fixtureDir, "missing-xyz"))).toBeUndefined();
  });

  it("returns undefined instead of throwing on EACCES", () => {
    const statFn = (p: string): fs.Stats => {
      throw fsError("EACCES", "stat", p);
    };
    expect(tryStat("/proj/.venv-linux-3.13/lib64", statFn)).toBeUndefined();
  });
});

describe("workspaceScan.tryReadDir", () => {
  it("lists a readable directory", () => {
    expect(tryReadDir(fixtureDir)).toContain("class.prg");
  });

  it("returns [] instead of throwing on EACCES", () => {
    const readDirFn = (p: string): string[] => {
      throw fsError("EACCES", "scandir", p);
    };
    expect(tryReadDir("/proj/locked", readDirFn)).toEqual([]);
  });
});

describe("workspaceScan.statDirEntries", () => {
  it("skips entries that cannot be stat'ed and keeps the rest", () => {
    const dir = "/proj";
    const fileStats = fs.statSync(path.join(fixtureDir, "class.prg"));
    const statFn = (p: string): fs.Stats => {
      if (path.basename(p) === "lib64") throw fsError("EACCES", "stat", p);
      return fileStats;
    };
    const entries = statDirEntries(
      dir,
      ["main.prg", "lib64", "util.prg"],
      statFn,
    );
    expect(entries.map((e) => e.name)).toEqual(["main.prg", "util.prg"]);
    expect(entries[0].completePath).toBe(path.join(dir, "main.prg"));
    expect(entries[0].info).toBe(fileStats);
  });

  describe("on a real directory", () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-scan-"));
      fs.writeFileSync(path.join(tmp, "main.prg"), "PROCEDURE Main()\nRETURN\n");
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("skips a dangling symlink", () => {
      try {
        fs.symlinkSync(
          path.join(tmp, "nowhere"),
          path.join(tmp, "broken"),
          "junction",
        );
      } catch {
        // Symlink creation can be refused on locked-down hosts.
        return;
      }
      const names = fs.readdirSync(tmp);
      expect(names).toContain("broken");
      expect(statDirEntries(tmp, names).map((e) => e.name)).toEqual([
        "main.prg",
      ]);
    });
  });
});

describe("workspaceScan.isScannableDirectory", () => {
  it("descends into ordinary source directories", () => {
    expect(isScannableDirectory("src")).toBe(true);
    expect(isScannableDirectory("sharedx")).toBe(true);
  });

  it("skips hidden directories such as Python venvs and VCS metadata", () => {
    expect(isScannableDirectory(".venv-linux-3.13")).toBe(false);
    expect(isScannableDirectory(".git")).toBe(false);
    expect(isScannableDirectory(".vscode")).toBe(false);
  });

  it("skips node_modules", () => {
    expect(isScannableDirectory("node_modules")).toBe(false);
  });
});
