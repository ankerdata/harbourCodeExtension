import { Provider } from "../src/provider";
import { parseFixture, findInfo, findAll } from "./helpers";

describe("Provider parser", () => {
  describe("procedures and functions (procedures.prg)", () => {
    const p = parseFixture("procedures.prg");

    it("identifies the Main procedure with locals", () => {
      const main = findInfo(p, "Main");
      expect(main).toBeDefined();
      expect(main!.kind).toBe("procedure");
      expect(main!.foundLike).toBe("definition");
      expect(main!.startLine).toBe(0);

      const locals = findAll(p, "n").concat(findAll(p, "cName"));
      expect(locals.every((l) => l.kind === "local")).toBe(true);
      expect(locals.every((l) => l.parent === main)).toBe(true);
    });

    it("identifies the Greet function with its parameter", () => {
      const greet = findInfo(p, "Greet", "function");
      expect(greet).toBeDefined();
      expect(greet!.startLine).toBe(7);

      const param = findInfo(p, "cWho", "param");
      expect(param).toBeDefined();
      expect(param!.parent).toBe(greet);
    });

    it("flags STATIC functions with a trailing star kind", () => {
      const helper = findInfo(p, "Helper");
      expect(helper).toBeDefined();
      expect(helper!.kind).toBe("function*");
    });

    it("scopes locals to the parent function/procedure end-line", () => {
      const main = findInfo(p, "Main")!;
      expect(main.endLine).toBeGreaterThanOrEqual(main.startLine);
      const localN = findAll(p, "n").find((i) => i.parent === main);
      expect(localN).toBeDefined();
      expect(localN!.startLine).toBeGreaterThan(main.startLine);
      expect(localN!.startLine).toBeLessThanOrEqual(main.endLine!);
    });
  });

  describe("classes and methods (class.prg)", () => {
    const p = parseFixture("class.prg");

    it("captures the class definition", () => {
      const counter = findInfo(p, "Counter", "class");
      expect(counter).toBeDefined();
      expect(counter!.foundLike).toBe("definition");
    });

    it("attaches DATA members to the class", () => {
      const counter = findInfo(p, "Counter", "class");
      const nValue = findInfo(p, "nValue", "data");
      const cLabel = findInfo(p, "cLabel", "data");
      expect(nValue?.parent).toBe(counter);
      expect(cLabel?.parent).toBe(counter);
    });

    it("emits both a declaration and a definition for each method", () => {
      const incs = findAll(p, "Increment", "method");
      expect(incs).toHaveLength(2);
      const kinds = incs.map((i) => i.foundLike).sort();
      expect(kinds).toEqual(["declaration", "definition"]);
    });

    it("links method definitions back to the class", () => {
      const counter = findInfo(p, "Counter", "class");
      for (const m of findAll(p, "Increment", "method")) {
        expect(m.parent).toBe(counter);
      }
    });

    it("records the include from #include <hbclass.ch>", () => {
      expect(p.includes).toContain("hbclass.ch");
    });
  });

  describe("preprocessor defines (defines.prg)", () => {
    const p = parseFixture("defines.prg");

    it("captures #define entries with their body", () => {
      const max = findInfo(p, "MAX_VALUE", "define");
      expect(max).toBeDefined();
      expect(max!.body).toBe("100");
    });

    it("captures parameterized macros and their parameter list", () => {
      const sq = findInfo(p, "SQUARE", "define");
      expect(sq).toBeDefined();
      const param = findInfo(p, "x", "param");
      expect(param?.parent).toBe(sq);
    });

    it("preserves the #include path", () => {
      expect(p.includes).toContain("common.ch");
    });
  });

  describe("control-flow groups (groups.prg)", () => {
    const p = parseFixture("groups.prg", { groups: true });

    it("recognises every group kind in the fixture", () => {
      const types = p.groups.map((g) => g.type).sort();
      // Two if-blocks (outer + nested in FOR), one for, one while, one case (switch), one sequence
      expect(types).toEqual(["case", "for", "if", "if", "sequence", "while"]);
    });

    it("records the line span of each group", () => {
      for (const g of p.groups) {
        const lines = g.positions.map((q) => q.line);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines[lines.length - 1]).toBeGreaterThan(lines[0]);
      }
    });
  });

  describe("BEGINDUMP / C code (cdump.prg)", () => {
    const p = parseFixture("cdump.prg", { groups: true });

    it("registers HB_FUNC declarations as C-FUNC kind", () => {
      const cf = findInfo(p, "CFUNC", "C-FUNC");
      expect(cf).toBeDefined();
      expect(cf!.foundLike).toBe("definition");
    });

    it("does not parse code inside the dump as Harbour", () => {
      // helper() is a C function, must not be picked up as a Harbour function
      expect(findInfo(p, "helper")).toBeUndefined();
    });

    it("records C brace pairs in cCodeFolder", () => {
      // Each closed brace pair becomes a 4-tuple [openLine, openCol, closeLine, closeCol]
      const closed = p.cCodeFolder.filter((f) => f.length === 4);
      expect(closed.length).toBeGreaterThanOrEqual(2);
      for (const [openLine, , closeLine] of closed) {
        expect(closeLine).toBeGreaterThanOrEqual(openLine);
      }
    });

    it("captures the BEGINDUMP/ENDDUMP span as a 'dump' group", () => {
      const dump = p.groups.find((g) => g.type === "dump");
      expect(dump).toBeDefined();
      expect(dump!.positions).toHaveLength(2);
    });
  });

  describe("alias->field references (db.prg)", () => {
    const p = parseFixture("db.prg");

    it("collects database aliases from `alias->field` syntax", () => {
      expect(Object.keys(p.databases).sort()).toEqual(["cust", "customers"]);
    });

    it("collects fields per alias", () => {
      expect(Object.keys(p.databases["cust"].fields).sort()).toEqual([
        "balance",
        "name",
      ]);
      expect(Object.keys(p.databases["customers"].fields)).toEqual(["id"]);
    });
  });

  describe("comment association (comments.prg)", () => {
    const p = parseFixture("comments.prg");

    it("attaches the // line comment above a function to its Info", () => {
      const add = findInfo(p, "Add", "function");
      expect(add?.comment).toBe("Adds two numbers and returns the sum");
    });

    it("records the multi-line /* */ header in multilineComments", () => {
      // The leading /* ... */ block spans the first two lines
      expect(p.multilineComments).toEqual(expect.arrayContaining([[0, 3]]));
    });
  });

  describe("Harbour $DOC$ blocks (hbdoc.prg)", () => {
    it("records the multiline-comment span for the doc block", () => {
      const p = parseFixture("hbdoc.prg");
      expect(p.multilineComments.some(([s, e]) => s === 0 && e === 14)).toBe(
        true,
      );
    });

    // The doc-block parser itself works when handed a usable mComment:
    // closing the block on a line that also has trailing code keeps
    // removedComments alive long enough for AddMultilineComment to read it.
    it("parses inline-closed $DOC$ blocks into harbourDocs", () => {
      const txt =
        "/*  $DOC$\n" +
        "    $TEMPLATE$\n" +
        "    Function\n" +
        "    $SYNTAX$\n" +
        "    DoStuff( <nValue> ) --> nResult\n" +
        "    $RETURNS$\n" +
        "    <nResult> the result\n" +
        "    $END$ */ FUNCTION DoStuff( nValue )\n" +
        "RETURN nValue * 2\n";
      const p = new Provider();
      p.parseString(txt, "file:///inline.prg");
      expect(p.harbourDocs).toHaveLength(1);
      expect(p.harbourDocs[0].name).toBe("DoStuff");
      expect(p.harbourDocs[0].label).toBe("DoStuff( <nValue> ) --> nResult");
      expect(p.harbourDocs[0].return?.name).toBe("<nResult>");
    });

    // KNOWN BUG: when */ sits on a line by itself (the canonical Harbour
    // $DOC$ idiom), linePP's empty-line branch calls resetComments() and
    // wipes the just-stored block before AddMultilineComment can read
    // it. The doc-parser logic itself is fine (see the inline test
    // above) -- this is purely a comment-buffer lifecycle bug.
    // When fixed, this test will start passing the assertions, which
    // makes test.failing fail -- prompting removal of the .failing.
    it.failing(
      "populates harbourDocs from canonical $END$ */ on-its-own-line style",
      () => {
        const p = parseFixture("hbdoc.prg");
        expect(p.harbourDocs).toHaveLength(1);
        expect(p.harbourDocs[0].name).toBe("DoStuff");
      },
    );
  });
});
