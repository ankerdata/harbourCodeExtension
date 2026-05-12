import { EventEmitter } from "events";
import { DebugProtocol } from "@vscode/debugprotocol";
import {
  harbourDebugSession,
  HBVar,
  ThreadState,
  MAIN_THREAD_ID,
} from "../src/debugger";

/**
 * Minimal net.Socket-shaped stub for tests. Sockets in node are EventEmitters
 * with `write`/`end`/`removeAllListeners`; that's the entire surface our
 * acceptThreadSocket code touches.
 */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(data: string | Buffer): boolean {
    this.written.push(typeof data === "string" ? data : data.toString());
    return true;
  }
  end(): void {
    this.destroyed = true;
  }
}

type CapturedEvent = DebugProtocol.Event;
type CapturedResponse = DebugProtocol.Response;

/**
 * Stub-session factory — same shape as debugger.test.ts but exported here so the
 * thread-dispatch suite stays self-contained.
 */
function makeSession(): {
  session: harbourDebugSession;
  events: CapturedEvent[];
  responses: CapturedResponse[];
  commands: string[];
} {
  const session = new harbourDebugSession();
  const events: CapturedEvent[] = [];
  const responses: CapturedResponse[] = [];
  const commands: string[] = [];
  (session as unknown as { sendEvent: (e: CapturedEvent) => void }).sendEvent =
    (e) => {
      events.push(e);
    };
  (
    session as unknown as { sendResponse: (r: CapturedResponse) => void }
  ).sendResponse = (r) => {
    responses.push(r);
  };
  session.command = (cmd: string) => {
    commands.push(cmd);
  };
  return { session, events, responses, commands };
}

function findEvent<T extends DebugProtocol.Event>(
  events: CapturedEvent[],
  name: string,
): T | undefined {
  return events.find((e) => e.event === name) as T | undefined;
}

function findAllEvents<T extends DebugProtocol.Event>(
  events: CapturedEvent[],
  name: string,
): T[] {
  return events.filter((e) => e.event === name) as T[];
}

/**
 * These tests pin the current single-thread DAP-event surface so that the
 * upcoming multi-threaded debugging refactor (issue #8) can be made safely.
 *
 * Today every event carries a hard-coded threadId of 1. After the refactor
 * each Harbour thread will own a ThreadState with its own id, so these
 * single-thread assertions will be replaced by per-thread assertions —
 * but the **value of the id** for a one-thread program must stay stable so
 * that existing user setups (single-threaded harbour programs) keep working.
 */
