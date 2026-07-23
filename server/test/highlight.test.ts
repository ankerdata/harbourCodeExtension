import { DocumentHighlightKind } from "vscode-languageserver/node";
import { highlightKind } from "../src/highlight";
import { resolveScope, collectLocations } from "../src/rename";
import { fixture, parseFixture } from "./helpers";

// highlightKind is the read/write classifier behind textDocument/documentHighlight.
// The second block mirrors what the connection.onDocumentHighlight handler in
// src/main.ts assembles — scope resolution, in-file occurrence collection, then
// classification against the source line — the way rename.test.ts mirrors
// resolveSymbolAt.

const { Read, Write } = DocumentHighlightKind;

/** Classify `word` in `line`, locating it by search. */
function classify(line: string, word: string, isDefinition = false) {
  return highlightKind(line, line.indexOf(word), word.length, isDefinition);
}

describe("highlightKind", () => {
  it("marks the declaration site as a write", () => {
    expect(classify("FUNCTION Calc( nBase )", "nBase", true)).toBe(Write);
  });

  it("marks `:=` assignment as a write", () => {
    expect(classify("   nTotal := 0", "nTotal")).toBe(Write);
  });

  it("marks compound assignment as a write", () => {
    for (const op of ["+=", "-=", "*=", "/=", "%=", "^=", "**="]) {
      expect(classify(`   nTotal ${op} 2`, "nTotal")).toBe(Write);
    }
  });

  it("marks increment and decrement as writes, before or after", () => {
    expect(classify("   nTotal++", "nTotal")).toBe(Write);
    expect(classify("   nTotal--", "nTotal")).toBe(Write);
    expect(classify("   ++nTotal", "nTotal")).toBe(Write);
    expect(classify("   --nTotal", "nTotal")).toBe(Write);
  });

  it("treats a plain mention as a read", () => {
    expect(classify("   ? nTotal", "nTotal")).toBe(Read);
    expect(classify("   RETURN nTotal", "nTotal")).toBe(Read);
  });

  it("treats bare `=` as a read, since Harbour compares with it", () => {
    expect(classify("   IF nTotal = 3", "nTotal")).toBe(Read);
  });

  it("does not mistake comparison operators for assignment", () => {
    for (const op of ["==", "<=", ">=", "!=", "<>"]) {
      expect(classify(`   IF nTotal ${op} 3`, "nTotal")).toBe(Read);
    }
  });

  it("does not mistake `->` for the `-=` operator", () => {
    expect(classify("   ? cust->name", "cust")).toBe(Read);
  });

  it("does not read an adjacent `+` as an increment", () => {
    expect(classify("   ? nOther + nTotal", "nTotal")).toBe(Read);
  });
});

describe("document highlight over a parsed file (highlight.prg)", () => {
  const uri = "file:///highlight.prg";
  const p = parseFixture("highlight.prg");
  const lines = fixture("highlight.prg").split(/\r?\n/);

  /** What onDocumentHighlight returns: in-file occurrences, classified. */
  function highlights(word: string, prev: string, next: string, line: number) {
    const scope = resolveScope(p, word, prev, next, line);
    const def = scope.def;
    // `{}` for providers is what the handler passes to stay in-file.
    return collectLocations({}, uri, p, scope).map((loc) => ({
      line: loc.range.start.line,
      kind: highlightKind(
        lines[loc.range.start.line],
        loc.range.start.character,
        word.length,
        def !== undefined &&
          def.startLine === loc.range.start.line &&
          def.startCol === loc.range.start.character,
      ),
    }));
  }

  it("finds every occurrence of a local in its routine", () => {
    const got = highlights("ntotal", "", ":", 2);
    expect(got.map((h) => h.line).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 8,
    ]);
  });

  it("separates the writes from the reads", () => {
    const got = highlights("ntotal", "", ":", 2);
    const byLine = new Map(got.map((h) => [h.line, h.kind]));
    // declaration, `:=`, `+=`, `++`
    expect(byLine.get(1)).toBe(Write);
    expect(byLine.get(2)).toBe(Write);
    expect(byLine.get(3)).toBe(Write);
    expect(byLine.get(4)).toBe(Write);
    // `IF nTotal = 3`, `? nTotal`, `RETURN nTotal`
    expect(byLine.get(5)).toBe(Read);
    expect(byLine.get(6)).toBe(Read);
    expect(byLine.get(8)).toBe(Read);
  });

  it("marks a parameter's declaration as a write and its use as a read", () => {
    const got = highlights("nbase", "", "", 2);
    const byLine = new Map(got.map((h) => [h.line, h.kind]));
    expect(byLine.get(0)).toBe(Write);
    expect(byLine.get(2)).toBe(Read);
  });

  it("stays within the current document", () => {
    const other = parseFixture("procedures.prg");
    const scope = resolveScope(p, "ntotal", "", ":", 2);
    const inFile = collectLocations({}, uri, p, scope);
    const workspace = collectLocations(
      { "file:///procedures.prg": other },
      uri,
      p,
      scope,
    );
    expect(inFile.every((l) => l.uri === uri)).toBe(true);
    expect(inFile.length).toBe(workspace.length);
  });
});
