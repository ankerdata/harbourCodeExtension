import { makeHarness } from "./helpers/bpHarness";

/**
 * Breakpoint bookkeeping across the runtime's ACK (#46).
 *
 * `breakpoints[src][line]` holds a breakpoint's wire command. Ack state used to
 * be stored by overwriting that slot with the number 1, which silently broke
 * every other reader of it: the worker replay came out empty (so breakpoints
 * never fired in any non-main thread) and removals were never sent (so a
 * breakpoint deleted in the editor kept firing). These tests pin the post-ACK
 * behaviour so that can't regress.
 */
describe("breakpoint state survives the runtime ACK", () => {
  it("replays an ACKed breakpoint to a worker thread that connects later", () => {
    const h = makeHarness();
    h.setBps([28]);
    expect(h.replay()).toContain("+:mttest01.prg:28");

    // Main ACKs it long before any worker spawns.
    h.ack(28);

    // acceptThreadSocket replays THIS to each new worker. Empty here means the
    // worker gets no breakpoints and runs straight past them.
    expect(h.replay()).toContain("+:mttest01.prg:28");
  });

  it("replays an ACKed breakpoint's condition and hit count, not just its line", () => {
    const h = makeHarness();
    h.setBps([{ line: 28, condition: "i > 2", hitCondition: "3" }]);
    h.ack(28);

    const replay = h.replay();
    expect(replay).toContain("+:mttest01.prg:28");
    expect(replay).toContain(":?:i > 2");
    expect(replay).toContain(":C:3");
  });

  it("un-sets a breakpoint in the runtime after it has been ACKed", () => {
    const h = makeHarness();
    h.setBps([28]);
    h.ack(28);

    h.sent.length = 0;
    h.setBps([]); // user deletes it in the editor

    expect(h.sent.join("")).toContain("-:mttest01.prg:28");
  });

  it("keeps an unchanged breakpoint across a re-set, and drops only the removed one", () => {
    const h = makeHarness();
    h.setBps([28, 29]);
    h.ack(28);
    h.ack(29);

    h.sent.length = 0;
    h.setBps([28]); // 29 removed, 28 kept

    const wire = h.sent.join("");
    expect(wire).toContain("-:mttest01.prg:29");
    expect(wire).not.toContain("-:mttest01.prg:28");

    // 28 must still be replayed to any worker connecting from now on.
    expect(h.replay()).toContain("+:mttest01.prg:28");
    expect(h.replay()).not.toContain("+:mttest01.prg:29");
  });

  it("does not replay a breakpoint whose removal is still in flight", () => {
    const h = makeHarness();
    h.setBps([28]);
    h.ack(28);
    h.setBps([]); // removal sent, awaiting the runtime's ACK

    expect(h.replay()).not.toContain("+:mttest01.prg:28");
  });
});