describe("debugger thread dispatch — single-thread baseline", () => {
  it("processInput STOP:break emits StoppedEvent with threadId=1 + invalidated for variables/stacks", () => {
    const { session, events } = makeSession();

    session.processInput("STOP:break\r\n");

    const stopped = findEvent<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.body.reason).toBe("break");
    expect(stopped!.body.threadId).toBe(1);

    const invalidated = findEvent<DebugProtocol.InvalidatedEvent>(
      events,
      "invalidated",
    );
    expect(invalidated).toBeDefined();
    // The runtime carries threadId=1 too — VS Code uses it to know which thread's
    // panes to refresh. After MT support, this must follow the stopping thread.
    expect((invalidated!.body as { threadId?: number }).threadId).toBe(1);
    expect((invalidated!.body as { areas?: string[] }).areas).toEqual([
      "variables",
      "stacks",
    ]);
  });

  it("processInput STOP:pause emits StoppedEvent reason='pause' threadId=1", () => {
    const { session, events } = makeSession();
    session.processInput("STOP:pause\r\n");
    const stopped = findEvent<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.body.reason).toBe("pause");
    expect(stopped!.body.threadId).toBe(1);
  });

  it("processInput STOP:step emits StoppedEvent reason='step' threadId=1", () => {
    const { session, events } = makeSession();
    session.processInput("STOP:step\r\n");
    const stopped = findEvent<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.body.reason).toBe("step");
    expect(stopped!.body.threadId).toBe(1);
  });

  it("processInput ERROR emits StoppedEvent reason='error' threadId=1 with the runtime's message", () => {
    const { session, events } = makeSession();
    // The 'ERROR ' prefix is 6 chars; everything after is the human-readable text.
    session.processInput("ERROR runtime error: array out of bounds\r\n");
    const stopped = findEvent<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.body.reason).toBe("error");
    expect(stopped!.body.threadId).toBe(1);
    // The text field is rendered in VS Code's Stop reason tooltip.
    expect((stopped!.body as { text?: string }).text).toBe(
      "runtime error: array out of bounds",
    );
  });

  it("ERROR_VAR lines do not trigger a stopped event (they're variable-response framing, not a fault)", () => {
    const { session, events } = makeSession();
    session.processInput("ERROR_VAR 0\r\n");
    expect(findEvent(events, "stopped")).toBeUndefined();
  });

  it("configurationDoneRequest with startGo=true emits ContinuedEvent threadId=1 allThreadsContinued=true", () => {
    const { session, events } = makeSession();
    session.startGo = true;
    (
      session as unknown as {
        configurationDoneRequest: (
          r: DebugProtocol.ConfigurationDoneResponse,
          a: DebugProtocol.ConfigurationDoneArguments,
        ) => void;
      }
    ).configurationDoneRequest(
      {
        type: "response",
        request_seq: 1,
        success: true,
        command: "configurationDone",
        seq: 0,
      },
      {},
    );

    const cont = findEvent<DebugProtocol.ContinuedEvent>(events, "continued");
    expect(cont).toBeDefined();
    expect(cont!.body.threadId).toBe(1);
    // Until we have per-thread continue, GO continues "all threads" — which is
    // accurate today (there's only one) and remains accurate after MT support if
    // GO is interpreted as "continue the runtime", not "continue this thread".
    expect(
      (cont!.body as { allThreadsContinued?: boolean }).allThreadsContinued,
    ).toBe(true);
  });

  it("configurationDoneRequest with startGo=false does NOT emit ContinuedEvent (stopOnEntry path)", () => {
    const { session, events } = makeSession();
    session.startGo = false;
    (
      session as unknown as {
        configurationDoneRequest: (
          r: DebugProtocol.ConfigurationDoneResponse,
          a: DebugProtocol.ConfigurationDoneArguments,
        ) => void;
      }
    ).configurationDoneRequest(
      {
        type: "response",
        request_seq: 1,
        success: true,
        command: "configurationDone",
        seq: 0,
      },
      {},
    );
    expect(findEvent(events, "continued")).toBeUndefined();
  });

  it("threadsRequest returns a single Main Thread with id=1", () => {
    const { session, responses } = makeSession();
    const response: DebugProtocol.ThreadsResponse = {
      type: "response",
      request_seq: 1,
      success: true,
      command: "threads",
      seq: 0,
      body: { threads: [] },
    };
    (
      session as unknown as {
        threadsRequest: (r: DebugProtocol.ThreadsResponse) => void;
      }
    ).threadsRequest(response);

    expect(responses).toHaveLength(1);
    const body = responses[0].body as { threads: DebugProtocol.Thread[] };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].id).toBe(1);
    expect(body.threads[0].name).toBe("Main Thread");
  });

  it("STOP/STACK/EXPRESSION lines arriving back-to-back are all routed to threadId=1 (no leak across)", () => {
    // This guards the refactor: after MT support, interleaved lines on different
    // sockets must route to different ThreadStates. For now, on one session, the
    // dispatch must still produce stable threadId=1 for every event.
    const { session, events } = makeSession();

    session.processInput("STOP:break\r\nSTOP:step\r\n");

    const stops = findAllEvents<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stops).toHaveLength(2);
    expect(stops[0].body.threadId).toBe(1);
    expect(stops[1].body.threadId).toBe(1);
  });
});

