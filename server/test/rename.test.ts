import { Provider } from "../src/provider";
import {
  resolveScope,
  collectLocations,
  hasWorkspaceDefinition,
  kindToRefType,
  isValidIdentifier,
} from "../src/rename";
import { fixture, parseFixture } from "./helpers";

// These tests exercise the pure scope-resolution / occurrence-collection
// engine that backs both "Find All References" and "Rename Symbol". They
// mirror what resolveSymbolAt() in src/main.ts hands to the LSP client,
// given the parser output — the same approach definition.test.ts takes.

function lines(p: Provider, word: string) {
  const lower = word.toLowerCase();
  return (p.references[lower] ?? []).map((r) => r.line).sort((a, b) => a - b);
}

describe("kindToRefType", () => {
  it("maps procedures and functions onto the 'function' bucket", () => {
    expect(kindToRefType("function")).toBe("function");
    expect(kindToRefType("procedure")).toBe("function");
    expect(kindToRefType("function*")).toBe("function"); // module-static
    expect(kindToRefType("procedure*")).toBe("function");
    expect(kindToRefType("C-FUNC")).toBe("function");
  });

  it("maps class members and variables onto their buckets", () => {
    expect(kindToRefType("method")).toBe("method");
    expect(kindToRefType("data")).toBe("data");
    expect(kindToRefType("field")).toBe("field");
    expect(kindToRefType("local")).toBe("variable");
    expect(kindToRefType("static")).toBe("variable");
    expect(kindToRefType("param")).toBe("variable");
    expect(kindToRefType("define")).toBe("variable");
  });
});

describe("isValidIdentifier", () => {
  it("accepts Harbour identifiers and rejects everything else", () => {
    expect(isValidIdentifier("nValue")).toBe(true);
    expect(isValidIdentifier("_priv2")).toBe(true);
    expect(isValidIdentifier("2bad")).toBe(false);
    expect(isValidIdentifier("has space")).toBe(false);
    expect(isValidIdentifier("dash-name")).toBe(false);
    expect(isValidIdentifier("")).toBe(false);
  });
});

describe("rename — procedures.prg", () => {
  const p = parseFixture("procedures.prg");
  const uri = "file:///procedures.prg";
  const providers = { [uri]: p };

  it("renames a FUNCTION across its definition and call sites", () => {
    // cursor on `Greet(` at the call on line 4 (0-based 3)
    const scope = resolveScope(p, "greet", "", "(", 3);
    expect(scope.refType).toBe("function");
    expect(scope.onlyThis).toBe(false);
    const locs = collectLocations(providers, uri, p, scope);
    // definition (line 8) + call (line 4) => two edit sites
    expect(locs.map((l) => l.range.start.line).sort((a, b) => a - b)).toEqual([
      3, 7,
    ]);
  });

  it("renames a same-file PROCEDURE (regression: proc kind vs 'function' refs)", () => {
    // The old onReferences set kind = def.kind = "procedure" and compared it
    // against ref.type, which is never "procedure" — so a same-file procedure
    // matched nothing. kindToRefType bridges that gap.
    const scope = resolveScope(p, "main", "", "(", 0);
    expect(scope.def?.kind).toBe("procedure");
    expect(scope.refType).toBe("function");
    const locs = collectLocations(providers, uri, p, scope);
    expect(locs.length).toBeGreaterThanOrEqual(1);
    expect(locs.every((l) => l.uri === uri)).toBe(true);
  });

  it("scopes a LOCAL to its enclosing routine and to the current file", () => {
    // `cName` is local to Main (lines 1..6, 0-based 0..5)
    const scope = resolveScope(p, "cname", "", "", 3);
    expect(scope.def?.kind).toBe("local");
    expect(scope.onlyThis).toBe(true);
    const locs = collectLocations(providers, uri, p, scope);
    expect(locs.length).toBe(2); // declaration + use
    expect(
      locs.every((l) => l.range.start.line >= 0 && l.range.start.line <= 5),
    ).toBe(true);
  });

  it("scopes a PARAM to its function body", () => {
    // `cWho` is a param of Greet (lines 8..10, 0-based 7..9)
    const scope = resolveScope(p, "cwho", "", "", 8);
    expect(scope.def?.kind).toBe("param");
    expect(scope.onlyThis).toBe(true);
    const locs = collectLocations(providers, uri, p, scope);
    expect(locs.length).toBeGreaterThanOrEqual(1);
    expect(
      locs.every((l) => l.range.start.line >= 7 && l.range.start.line <= 9),
    ).toBe(true);
  });

  it("refuses to rename an unknown/built-in symbol", () => {
    const scope = resolveScope(p, "alltrim", "", "(", 3);
    expect(hasWorkspaceDefinition(providers, uri, p, scope)).toBe(false);
  });

  it("allows renaming a workspace-defined function", () => {
    const scope = resolveScope(p, "greet", "", "(", 3);
    expect(hasWorkspaceDefinition(providers, uri, p, scope)).toBe(true);
  });

  it("rewrites every occurrence to the new name regardless of original case", () => {
    const scope = resolveScope(p, "greet", "", "(", 3);
    const locs = collectLocations(providers, uri, p, scope);
    // The ranges all span the original 5-char identifier "Greet"; a TextEdit
    // replacing that range with the new name handles case uniformly.
    expect(
      locs.every(
        (l) => l.range.end.character - l.range.start.character === "greet".length,
      ),
    ).toBe(true);
  });
});

