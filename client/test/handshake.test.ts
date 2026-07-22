import { EventEmitter } from "events";
import * as net from "net";
import { DebugProtocol } from "@vscode/debugprotocol";
import { harbourDebugSession, MAIN_THREAD_ID } from "../src/debugger";

/**
 * hb_inet-shaped socket stub. Unlike a node client, the Harbour runtime does not
 * auto-close on FIN, and bytes already in flight when the adapter calls `end()`
 * are still delivered — which is exactly the condition #50 turned on, so the
 * stub has to model it rather than treat `end()` as "no more data".
 */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  ended = false;
  destroyed = false;
  write(data: string | Buffer): boolean {
    this.written.push(typeof data === "string" ? data : data.toString());
    return true;
  }
  end(): void {
    this.ended = true;
  }
  /** Deliver `text` as one TCP segment. */
  feed(text: string): void {
    this.emit("data", Buffer.from(text));
  }
}

const PID = 4242;
const EXE = "C:\\app\\app.exe";
/** dbg_lib sends HB_ARGV(0) + CRLF + str(__PIDNum()) + CRLF; str() pads to 10. */
const HANDSHAKE = `${EXE}\r\n${String(PID).padStart(10, " ")}\r\n`;

function makeSession(): {
  session: harbourDebugSession;
  events: DebugProtocol.Event[];
  connect: (socket: FakeSocket) => void;
} {
  const session = new harbourDebugSession();
  const events: DebugProtocol.Event[] = [];
  (
    session as unknown as { sendEvent: (e: DebugProtocol.Event) => void }
  ).sendEvent = (e) => {
    events.push(e);
  };
  (session as unknown as { sendResponse: (r: unknown) => void }).sendResponse =
    () => {};
  const connect = (socket: FakeSocket): void =>
    session.evaluateClient(socket as unknown as net.Socket, {} as net.Server, {
      program: EXE,
    } as never);
  return { session, events, connect };
}

/** Sockets that got past the handshake; main is pre-seeded, so 1 means none. */
function workerCount(session: harbourDebugSession): number {
  return session.threads.size - 1;
}

function outputs(events: DebugProtocol.Event[]): string[] {
  return events
    .filter((e) => e.event === "output")
    .map((e) => (e as DebugProtocol.OutputEvent).body.output.trim());
}