describe("ThreadState routing — phase 2 (multi-socket)", () => {
  it("processInput(buff, thread) tags events with the provided thread.id, then restores currentThread", () => {
    const { session, events } = makeSession();
    const secondary = new ThreadState(7);
    session.threads.set(7, secondary);

    session.processInput("STOP:break\r\n", secondary);

    const stopped = findEvent<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.body.threadId).toBe(7);

    const invalidated = findEvent<DebugProtocol.InvalidatedEvent>(
      events,
      "invalidated",
    );
    expect((invalidated!.body as { threadId?: number }).threadId).toBe(7);

    // currentThread is restored to the previous value after the call so DAP
    // request handlers (which still default to mainThread) don't see leakage.
    expect(session.currentThread).toBe(session.mainThread);
  });

  it("state writes during processInput land on the target thread, not the main thread", () => {
    const { session } = makeSession();
    const secondary = new ThreadState(7);
    session.threads.set(7, secondary);

    // EXPRESSION response routed to thread 7: the result name lookup happens
    // against thread 7's evaluateResponses queue, not the main thread's.
    secondary.evaluateResponses.push({
      type: "response",
      request_seq: 1,
      success: true,
      command: "evaluate",
      seq: 0,
      body: { result: "nLocal", variablesReference: 0 },
    });
    session.processInput("EXPRESSION:1:N:42\r\n", secondary);

    // main thread's queue stays untouched
    expect(session.mainThread.evaluateResponses).toHaveLength(0);
    // and thread 7's queue is now drained
    expect(secondary.evaluateResponses).toHaveLength(0);
  });

  it("acceptThreadSocket first call: binds main thread, sends InitializedEvent, no ThreadEvent", () => {
    const { session, events } = makeSession();
    const fakeSocket = new FakeSocket();
    const fakeServer = {} as unknown as import("net").Server;

    (
      session as unknown as {
        acceptThreadSocket: (s: unknown, srv: unknown) => void;
      }
    ).acceptThreadSocket(fakeSocket, fakeServer);

    expect(session.mainThread.socket).toBe(fakeSocket);
    expect(findEvent(events, "initialized")).toBeDefined();
    expect(findEvent(events, "thread")).toBeUndefined();
    expect(session.threads.size).toBe(1);
  });

  it("acceptThreadSocket second call: creates a new ThreadState and emits ThreadEvent('started')", () => {
    const { session, events } = makeSession();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const fakeServer = {} as unknown as import("net").Server;
    const accept = (
      session as unknown as {
        acceptThreadSocket: (s: unknown, srv: unknown) => void;
      }
    ).acceptThreadSocket.bind(session);

    accept(first, fakeServer);
    accept(second, fakeServer);

    expect(session.threads.size).toBe(2);
    const startedEvents = findAllEvents<DebugProtocol.ThreadEvent>(
      events,
      "thread",
    );
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].body.reason).toBe("started");
    const newId = startedEvents[0].body.threadId;
    expect(newId).not.toBe(MAIN_THREAD_ID);
    expect(session.threads.get(newId)).toBeDefined();
    expect(session.threads.get(newId)!.socket).toBe(second);
  });

  it("close on a secondary socket emits ThreadEvent('exited') and removes the ThreadState", () => {
    const { session, events } = makeSession();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const fakeServer = {} as unknown as import("net").Server;
    const accept = (
      session as unknown as {
        acceptThreadSocket: (s: unknown, srv: unknown) => void;
      }
    ).acceptThreadSocket.bind(session);

    accept(first, fakeServer);
    accept(second, fakeServer);
    const startedEvents = findAllEvents<DebugProtocol.ThreadEvent>(
      events,
      "thread",
    );
    const newId = startedEvents[0].body.threadId;

    // Simulate the secondary socket closing
    second.emit("close");

    const threadEvts = findAllEvents<DebugProtocol.ThreadEvent>(
      events,
      "thread",
    );
    expect(threadEvts).toHaveLength(2);
    expect(threadEvts[1].body.reason).toBe("exited");
    expect(threadEvts[1].body.threadId).toBe(newId);
    expect(session.threads.has(newId)).toBe(false);
    expect(session.threads.size).toBe(1);
  });

  it("close on the main socket does NOT emit ThreadEvent('exited') or remove the entry", () => {
    const { session, events } = makeSession();
    const first = new FakeSocket();
    const fakeServer = {} as unknown as import("net").Server;
    (
      session as unknown as {
        acceptThreadSocket: (s: unknown, srv: unknown) => void;
      }
    ).acceptThreadSocket(first, fakeServer);

    first.emit("close");

    expect(findEvent(events, "thread")).toBeUndefined();
    expect(session.threads.has(MAIN_THREAD_ID)).toBe(true);
    // socket is cleared so command() will buffer into queue again
    expect(session.mainThread.socket).toBeNull();
  });

  it("threadsRequest enumerates every live thread with its assigned name", () => {
    const { session, responses } = makeSession();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const fakeServer = {} as unknown as import("net").Server;
    const accept = (
      session as unknown as {
        acceptThreadSocket: (s: unknown, srv: unknown) => void;
      }
    ).acceptThreadSocket.bind(session);

    accept(first, fakeServer);
    accept(second, fakeServer);

    const response: DebugProtocol.ThreadsResponse = {
      type: "response",
      request_seq: 1,
      success: true,
      command: "threads",
      seq: 0,
      body: { threads: [] },
    };
    (
      session as unknown as {
        threadsRequest: (r: DebugProtocol.ThreadsResponse) => void;
      }
    ).threadsRequest(response);

    const threads = (responses[0].body as { threads: DebugProtocol.Thread[] })
      .threads;
    expect(threads).toHaveLength(2);
    expect(threads[0].id).toBe(MAIN_THREAD_ID);
    expect(threads[0].name).toBe("Main Thread");
    expect(threads[1].name).toMatch(/^Thread \d+$/);
  });
});

