import { Provider, Info } from "../src/provider";
import { parseFixture } from "./helpers";

// Mirrors the same-file branch of connection.onDefinition in src/main.ts:
// scan funcList for foundLike==="definition", filter by name and (for
// locals/params) parent scope. Tests assert on what go-to-definition would
// hand back to the LSP client, given the parser output.
function findDefinitions(
  p: Provider,
  word: string,
  atLine?: number,
  className?: string,
): Info[] {
  const lower = word.toLowerCase();
  const out: Info[] = [];
  for (const info of p.funcList) {
    if (info.foundLike !== "definition") continue;
    if (info.nameCmp !== lower) continue;
    if (info.kind === "data" || info.kind === "method") {
      if (className && info.parent && className !== info.parent.nameCmp)
        continue;
    }
    if (info.kind === "local" || info.kind === "param") {
      if (atLine === undefined) continue;
      const parent = info.parent;
      if (!parent) continue;
      if (parent.startLine > atLine) continue;
      if (parent.endLine !== undefined && parent.endLine < atLine) continue;
    }
    out.push(info);
  }
  return out;
}

describe("definition lookup", () => {
  describe("procedures.prg", () => {
    const p = parseFixture("procedures.prg");

    it("finds the FUNCTION Greet definition by name", () => {
      const found = findDefinitions(p, "Greet", 3);
      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe("function");
      expect(found[0].startLine).toBe(7);
    });

    it("finds the local 'cName' only inside Main's body", () => {
      const insideMain = findDefinitions(p, "cName", 3);
      expect(insideMain).toHaveLength(1);
      expect(insideMain[0].kind).toBe("local");

      const outsideMain = findDefinitions(p, "cName", 8);
      expect(outsideMain).toHaveLength(0);
    });

    it("finds the param 'cWho' only inside Greet's body", () => {
      const inside = findDefinitions(p, "cWho", 8);
      expect(inside.some((i) => i.kind === "param")).toBe(true);

      const outside = findDefinitions(p, "cWho", 3);
      expect(outside).toHaveLength(0);
    });
  });

  describe("class.prg", () => {
    const p = parseFixture("class.prg");

    it("finds the class definition", () => {
      const found = findDefinitions(p, "Counter");
      expect(found.some((i) => i.kind === "class")).toBe(true);
    });

    it("returns DATA members scoped to their class when className is given", () => {
      const scoped = findDefinitions(p, "nValue", 0, "counter");
      expect(scoped).toHaveLength(1);
      expect(scoped[0].kind).toBe("data");
      expect(scoped[0].parent?.name).toBe("Counter");
    });

    it("returns the method *definition* (not the in-class declaration)", () => {
      const all = findDefinitions(p, "Increment", 0, "counter");
      // We have one declaration + one definition in the fixture; only
      // the definition should be visible to go-to-definition.
      expect(all.every((i) => i.foundLike === "definition")).toBe(true);
      expect(all).toHaveLength(1);
    });
  });

  describe("defines.prg", () => {
    const p = parseFixture("defines.prg");

    it("finds #define entries", () => {
      const found = findDefinitions(p, "MAX_VALUE");
      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe("define");
    });
  });
});