describe("evaluateClient handshake", () => {
  it("accepts a handshake delivered in a single segment", () => {
    const { session, events, connect } = makeSession();
    const sock = new FakeSocket();
    connect(sock);
    sock.feed(HANDSHAKE);

    expect(sock.written).toEqual(["HELLO\r\n"]);
    expect(sock.ended).toBe(false);
    expect(session.mainThread.socket).toBe(sock);
    expect(session.processId).toBe(PID);
    expect(events.some((e) => e.event === "initialized")).toBe(true);
  });

  it("accepts a handshake split across segments", () => {
    const { session, connect } = makeSession();
    const sock = new FakeSocket();
    connect(sock);
    sock.feed(HANDSHAKE.slice(0, 20));
    expect(sock.written).toEqual([]);
    sock.feed(HANDSHAKE.slice(20));

    expect(sock.written).toEqual(["HELLO\r\n"]);
    expect(session.mainThread.socket).toBe(sock);
  });

  it("accepts a handshake split before the first CRLF", () => {
    const { session, connect } = makeSession();
    const sock = new FakeSocket();
    connect(sock);
    sock.feed("C:\\app\\app");
    expect(sock.written).toEqual([]);
    sock.feed(`.exe\r\n${String(PID).padStart(10, " ")}\r\n`);

    expect(sock.written).toEqual(["HELLO\r\n"]);
    expect(session.mainThread.socket).toBe(sock);
  });

  it("accepts a worker byte at a time", () => {
    const { session, connect } = makeSession();
    const main = new FakeSocket();
    connect(main);
    main.feed(HANDSHAKE);

    const worker = new FakeSocket();
    connect(worker);
    for (const ch of HANDSHAKE) worker.feed(ch);

    expect(worker.written[0]).toBe("HELLO\r\n");
    expect(workerCount(session)).toBe(1);
  });

  it("hands a command pipelined into the handshake packet to processInput", () => {
    const { session, connect } = makeSession();
    const main = new FakeSocket();
    connect(main);
    main.feed(HANDSHAKE);

    const worker = new FakeSocket();
    connect(worker);
    const received: string[] = [];
    session.processInput = (buff) => {
      received.push(buff);
    };
    worker.feed(HANDSHAKE + "STOP:break\r\n");

    expect(worker.written[0]).toBe("HELLO\r\n");
    expect(received.join("")).toBe("STOP:break\r\n");
  });

  it("rejects a pid that does not match the debuggee", () => {
    const { session, connect } = makeSession();
    const main = new FakeSocket();
    connect(main);
    main.feed(HANDSHAKE);

    const other = new FakeSocket();
    connect(other);
    other.feed(`${EXE}\r\n      9999\r\n`);

    expect(other.written).toEqual(["NO\r\n"]);
    expect(other.ended).toBe(true);
    expect(workerCount(session)).toBe(0);
  });

  it("rejects a program name that does not match args.program", () => {
    const { session, connect } = makeSession();
    const sock = new FakeSocket();
    connect(sock);
    sock.feed(`C:\\other\\other.exe\r\n${String(PID).padStart(10, " ")}\r\n`);

    expect(sock.written).toEqual(["NO\r\n"]);
    expect(session.mainThread.socket).toBeNull();
    expect(session.processId).toBeUndefined();
  });

  it("rejects a non-numeric pid instead of reading it as NaN", () => {
    const { session, connect } = makeSession();
    const sock = new FakeSocket();
    connect(sock);
    sock.feed(`${EXE}\r\nnot-a-pid\r\n`);

    expect(sock.written).toEqual(["NO\r\n"]);
    expect(session.mainThread.socket).toBeNull();
    // a NaN pid used to reach setProcess(), which drops it silently and leaves
    // the session with no pid to poll for liveness
    expect(session.processId).toBeUndefined();
  });

  it("rejects a peer that never completes the handshake", () => {
    const { session, connect } = makeSession();
    const sock = new FakeSocket();
    connect(sock);
    sock.feed("x".repeat(5000));

    expect(sock.written).toEqual(["NO\r\n"]);
    expect(sock.ended).toBe(true);
    expect(session.mainThread.socket).toBeNull();
  });

  /**
   * #50: `end()` half-closes, so a rejected socket kept receiving data. The
   * handshake handler was still attached and stateless, so the next fragment
   * parsed on its own, and the adapter handshaked and adopted a socket it had
   * already closed — then reported the live thread as exited when the FIN landed.
   */
  it("does not adopt a socket it has already rejected", () => {
    const { session, events, connect } = makeSession();
    const main = new FakeSocket();
    connect(main);
    main.feed(HANDSHAKE);

    const worker = new FakeSocket();
    connect(worker);
    worker.feed(`${EXE}\r\n      9999\r\n`);
    expect(worker.written).toEqual(["NO\r\n"]);

    // the rest of a retry arriving on the socket we just closed
    worker.feed(HANDSHAKE);

    expect(worker.written).toEqual(["NO\r\n"]);
    expect(workerCount(session)).toBe(0);
    expect(events.some((e) => e.event === "thread")).toBe(false);

    worker.emit("close");
    expect(outputs(events)).toEqual([]);
    expect(events.some((e) => e.event === "thread")).toBe(false);
  });

  /**
   * A connection arriving after main's socket closed is a new harbour thread,
   * not main coming back. Deriving "is this the first connection?" from
   * `mainThread.socket` re-adopted it into the main slot, where it got no
   * thread id, no state replay and no auto-GO — leaving that runtime thread
   * parked in CheckSocket waiting for a command that never came.
   */
  it("does not re-adopt a later connection into the main slot", () => {
    const { session, events, connect } = makeSession();
    const main = new FakeSocket();
    connect(main);
    main.feed(HANDSHAKE);
    expect(session.mainThread.socket).toBe(main);

    main.emit("close");
    expect(session.mainThread.socket).toBeNull();

    const late = new FakeSocket();
    connect(late);
    late.feed(HANDSHAKE);

    expect(session.mainThread.socket).toBeNull();
    expect(workerCount(session)).toBe(1);
    const started = events.filter(
      (e) => e.event === "thread",
    ) as DebugProtocol.ThreadEvent[];
    expect(started).toHaveLength(1);
    expect(started[0].body.reason).toBe("started");
    // the replay + auto-GO a worker depends on to start running
    expect(late.written).toContain("GO\r\n");
  });

  it("keeps a rejected socket out of the way of the retry that follows", () => {
    const { session, events, connect } = makeSession();
    const main = new FakeSocket();
    connect(main);
    main.feed(HANDSHAKE);

    const rejected = new FakeSocket();
    connect(rejected);
    rejected.feed(`C:\\other\\other.exe\r\n      9999\r\n`);

    // dbg_lib nils the socket and reconnects; the new one must handshake cleanly
    const retry = new FakeSocket();
    connect(retry);
    retry.feed(HANDSHAKE);

    expect(retry.written[0]).toBe("HELLO\r\n");
    expect(workerCount(session)).toBe(1);
    const started = events.filter(
      (e) => e.event === "thread",
    ) as DebugProtocol.ThreadEvent[];
    expect(started).toHaveLength(1);
    expect(started[0].body.reason).toBe("started");
    expect(started[0].body.threadId).not.toBe(MAIN_THREAD_ID);
  });
});