/**
 * End-to-end integration tests: two simulated Harbour threads connect via the
 * handshake path, then emit STOP / STACK from each socket. Verifies that the
 * full pipeline (accept -> processInput -> StoppedEvent + ThreadEvent + state)
 * routes correctly with no cross-talk.
 */
describe("Multi-thread end-to-end", () => {
  it("two threads handshake, stop independently, and each StoppedEvent carries its own threadId", () => {
    const { session, events } = makeSession();
    session.processId = 4242; // pretend we already know the pid
    const fakeServer = {} as unknown as import("net").Server;

    // First thread handshake: matching pid -> bound to main thread
    const sockA = new FakeSocket();
    session.evaluateClient(
      sockA as unknown as import("net").Socket,
      fakeServer,
      { program: undefined } as any,
    );
    sockA.emit("data", Buffer.from("MyApp\r\n4242\r\n"));
    expect(sockA.written).toContain("HELLO\r\n");
    expect(findEvent(events, "initialized")).toBeDefined();
    expect(session.mainThread.socket).toBe(sockA);

    // Second thread handshake: same pid -> bound to a new ThreadState, ThreadEvent('started')
    const sockB = new FakeSocket();
    session.evaluateClient(
      sockB as unknown as import("net").Socket,
      fakeServer,
      { program: undefined } as any,
    );
    sockB.emit("data", Buffer.from("MyApp\r\n4242\r\n"));
    expect(sockB.written).toContain("HELLO\r\n");
    const startedEvts = findAllEvents<DebugProtocol.ThreadEvent>(
      events,
      "thread",
    );
    expect(startedEvts).toHaveLength(1);
    expect(startedEvts[0].body.reason).toBe("started");
    const tidB = startedEvts[0].body.threadId;
    const threadB = session.threads.get(tidB)!;
    expect(threadB.socket).toBe(sockB);

    // Thread B hits a breakpoint
    sockB.emit("data", Buffer.from("STOP:break\r\n"));
    const stops = findAllEvents<DebugProtocol.StoppedEvent>(events, "stopped");
    expect(stops).toHaveLength(1);
    expect(stops[0].body.threadId).toBe(tidB);
    expect(stops[0].body.reason).toBe("break");

    // Thread A hits a different stop
    sockA.emit("data", Buffer.from("STOP:step\r\n"));
    const stopsNow = findAllEvents<DebugProtocol.StoppedEvent>(
      events,
      "stopped",
    );
    expect(stopsNow).toHaveLength(2);
    expect(stopsNow[1].body.threadId).toBe(MAIN_THREAD_ID);
    expect(stopsNow[1].body.reason).toBe("step");
  });

  it("third-pid handshake is rejected after the session locks onto the first pid", () => {
    const { session } = makeSession();
    session.processId = 4242;
    const fakeServer = {} as unknown as import("net").Server;

    const intruder = new FakeSocket();
    session.evaluateClient(
      intruder as unknown as import("net").Socket,
      fakeServer,
      { program: undefined } as any,
    );
    intruder.emit("data", Buffer.from("MyApp\r\n9999\r\n"));

    expect(intruder.written).toContain("NO\r\n");
    expect(intruder.destroyed).toBe(true);
    expect(session.threads.size).toBe(1); // still only main
  });

  it("close on a secondary socket fires ThreadEvent('exited') and reduces the live thread count", () => {
    const { session, events } = makeSession();
    session.processId = 4242;
    const fakeServer = {} as unknown as import("net").Server;
    const sockA = new FakeSocket();
    const sockB = new FakeSocket();
    session.evaluateClient(
      sockA as unknown as import("net").Socket,
      fakeServer,
      { program: undefined } as any,
    );
    sockA.emit("data", Buffer.from("MyApp\r\n4242\r\n"));
    session.evaluateClient(
      sockB as unknown as import("net").Socket,
      fakeServer,
      { program: undefined } as any,
    );
    sockB.emit("data", Buffer.from("MyApp\r\n4242\r\n"));
    const tidB = findEvent<DebugProtocol.ThreadEvent>(events, "thread")!.body
      .threadId;

    sockB.emit("close");

    const allThread = findAllEvents<DebugProtocol.ThreadEvent>(
      events,
      "thread",
    );
    expect(allThread).toHaveLength(2);
    expect(allThread[1].body.reason).toBe("exited");
    expect(allThread[1].body.threadId).toBe(tidB);
    expect(session.threads.has(tidB)).toBe(false);
  });
});

