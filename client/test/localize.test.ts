import { localize, reInit } from "../src/messageBundle";

// Every test sets its own locale: reInit swaps module-level state, so leaving
// a previous test's bundle loaded would make these order-dependent.
describe("localize", () => {
  describe("key resolution", () => {
    beforeEach(() => reInit(""));

    it("resolves a key against the base bundle", () => {
      expect(localize("harbour.formatter.title")).toBe(
        "Harbour: setup code style",
      );
    });

    it("trims the %key% wrapper the manifest schema uses", () => {
      expect(localize("%harbour.formatter.title%")).toBe(
        "Harbour: setup code style",
      );
    });

    it("reports unknown keys rather than echoing them", () => {
      expect(localize("harbour.nope")).toBe("Error: 'harbour.nope' not found");
    });
  });

  describe("placeholder substitution", () => {
    beforeEach(() => reInit(""));

    it("substitutes a single argument", () => {
      expect(localize("harbour.prematureExit", 42)).toBe(
        "Exit early with code 42",
      );
    });

    it("substitutes into the middle of a message", () => {
      expect(localize("harbour.validation.NoExe", "hbmk2")).toBe(
        "Unable to start hbmk2, check the 'harbour.compilerExecutable' value",
      );
    });

    it("leaves a message without placeholders untouched", () => {
      expect(localize("harbour.formatter.title")).not.toContain("{0}");
    });
  });

  describe("locale selection", () => {
    it("uses the requested locale", () => {
      reInit({ locale: "es" });
      expect(localize("harbour.formatter.title")).toBe(
        "Harbour: configuración estilo de código",
      );
    });

    it("substitutes into a localized message", () => {
      reInit({ locale: "it" });
      expect(localize("harbour.prematureExit", 7)).toBe(
        "Uscito anticipatamente con codice 7",
      );
    });

    it("falls back to the base bundle for an unknown locale", () => {
      reInit({ locale: "zz" });
      expect(localize("harbour.formatter.title")).toBe(
        "Harbour: setup code style",
      );
    });

    it("falls back to the base bundle for a key missing from the locale", () => {
      reInit({ locale: "es" });
      const base = require("../package.nls.json");
      const es = require("../package.nls.es.json");
      const missing = Object.keys(base).find((k) => !(k in es));
      if (missing === undefined) {
        throw new Error("fixture assumes es is an incomplete translation");
      }
      expect(localize(missing)).toBe(base[missing]);
    });
  });
});