describe("rename — cross-file functions", () => {
  const mainUri = "file:///main.prg";
  const callerUri = "file:///caller.prg";
  const pMain = new Provider();
  pMain.parseString(fixture("procedures.prg"), mainUri);
  const pCaller = new Provider();
  pCaller.parseString(
    'PROCEDURE Other()\n   ? Greet( "x" )\nRETURN\n',
    callerUri,
  );
  const providers = { [mainUri]: pMain, [callerUri]: pCaller };

  it("collects call sites in other workspace files", () => {
    const scope = resolveScope(pMain, "greet", "", "(", 3);
    const locs = collectLocations(providers, mainUri, pMain, scope);
    const uris = new Set(locs.map((l) => l.uri));
    expect(uris.has(mainUri)).toBe(true);
    expect(uris.has(callerUri)).toBe(true);
  });

  it("keeps locals out of other files even when the name matches", () => {
    // caller.prg has no cName; the local rename must never leave main.prg
    const scope = resolveScope(pMain, "cname", "", "", 3);
    const locs = collectLocations(providers, mainUri, pMain, scope);
    expect(locs.every((l) => l.uri === mainUri)).toBe(true);
  });
});

describe("rename — file-static scope (statics.prg)", () => {
  const uri = "file:///statics.prg";
  const otherUri = "file:///other.prg";
  const p = parseFixture("statics.prg");
  const pOther = new Provider();
  // another module that happens to reference the same names
  pOther.parseString(
    'PROCEDURE Elsewhere()\n   LOCAL shSocket := 0\n   ? shSocket\n   SockDebug()\nRETURN\n',
    otherUri,
  );
  const providers = { [uri]: p, [otherUri]: pOther };

  it("recognises THREAD STATIC as a file-static declaration", () => {
    // regression: the `thread` qualifier used to hide the declaration entirely
    const def = p.funcList.find((i) => i.nameCmp === "shsocket");
    expect(def).toBeDefined();
    expect(def?.kind).toBe("static");
  });

  it("scopes a THREAD STATIC rename to its own file", () => {
    const scope = resolveScope(p, "shsocket", "", "", 9);
    expect(scope.def?.kind).toBe("static");
    expect(scope.onlyThis).toBe(true);
    const locs = collectLocations(providers, uri, p, scope);
    expect(locs.length).toBeGreaterThanOrEqual(1);
    // must NOT leak into other.prg even though it also has a `shSocket`
    expect(locs.every((l) => l.uri === uri)).toBe(true);
  });

  it("scopes a STATIC PROCEDURE rename to its own file but allows prepare", () => {
    const scope = resolveScope(p, "sockdebug", "", "(", 11);
    expect(scope.def?.kind).toBe("procedure*");
    expect(scope.refType).toBe("function");
    expect(scope.onlyThis).toBe(true);
    // prepareRename must NOT refuse a module-static procedure
    expect(hasWorkspaceDefinition(providers, uri, p, scope)).toBe(true);
    const locs = collectLocations(providers, uri, p, scope);
    // definition + call in this file only
    expect(locs.length).toBe(2);
    expect(locs.every((l) => l.uri === uri)).toBe(true);
  });
});

describe("rename — class.prg", () => {
  const p = parseFixture("class.prg");
  const uri = "file:///class.prg";
  const providers = { [uri]: p };

  it("renames a METHOD across declaration, definition and call", () => {
    // cursor on `:Increment(` at the call on line 20 (0-based 19)
    const scope = resolveScope(p, "increment", ":", "(", 19);
    expect(scope.refType).toBe("method");
    const locs = collectLocations(providers, uri, p, scope);
    // declaration (l6) + definition (l10) + call (l20) — all `method` refs
    expect(locs.length).toBe(lines(p, "increment").length);
    expect(locs.length).toBeGreaterThanOrEqual(3);
  });

  it("renames a DATA member across declaration and accesses", () => {
    // cursor on `::nValue` at line 11 (0-based 10)
    const scope = resolveScope(p, "nvalue", ":", "+", 10);
    expect(scope.refType).toBe("data");
    const locs = collectLocations(providers, uri, p, scope);
    expect(locs.length).toBe(lines(p, "nvalue").length);
    expect(locs.length).toBeGreaterThanOrEqual(2);
  });
});
