import { DebugProtocol } from "@vscode/debugprotocol";
import { harbourDebugSession } from "../../src/debugger";

/**
 * Drives a real `harbourDebugSession` with its transport stubbed out, capturing
 * the commands it would put on the wire. Shared by the breakpoint test suites.
 */
export interface BpHarness {
  session: harbourDebugSession;
  /** Commands the session sent to the runtime, in order. */
  sent: string[];
  /** Issue a setBreakpoints request for `SRC`. */
  setBps: (lines: BpSpec[]) => DebugProtocol.SetBreakpointsResponse;
  /** Simulate the runtime ACKing a breakpoint: `BREAK:<src>:<req>:<actual>`. */
  ack: (line: number, actual?: number) => void;
  /** The replay `acceptThreadSocket` sends to a newly-connected worker. */
  replay: () => string;
}

export type BpSpec = number | DebugProtocol.SourceBreakpoint;

export const SRC = "mttest01.prg";

export function makeHarness(): BpHarness {
  const session = new harbourDebugSession();
  const sent: string[] = [];
  const stub = session as never as Record<string, unknown>;
  stub.sendEvent = (): void => {};
  stub.sendResponse = (): void => {};
  stub.command = (c: string): void => {
    sent.push(c);
  };
  stub.broadcastCommand = (c: string): void => {
    sent.push(c);
  };

  return {
    session,
    sent,
    setBps(lines) {
      const response = {
        body: { breakpoints: [] },
      } as unknown as DebugProtocol.SetBreakpointsResponse;
      (
        stub.setBreakPointsRequest as (
          r: DebugProtocol.SetBreakpointsResponse,
          a: DebugProtocol.SetBreakpointsArguments,
        ) => void
      ).call(session, response, {
        source: { name: SRC, path: `c:/x/${SRC}` },
        breakpoints: lines.map((l) =>
          typeof l === "number" ? { line: l } : l,
        ),
      });
      return response;
    },
    ack(line, actual = line) {
      (stub.processBreak as (l: string) => void).call(
        session,
        `BREAK:${SRC}:${line}:${actual}`,
      );
    },
    replay() {
      return (stub.currentBreakpointsMessage as () => string).call(session);
    },
  };
}
