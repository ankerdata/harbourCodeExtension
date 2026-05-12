import { Provider, Info } from "../src/provider";
import { parseFixture } from "./helpers";

// Mirrors the hover-build path in src/main.ts onHover for in-file lookups:
// build a Hover-shaped object out of the Info that hover would surface for
// the given word at the given line. Tests assert on the data the hover
// handler would consume from the Provider.
interface HoverPayload {
  label: string;
  body?: string; // for #define
  comment?: string; // attached comment
  docName?: string; // $DOC$ name (when associated)
}

function findHoverInfo(
  p: Provider,
  word: string,
  atLine: number,
): HoverPayload | undefined {
  const lower = word.toLowerCase();

  // #define wins first in main.ts
  const def = p.funcList.find((i) => i.kind === "define" && i.name === word);
  if (def) return { label: "#define " + def.name, body: def.body };

  for (const info of p.funcList) {
    if (info.nameCmp !== lower) continue;
    if (info.foundLike !== "definition") continue;
    if ((info.kind === "local" || info.kind === "param") && info.parent) {
      if (info.parent.startLine > atLine) continue;
      if (info.parent.endLine !== undefined && info.parent.endLine < atLine)
        continue;
    }
    return buildPayload(info, p);
  }
  return undefined;
}

function buildPayload(info: Info, p: Provider): HoverPayload {
  const payload: HoverPayload = {
    label: info.kind.toUpperCase() + " " + info.name,
  };
  if (info.comment && info.comment.trim().length > 0)
    payload.comment = info.comment.trim();
  if (info.hDocIdx !== undefined) {
    const doc = p.harbourDocs[info.hDocIdx];
    if (doc) payload.docName = doc.name;
  }
  return payload;
}

describe("hover lookup", () => {
  describe("comment association (comments.prg)", () => {
    const p = parseFixture("comments.prg");

    it("surfaces the leading // comment for a function", () => {
      const h = findHoverInfo(p, "Add", 4);
      expect(h?.label).toBe("FUNCTION Add");
      expect(h?.comment).toBe("Adds two numbers and returns the sum");
    });
  });

  describe("#define hover (defines.prg)", () => {
    const p = parseFixture("defines.prg");

    it("returns the #define body verbatim", () => {
      const h = findHoverInfo(p, "MAX_VALUE", 6);
      expect(h?.body).toBe("100");
    });

    it("works for parameterized macros", () => {
      const h = findHoverInfo(p, "SQUARE", 6);
      expect(h?.body).toBe("(( x ) * ( x ))");
    });
  });

  describe("scope-aware hover (procedures.prg)", () => {
    const p = parseFixture("procedures.prg");

    it("hovers a local only inside its parent's body", () => {
      // line 8 = inside Greet, line 2 = inside Main
      // 'cMsg' is a local of Greet
      expect(findHoverInfo(p, "cMsg", 8)?.label).toBe("LOCAL cMsg");
      expect(findHoverInfo(p, "cMsg", 2)).toBeUndefined();
    });
  });

  describe("$DOC$ association (hbdoc.prg)", () => {
    // Linking funcList[i].hDocIdx requires harbourDocs to be populated,
    // which is broken for canonical $DOC$ blocks (see parser.test.ts).
    // This test will start failing once the multiline-comment buffer
    // bug is fixed; remove .failing then.
    it.failing("links a function Info to its $DOC$ entry via hDocIdx", () => {
      const p = parseFixture("hbdoc.prg");
      const h = findHoverInfo(p, "DoStuff", 15);
      expect(h?.docName).toBe("DoStuff");
    });
  });
});
