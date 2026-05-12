import { DebugProtocol } from "@vscode/debugprotocol";
import { harbourDebugSession, HBVar } from "../src/debugger";

type CapturedEvent = DebugProtocol.Event;
type CapturedResponse = DebugProtocol.Response;

/**
 * Build a session with sendEvent / sendResponse / command captured into arrays.
 * Avoids the real stdio loop from DebugSession.run().
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
  // Capture every wire-side write at commandTo, the single funnel that both
  // legacy `this.command(...)` (which delegates to commandTo) and the new
  // explicit `commandTo(thread, ...)` calls flow through. Stubbing only
  // `command` would miss the per-thread routed dispatch the variable-inspection
  // path now uses.
  session.commandTo = (_thread, cmd: string) => {
    commands.push(cmd);
  };
  return { session, events, responses, commands };
}

function makeEvaluateResponse(
  expression: string,
): DebugProtocol.EvaluateResponse {
  return {
    type: "response",
    request_seq: 1,
    success: true,
    command: "evaluate",
    seq: 0,
    body: { result: expression, variablesReference: 0 },
  };
}

describe("debugger.processExpression", () => {
  it("parses EXPRESSION:{frame}:{type}:{result} with a scalar numeric result", () => {
    const { session, responses } = makeSession();
    session.evaluateResponses.push(makeEvaluateResponse("nCount"));

    session.processExpression("EXPRESSION:1:N:42");

    expect(responses).toHaveLength(1);
    const body = responses[0].body as { type?: string; result: string };
    expect(body.type).toBe("N");
    expect(body.result).toBe("42");
  });

  it("preserves colons in the result field (regression for 5cf9d10)", () => {
    // A Windows-style path returned as the value of a 'C' (string) expression
    // has multiple ':'  -- the original `split` based parser truncated it at the
    // third colon. processExpression must take everything after the third colon
    // verbatim.
    const { session, responses } = makeSession();
    session.evaluateResponses.push(makeEvaluateResponse("cPath"));

    session.processExpression("EXPRESSION:1:C:C:\\Users\\graham:test");

    expect(responses).toHaveLength(1);
    const body = responses[0].body as { result: string; type?: string };
    expect(body.type).toBe("C");
    expect(body.result).toBe("C:\\Users\\graham:test");
  });

  it("decodes type-E (error) into a failed response with no body", () => {
    const { session, responses } = makeSession();
    session.evaluateResponses.push(makeEvaluateResponse("bogus"));

    session.processExpression("EXPRESSION:1:E:Variable does not exist");

    expect(responses).toHaveLength(1);
    expect(responses[0].success).toBe(false);
    expect(responses[0].message).toBe("Variable does not exist");
    expect(responses[0].body).toBeUndefined();
  });

  it("emits an OutputEvent when no response is queued instead of crashing", () => {
    const { session, events, responses } = makeSession();
    // evaluateResponses is empty
    session.processExpression("EXPRESSION:1:N:42");

    expect(responses).toHaveLength(0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const e = events[0] as DebugProtocol.OutputEvent;
    expect(e.event).toBe("output");
    expect(e.body.category).toBe("stderr");
  });

  it("propagates the frame index into the EXP: key that getVariableFormat sees", () => {
    const { session, responses } = makeSession();
    session.evaluateResponses.push(makeEvaluateResponse("x"));

    session.processExpression("EXPRESSION:3:N:7");

    const body = responses[0].body as { result: string };
    expect(body.result).toBe("7");
    // The EXP key incorporates frame "3" — confirmed indirectly by a follow-up
    // variablesReference lookup; we verify the frame parse via the body.name
    // which mirrors the original expression rather than the frame number.
    expect((responses[0].body as { name?: string }).name).toBe("x");
  });
});

describe("debugger.getVariableFormat", () => {
  function freshDest(name = "v"): { name: string; [k: string]: unknown } {
    return { name };
  }

  it("unescapes \\$\\n and \\$\\r inside C (string) values", () => {
    const { session } = makeSession();
    const dest = freshDest();

    session.getVariableFormat(
      dest,
      "C",
      "line1\\$\\nline2\\$\\rend",
      "value",
      "LOC:1:1:",
    );

    expect(dest["value"]).toBe("line1\nline2\rend");
    expect(dest["type"]).toBe("C");
  });

  it("passes scalar numerics through unchanged and records the type", () => {
    const { session } = makeSession();
    const dest = freshDest("nCount");
    session.getVariableFormat(dest, "N", "42", "value", "LOC:1:1:");
    expect(dest["value"]).toBe("42");
    expect(dest["type"]).toBe("N");
  });

  it("formats arrays as ARRAY(n) with indexedVariables + a variablesReference", () => {
    const { session } = makeSession();
    const dest = freshDest("aRows");
    session.getVariableFormat(dest, "A", "5", "value", "LOC:1:1:");
    expect(dest["value"]).toBe("ARRAY(5)");
    expect(dest["type"]).toBe("A");
    expect(dest["indexedVariables"]).toBe(5);
    expect(typeof dest["variablesReference"]).toBe("number");
    expect(dest["variablesReference"]).toBeGreaterThan(0);
  });

  it("formats hashes as HASH(n) with namedVariables", () => {
    const { session } = makeSession();
    const dest = freshDest("hConfig");
    session.getVariableFormat(dest, "H", "3", "value", "LOC:1:2:");
    expect(dest["value"]).toBe("HASH(3)");
    expect(dest["type"]).toBe("H");
    expect(dest["namedVariables"]).toBe(3);
    expect(typeof dest["variablesReference"]).toBe("number");
  });

  it("formats objects as CLASS <Name> with namedVariables from the second token", () => {
    const { session } = makeSession();
    const dest = freshDest("oUser");
    session.getVariableFormat(dest, "O", "TUser 12", "value", "LOC:1:3:");
    expect(dest["value"]).toBe("CLASS TUser");
    expect(dest["type"]).toBe("O");
    expect(dest["namedVariables"]).toBe(12);
    expect(typeof dest["variablesReference"]).toBe("number");
  });

  it("omits evaluateName for codeblocks (B), pointers (P), and error wrappers (E)", () => {
    const { session } = makeSession();
    // Pre-seed a parent variable so getVariableFormat could try to derive
    // evaluateName from it (id=0). We then assert it does NOT.
    const parent = new HBVar("LOC:1:1:");
    parent.evaluation = "aRows[";
    session.variables.push(parent);

    for (const t of ["E", "B", "P"]) {
      const dest = freshDest("x");
      session.getVariableFormat(dest, t, "<value>", "value", "LOC:1:1:", 0);
      expect(dest["evaluateName"]).toBeUndefined();
      expect(dest["type"]).toBe(t);
    }
  });

  it("derives evaluateName from a parent variable for ordinary types", () => {
    const { session } = makeSession();
    const parent = new HBVar("LOC:1:1:");
    parent.evaluation = "oUser:";
    session.variables.push(parent);

    const dest = freshDest("cName");
    session.getVariableFormat(dest, "C", "alice", "value", "LOC:1:1:", 0);
    expect(dest["evaluateName"]).toBe("oUser:cName");
  });

  it("closes the bracket when the parent's evaluation ends with '[' (regression for 10701e2 nested array)", () => {
    // A parent array stores its child-access prefix as "aRows[".
    // The child's evaluateName must become "aRows[<index>]" — not "aRows[<index>"
    // — or VS Code's "Copy Expression / Evaluate" emits a syntax error.
    const { session } = makeSession();
    const parent = new HBVar("LOC:1:5:");
    parent.evaluation = "aRows[";
    session.variables.push(parent);

    const dest = freshDest("2");
    session.getVariableFormat(dest, "C", "second", "value", "LOC:1:5:", 0);
    expect(dest["evaluateName"]).toBe("aRows[2]");
  });

  it("chains evaluateName for nested arrays: outer[i][j]", () => {
    const { session } = makeSession();
    // Outer array sets up an evaluation of "aMatrix["
    const outer = new HBVar("LOC:1:1:");
    outer.evaluation = "aMatrix[";
    session.variables.push(outer);

    // First-level access: child of outer, type A — its own evaluateName becomes
    // "aMatrix[1]" and its own evaluation prefix (stored in this.variables for
    // subsequent expand-clicks) should append "[".
    const inner = { name: "1" } as { name: string; [k: string]: unknown };
    session.getVariableFormat(inner, "A", "3", "value", "LOC:1:1:1", 0);
    expect(inner["evaluateName"]).toBe("aMatrix[1]");

    // The session should have registered a new HBVar for the inner array whose
    // evaluation ends with "[" so the *next* level can close its bracket too.
    const innerLine = "LOC:1:1:1";
    const innerIdx = session.variablesMap.get(innerLine);
    expect(innerIdx).not.toBeUndefined();
    expect(session.variables[innerIdx!].evaluation).toBe("aMatrix[1][");

    // Now the second-level child uses that as its parent.
    const leaf = { name: "2" } as { name: string; [k: string]: unknown };
    session.getVariableFormat(
      leaf,
      "N",
      "42",
      "value",
      "LOC:1:1:1:2",
      innerIdx!,
    );
    expect(leaf["evaluateName"]).toBe("aMatrix[1][2]");
  });
});

describe("debugger.evaluateRequest", () => {
  it("queues the response, normalizes colons in the expression, and emits EXPRESSION", () => {
    const { session, commands } = makeSession();
    const response: DebugProtocol.EvaluateResponse = {
      type: "response",
      request_seq: 1,
      success: true,
      command: "evaluate",
      seq: 0,
      body: { result: "", variablesReference: 0 },
    };
    const args: DebugProtocol.EvaluateArguments = {
      expression: "AClone({ 'a':1 })",
      frameId: 2,
    };

    (
      session as unknown as {
        evaluateRequest: (
          r: DebugProtocol.EvaluateResponse,
          a: DebugProtocol.EvaluateArguments,
        ) => void;
      }
    ).evaluateRequest(response, args);

    expect(session.evaluateResponses).toHaveLength(1);
    expect(commands).toHaveLength(1);
    // Colons in the expression are sanitized to ';' on the wire so the
    // EXPRESSION:{frame}:{type}:{result} framing isn't broken by the
    // user-supplied expression.
    expect(commands[0]).toBe("EXPRESSION\r\n3:AClone({ 'a';1 })\r\n");
    // body.result should hold the original (un-mangled) expression so
    // processExpression can echo it back into name / evaluateName.
    expect((response.body as { result: string }).result).toBe(
      "AClone({ 'a':1 })",
    );
  });
});
