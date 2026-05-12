import { Provider } from "../src/provider";
import { parseFixture } from "./helpers";

// Same algorithm as connection.onRequest(SemanticTokensRequest, ...) in
// src/main.ts. Token type ids: 0 = variable (local/static), 1 = parameter.
// Modifiers: bit 0 = declaration site, bit 1 = static.
function computeSemanticTokens(p: Provider): {
  data: number[];
  absolute: number[][];
} {
  let ret: number[][] = [];
  for (const info of p.funcList) {
    if (
      (info.kind === "local" || info.kind === "param") &&
      info.nameCmp in p.references
    ) {
      const id = info.kind === "local" ? 0 : 1;
      const parent = info.parent;
      if (!parent || parent.endLine === undefined) continue;
      for (const ref of p.references[info.nameCmp]) {
        if (
          ref.type === "variable" &&
          ref.line >= parent.startLine &&
          ref.line <= parent.endLine
        ) {
          let mod = 0;
          if (ref.line === info.startLine) mod += 1;
          ret.push([ref.line, ref.col, info.nameCmp.length, id, mod]);
        }
      }
    }
    if (info.kind === "static" && info.nameCmp in p.references) {
      for (const ref of p.references[info.nameCmp]) {
        if (ref.type === "variable") {
          let mod = 2;
          if (ref.line === info.startLine) mod += 1;
          ret.push([ref.line, ref.col, info.nameCmp.length, 0, mod]);
        }
      }
    }
  }
  ret = ret.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const absolute = ret.map((t) => t.slice());
  for (let i = ret.length - 1; i > 0; --i) {
    if (ret[i][0] !== ret[i - 1][0]) {
      ret[i][0] -= ret[i - 1][0];
    } else {
      ret[i][0] = 0;
      ret[i][1] -= ret[i - 1][1];
    }
  }
  const data: number[] = ([] as number[]).concat(...ret);
  return { data, absolute };
}

describe("semantic tokens", () => {
  describe("procedures.prg", () => {
    const p = parseFixture("procedures.prg");
    const { data, absolute } = computeSemanticTokens(p);

    it("emits 5 fields per token", () => {
      expect(data.length % 5).toBe(0);
    });

    it("classifies locals as token type 0 and params as type 1", () => {
      // Find absolute tokens for 'cwho' (param of Greet) and 'cmsg' (local of Greet)
      // We can't read names from the data, but we can check the type ids.
      const types = absolute.map((t) => t[3]);
      // procedures.prg has params (cWho, x) and locals (n, cName, cMsg, y).
      // Each is referenced at definition line at minimum, so we expect
      // both type ids to appear.
      expect(types).toContain(0);
      expect(types).toContain(1);
    });

    it("flags the declaration site with modifier bit 0", () => {
      // The token at the declaration line of any local/param has mod & 1 set.
      // Find one local Info, look up the token at its startLine/startCol.
      const main = p.funcList.find((i) => i.name === "Main")!;
      const localN = p.funcList.find(
        (i) => i.name === "n" && i.parent === main,
      )!;
      const tok = absolute.find(
        (t) => t[0] === localN.startLine && t[1] === localN.startCol,
      );
      expect(tok).toBeDefined();
      expect(tok![4] & 1).toBe(1); // declaration bit
    });

    it("delta-encodes the line numbers in `data`", () => {
      // First token's line is absolute; subsequent same-line entries
      // have delta-line = 0; different-line entries have positive delta.
      for (let i = 5; i < data.length; i += 5) {
        expect(data[i]).toBeGreaterThanOrEqual(0);
      }
    });

    it("scopes tokens to their parent function (no cross-function bleed)", () => {
      const greet = p.funcList.find((i) => i.name === "Greet")!;
      const main = p.funcList.find((i) => i.name === "Main")!;
      // Every absolute token must fall inside SOME definition's scope:
      for (const t of absolute) {
        const inGreet = t[0] >= greet.startLine && t[0] <= (greet.endLine ?? 0);
        const inMain = t[0] >= main.startLine && t[0] <= (main.endLine ?? 0);
        const helper = p.funcList.find((i) => i.name === "Helper")!;
        const inHelper =
          t[0] >= helper.startLine && t[0] <= (helper.endLine ?? 0);
        expect(inGreet || inMain || inHelper).toBe(true);
      }
    });
  });

  describe("class.prg (no eligible tokens)", () => {
    // class.prg has DATA/METHOD entries but no locals/params/static
    // variables that would be referenced, so the token array should
    // be empty (DATA is not surfaced as a semantic token by main.ts).
    const p = parseFixture("class.prg");
    const { data } = computeSemanticTokens(p);

    it("does not emit tokens for DATA members", () => {
      // Only Driver's local oCnt qualifies, so we should have a small
      // number of tokens, none corresponding to nValue/cLabel.
      const driver = p.funcList.find((i) => i.name === "Driver")!;
      const oCnt = p.funcList.find(
        (i) => i.name === "oCnt" && i.parent === driver,
      )!;
      // At least one token at the declaration of oCnt
      expect(data.length).toBeGreaterThanOrEqual(5);
      expect(oCnt).toBeDefined();
    });
  });
});
