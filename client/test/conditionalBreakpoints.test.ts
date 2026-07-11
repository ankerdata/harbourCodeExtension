import { makeHarness } from "./helpers/bpHarness";

/**
 * Conditional / hit-count / logpoint breakpoints (#47).
 *
 * These pin what the adapter puts on the wire. Note the runtime half of #47 is
 * NOT testable here: dbg_lib's setBreakpoint used to *append* a re-sent line's
 * extras instead of replacing them, so editing a condition left the old one in
 * force and `inBreakpoint()` — which requires every '?' extra to hold — could
 * never fire again. That is a Harbour-side fix, verified against a real binary
 * and queued for the end-to-end harness in #48. A TypeScript test can only
 * assert that the right bytes left the socket, never that the program stopped.
 */
describe("conditional, hit-count and log breakpoints", () => {
  it("encodes a condition, a hit count and a log message", () => {
    const h = makeHarness();
    h.setBps([
      { line: 28, condition: 'cMenuItem == "View Tickets File"' },
      { line: 29, hitCondition: "3" },
      { line: 30, logMessage: "got {cMenuItem}" },
    ]);

    const wire = h.sent.join("");
    expect(wire).toContain(
      '+:mttest01.prg:28:?:cMenuItem == "View Tickets File"',
    );
    expect(wire).toContain("+:mttest01.prg:29:C:3");
    expect(wire).toContain("+:mttest01.prg:30:L:got {cMenuItem}");
  });

  it("escapes colons in a condition, which are the wire field separator", () => {
    const h = makeHarness();
    h.setBps([{ line: 28, condition: "x == a:b" }]);

    // ':' would otherwise split the field; dbg_lib maps ';' back to ':'.
    expect(h.sent.join("")).toContain("+:mttest01.prg:28:?:x == a;b");
  });

  it("re-sends the breakpoint when its condition is edited", () => {
    const h = makeHarness();
    h.setBps([{ line: 28, condition: 'cMenuItem == "Item 2"' }]);
    h.ack(28);

    h.sent.length = 0;
    h.setBps([{ line: 28, condition: 'cMenuItem == "Item 3"' }]);

    // The new condition must reach the runtime; if the adapter suppressed this
    // as "unchanged", editing a condition would silently do nothing.
    expect(h.sent.join("")).toContain(
      '+:mttest01.prg:28:?:cMenuItem == "Item 3"',
    );
  });

  it("re-sends the breakpoint plain when its condition is cleared", () => {
    const h = makeHarness();
    h.setBps([{ line: 28, condition: 'cMenuItem == "Item 2"' }]);
    h.ack(28);

    h.sent.length = 0;
    h.setBps([28]); // condition removed in the editor

    const wire = h.sent.join("");
    expect(wire).toContain("+:mttest01.prg:28");
    expect(wire).not.toContain(":?:");
  });

  it("does not re-send an unchanged conditional breakpoint", () => {
    const h = makeHarness();
    h.setBps([{ line: 28, condition: 'cMenuItem == "Item 2"' }]);
    h.ack(28);

    h.sent.length = 0;
    h.setBps([{ line: 28, condition: 'cMenuItem == "Item 2"' }]); // identical

    expect(h.sent.join("")).not.toContain("+:mttest01.prg:28");
  });
});
