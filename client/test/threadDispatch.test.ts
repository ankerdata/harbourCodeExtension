import { DebugProtocol } from "@vscode/debugprotocol";
import { harbourDebugSession } from "../src/debugger";

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
    (session as unknown as { sendEvent: (e: CapturedEvent) => void }).sendEvent = (e) => {
        events.push(e);
    };
    (session as unknown as { sendResponse: (r: CapturedResponse) => void }).sendResponse = (r) => {
        responses.push(r);
    };
    session.command = (cmd: string) => {
        commands.push(cmd);
    };
    return { session, events, responses, commands };
}

function findEvent<T extends DebugProtocol.Event>(events: CapturedEvent[], name: string): T | undefined {
    return events.find((e) => e.event === name) as T | undefined;
}

function findAllEvents<T extends DebugProtocol.Event>(events: CapturedEvent[], name: string): T[] {
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

        const invalidated = findEvent<DebugProtocol.InvalidatedEvent>(events, "invalidated");
        expect(invalidated).toBeDefined();
        // The runtime carries threadId=1 too — VS Code uses it to know which thread's
        // panes to refresh. After MT support, this must follow the stopping thread.
        expect((invalidated!.body as { threadId?: number }).threadId).toBe(1);
        expect((invalidated!.body as { areas?: string[] }).areas).toEqual(["variables", "stacks"]);
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
        expect((stopped!.body as { text?: string }).text).toBe("runtime error: array out of bounds");
    });

    it("ERROR_VAR lines do not trigger a stopped event (they're variable-response framing, not a fault)", () => {
        const { session, events } = makeSession();
        session.processInput("ERROR_VAR 0\r\n");
        expect(findEvent(events, "stopped")).toBeUndefined();
    });

    it("configurationDoneRequest with startGo=true emits ContinuedEvent threadId=1 allThreadsContinued=true", () => {
        const { session, events } = makeSession();
        session.startGo = true;
        (session as unknown as {
            configurationDoneRequest: (
                r: DebugProtocol.ConfigurationDoneResponse,
                a: DebugProtocol.ConfigurationDoneArguments
            ) => void;
        }).configurationDoneRequest(
            {
                type: "response",
                request_seq: 1,
                success: true,
                command: "configurationDone",
                seq: 0,
            },
            {}
        );

        const cont = findEvent<DebugProtocol.ContinuedEvent>(events, "continued");
        expect(cont).toBeDefined();
        expect(cont!.body.threadId).toBe(1);
        // Until we have per-thread continue, GO continues "all threads" — which is
        // accurate today (there's only one) and remains accurate after MT support if
        // GO is interpreted as "continue the runtime", not "continue this thread".
        expect((cont!.body as { allThreadsContinued?: boolean }).allThreadsContinued).toBe(true);
    });

    it("configurationDoneRequest with startGo=false does NOT emit ContinuedEvent (stopOnEntry path)", () => {
        const { session, events } = makeSession();
        session.startGo = false;
        (session as unknown as {
            configurationDoneRequest: (
                r: DebugProtocol.ConfigurationDoneResponse,
                a: DebugProtocol.ConfigurationDoneArguments
            ) => void;
        }).configurationDoneRequest(
            {
                type: "response",
                request_seq: 1,
                success: true,
                command: "configurationDone",
                seq: 0,
            },
            {}
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
        (session as unknown as {
            threadsRequest: (r: DebugProtocol.ThreadsResponse) => void;
        }).threadsRequest(response);

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