describe("Phase 3: per-thread control requests", () => {
  function attachTwoThreads(): {
    session: harbourDebugSession;
    events: CapturedEvent[];
    main: { thread: ThreadState; socket: FakeSocket };
    secondary: { thread: ThreadState; socket: FakeSocket };
  } {
    const { session, events } = makeSession();
    const fakeServer = {} as unknown as import("net").Server;
    const accept = (
      session as unknown as {
        acceptThreadSocket: (s: unknown, srv: unknown) => void;
      }
    ).acceptThreadSocket.bind(session);

    const firstSocket = new FakeSocket();
    accept(firstSocket, fakeServer);
    const mainThread = session.mainThread;
    // justStart=false after accept so commandTo writes directly to the socket
    // rather than buffering in queue.
    expect(mainThread.justStart).toBe(false);

    const secondSocket = new FakeSocket();
    accept(secondSocket, fakeServer);
    const startedEvents = events.filter(
      (e) => e.event === "thread",
    ) as DebugProtocol.ThreadEvent[];
    const secId = startedEvents[0].body.threadId;
    const secondary = session.threads.get(secId)!;

    return {
      session,
      events,
      main: { thread: mainThread, socket: firstSocket },
      secondary: { thread: secondary, socket: secondSocket },
    };
  }

  it("continueRequest with args.threadId writes GO to that thread's socket only", () => {
    const { session, main, secondary } = attachTwoThreads();
    const resp: DebugProtocol.ContinueResponse = {
      type: "response",
      request_seq: 1,
      success: true,
      command: "continue",
      seq: 0,
      body: { allThreadsContinued: false },
    };
    (
      session as unknown as {
        continueRequest: (
          r: DebugProtocol.ContinueResponse,
          a: DebugProtocol.ContinueArguments,
        ) => void;
      }
    ).continueRequest(resp, { threadId: secondary.thread.id });

    expect(secondary.socket.written).toContain("GO\r\n");
    expect(main.socket.written).not.toContain("GO\r\n");
  });

  it("nextRequest / stepInRequest / stepOutRequest / pauseRequest each route by args.threadId", () => {
    const { session, main, secondary } = attachTwoThreads();
    const call = (method: string, cmd: string, opts: { threadId: number }) => {
      const resp = {
        type: "response",
        request_seq: 1,
        success: true,
        command: method,
        seq: 0,
      } as DebugProtocol.Response;
      (session as unknown as Record<string, Function>)[method](resp, opts);
      return cmd;
    };

    call("nextRequest", "NEXT\r\n", { threadId: secondary.thread.id });
    call("stepInRequest", "STEP\r\n", { threadId: secondary.thread.id });
    call("stepOutRequest", "EXIT\r\n", { threadId: main.thread.id });
    call("pauseRequest", "PAUSE\r\n", { threadId: main.thread.id });

    expect(secondary.socket.written).toEqual(["NEXT\r\n", "STEP\r\n"]);
    expect(main.socket.written).toEqual(["EXIT\r\n", "PAUSE\r\n"]);
  });

  it("stackTraceRequest with args.threadId enqueues the stack response on the right thread and writes STACK to that socket", () => {
    const { session, main, secondary } = attachTwoThreads();
    const resp: DebugProtocol.StackTraceResponse = {
      type: "response",
      request_seq: 1,
      success: true,
      command: "stackTrace",
      seq: 0,
      body: { stackFrames: [] },
    };
    (
      session as unknown as {
        stackTraceRequest: (
          r: DebugProtocol.StackTraceResponse,
          a: DebugProtocol.StackTraceArguments,
        ) => void;
      }
    ).stackTraceRequest(resp, { threadId: secondary.thread.id });

    expect(secondary.thread.stack).toHaveLength(1);
    expect(main.thread.stack).toHaveLength(0);
    expect(secondary.socket.written).toContain("STACK\r\n");
    expect(main.socket.written).not.toContain("STACK\r\n");
  });

  it("selectThread falls back to mainThread when args.threadId is missing or unknown", () => {
    const { session } = makeSession();
    expect(session.selectThread(undefined)).toBe(session.mainThread);
    expect(session.selectThread(9999)).toBe(session.mainThread);
    expect(session.selectThread(MAIN_THREAD_ID)).toBe(session.mainThread);
  });
});

describe("ThreadState extraction (phase 1 refactor)", () => {
  it("bootstraps with one ThreadState for the main thread", () => {
    const { session } = makeSession();
    expect(session.threads.size).toBe(1);
    const main = session.threads.get(MAIN_THREAD_ID);
    expect(main).toBeInstanceOf(ThreadState);
    expect(main!.id).toBe(MAIN_THREAD_ID);
    expect(main).toBe(session.mainThread);
  });

  it("shim accessors round-trip through the main ThreadState", () => {
    const { session } = makeSession();
    // Write via the shim, read via the underlying ThreadState
    session.currentStack = 7;
    expect(session.mainThread.currentStack).toBe(7);
    // And vice versa
    session.mainThread.variables.push(new HBVar("LOC:1:1:"));
    expect(session.variables).toHaveLength(1);
    // Mutating through the getter mutates the underlying array (shared reference)
    session.variablesMap.set("X", 42);
    expect(session.mainThread.variablesMap.get("X")).toBe(42);
  });

  it("MAIN_THREAD_ID is 1 to preserve the existing single-thread contract", () => {
    expect(MAIN_THREAD_ID).toBe(1);
  });
});
