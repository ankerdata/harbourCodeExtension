import * as debugadapter from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import * as trueCase from "true-case-path";
import { localize, reInit as reInitLocalize } from "./myLocalize";

const platform = require("os").platform();

interface WinMonitorMessage {
  pid: number;
  message: string;
}

interface WinMonitor {
  start(cb: (info: WinMonitorMessage) => void): void;
  stop(): void;
}

let winMonitor: WinMonitor | undefined;
if (platform === "win32") {
  try {
    winMonitor = require("@yagisumi/win-output-debug-string")
      .monitor as WinMonitor;
  } catch (_e) {
    winMonitor = undefined;
  }
}

export class HBVar {
  command: string;
  responses: DebugProtocol.VariablesResponse[];
  evaluation: string;

  constructor(command: string) {
    this.command = command;
    this.responses = [];
    this.evaluation = "";
  }
}

interface BreakpointSource {
  response?: DebugProtocol.SetBreakpointsResponse;
  [line: string]:
    | DebugProtocol.SetBreakpointsResponse
    | string
    | number
    | undefined;
}

interface VariableFormatTarget {
  name?: string;
  type?: string;
  evaluateName?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
  [key: string]: unknown;
}

type LaunchArgs = DebugProtocol.LaunchRequestArguments & {
  port?: number;
  workspaceRoot?: string;
  sourcePaths?: string[];
  noDebug?: boolean;
  stopOnEntry?: boolean;
  terminalType?: "external" | "integrated" | "none";
  program?: string;
  workingDir?: string;
  arguments?: string[];
};

type AttachArgs = DebugProtocol.AttachRequestArguments & {
  port?: number;
  workspaceRoot?: string;
  sourcePaths?: string[];
  noDebug?: boolean;
  program?: string;
  process?: number;
};

/**
 * Per-thread mutable state for the debug session.
 *
 * Today, every harbour program presents as a single thread (id 1) to VS Code;
 * the session bootstraps with one ThreadState and routes all events through it.
 * As issue #8 lands the multi-thread refactor, each Harbour thread will own
 * its own ThreadState here (keyed by its harbour thread id) and DAP requests
 * will look up the target thread by args.threadId.
 */
export class ThreadState {
  id: number;
  name: string;
  socket: net.Socket | null = null;
  justStart: boolean = true;
  queue: string = "";
  processLine: ((line: string) => void) | undefined = undefined;
  variables: HBVar[] = [];
  variablesMap: Map<string, number> = new Map();
  /**
   * For each local index in `variables[]`, the global var ref handed out to VS
   * Code. The session keeps the inverse map (globalRef -> {thread, localIdx})
   * in `varRefs`; this side-map exists so that repeated `getVarReference` /
   * `sendScope` calls for the same local index dedupe to one global ref —
   * preserving the existing in-stop dedup semantics of `variablesMap` while
   * adding the cross-thread routing layer.
   */
  localToGlobalRef: Map<number, number> = new Map();
  stack: DebugProtocol.StackTraceResponse[] = [];
  stackArgs: DebugProtocol.StackTraceArguments[] = [];
  evaluateResponses: DebugProtocol.EvaluateResponse[] = [];
  scopeResponses: DebugProtocol.ScopesResponse[] = [];
  completionsResponse: DebugProtocol.CompletionsResponse | undefined =
    undefined;
  areasInfos: string[][] = [];
  currentStack: number = 1;

  constructor(id: number, name?: string) {
    this.id = id;
    this.name =
      name ?? (id === MAIN_THREAD_ID ? "Main Thread" : `Thread ${id}`);
  }
}

export const MAIN_THREAD_ID = 1;

export class harbourDebugSession extends debugadapter.DebugSession {
  Debugging: boolean = true;
  sourcePaths: string[] = [];
  breakpoints: Record<string, BreakpointSource> = {};
  processId: number | undefined = undefined;
  pathCache: Map<string, string> = new Map();
  processInterval: NodeJS.Timeout | undefined = undefined;
  startGo: boolean = false;

  /** Live harbour threads, keyed by harbour thread id. Bootstraps with the main thread. */
  threads: Map<number, ThreadState> = new Map([
    [MAIN_THREAD_ID, new ThreadState(MAIN_THREAD_ID)],
  ]);

  /** Allocator for non-main thread ids (assigned as new harbour threads connect). */
  private nextThreadId: number = MAIN_THREAD_ID + 1;

  /**
   * Global frameId / variablesReference registries. These IDs are the opaque
   * handles VS Code echoes back in `scopesRequest(args.frameId)`,
   * `evaluateRequest(args.frameId)`, and `variablesRequest(args.variablesReference)` —
   * none of which carry `args.threadId`. To route the request to the originating
   * thread we encode the owner here when handing out the ID, then look it up on
   * the way back. Kept simple (Map + monotonically-increasing counter) rather
   * than bit-packed because the maps are cleared per-thread on every new STACK,
   * so they don't grow without bound.
   */
  frameIds: Map<number, { thread: ThreadState; localFrameIdx: number }> =
    new Map();
  varRefs: Map<number, { thread: ThreadState; localIdx: number }> = new Map();
  private nextFrameId: number = 1;
  private nextVarRef: number = 1;

  /**
   * Active thread for the in-flight socket dispatch. processInput(buff, thread) sets
   * this for the duration of the call so the shim accessors below (and every method
   * still using `this.<perThreadField>`) route to the right ThreadState. DAP request
   * handlers (stackTraceRequest, evaluateRequest, …) will set this from args.threadId
   * once Phase 3 lands; until then they operate on the main thread by default.
   */
  currentThread: ThreadState = this.threads.get(MAIN_THREAD_ID)!;

  constructor() {
    super();
  }

  get mainThread(): ThreadState {
    return this.threads.get(MAIN_THREAD_ID)!;
  }

  // --- backwards-compat shims so the dispatcher code and existing tests can
  //     keep using session.<field>; each accessor proxies to currentThread,
  //     which processInput switches per-socket dispatch.
  get socket(): net.Socket | null {
    return this.currentThread.socket;
  }
  set socket(v: net.Socket | null) {
    this.currentThread.socket = v;
  }
  get justStart(): boolean {
    return this.currentThread.justStart;
  }
  set justStart(v: boolean) {
    this.currentThread.justStart = v;
  }
  get queue(): string {
    return this.currentThread.queue;
  }
  set queue(v: string) {
    this.currentThread.queue = v;
  }
  get processLine(): ((line: string) => void) | undefined {
    return this.currentThread.processLine;
  }
  set processLine(v: ((line: string) => void) | undefined) {
    this.currentThread.processLine = v;
  }
  get variables(): HBVar[] {
    return this.currentThread.variables;
  }
  set variables(v: HBVar[]) {
    this.currentThread.variables = v;
  }
  get variablesMap(): Map<string, number> {
    return this.currentThread.variablesMap;
  }
  set variablesMap(v: Map<string, number>) {
    this.currentThread.variablesMap = v;
  }
  get stack(): DebugProtocol.StackTraceResponse[] {
    return this.currentThread.stack;
  }
  set stack(v: DebugProtocol.StackTraceResponse[]) {
    this.currentThread.stack = v;
  }
  get stackArgs(): DebugProtocol.StackTraceArguments[] {
    return this.currentThread.stackArgs;
  }
  set stackArgs(v: DebugProtocol.StackTraceArguments[]) {
    this.currentThread.stackArgs = v;
  }
  get evaluateResponses(): DebugProtocol.EvaluateResponse[] {
    return this.currentThread.evaluateResponses;
  }
  set evaluateResponses(v: DebugProtocol.EvaluateResponse[]) {
    this.currentThread.evaluateResponses = v;
  }
  get scopeResponses(): DebugProtocol.ScopesResponse[] {
    return this.currentThread.scopeResponses;
  }
  set scopeResponses(v: DebugProtocol.ScopesResponse[]) {
    this.currentThread.scopeResponses = v;
  }
  get completionsResponse(): DebugProtocol.CompletionsResponse | undefined {
    return this.currentThread.completionsResponse;
  }
  set completionsResponse(v: DebugProtocol.CompletionsResponse | undefined) {
    this.currentThread.completionsResponse = v;
  }
  get areasInfos(): string[][] {
    return this.currentThread.areasInfos;
  }
  set areasInfos(v: string[][]) {
    this.currentThread.areasInfos = v;
  }
  get currentStack(): number {
    return this.currentThread.currentStack;
  }
  set currentStack(v: number) {
    this.currentThread.currentStack = v;
  }

  processInput(buff: string, thread: ThreadState = this.mainThread): void {
    const prevThread = this.currentThread;
    this.currentThread = thread;
    try {
      const lines = buff.split("\r\n");
      for (let i = 0; i < lines.length; i++) {
        try {
          const line = lines[i];
          if (line.length === 0) continue;
          if (this.processLine) {
            this.processLine(line);
            continue;
          }
          if (line.startsWith("STOP")) {
            this.sendEvent(
              new debugadapter.StoppedEvent(line.substring(5), thread.id),
            );
            this.sendEvent({
              event: "invalidated",
              body: { areas: ["variables", "stacks"], threadId: thread.id },
              seq: 0,
              type: "event",
            } as DebugProtocol.Event);
            continue;
          }
          if (line.startsWith("STACK")) {
            this.sendStack(line);
            continue;
          }
          if (line.startsWith("BREAK")) {
            this.processBreak(line);
            continue;
          }
          if (line.startsWith("ERROR") && !line.startsWith("ERROR_VAR")) {
            const stopEvt = new debugadapter.StoppedEvent(
              "error",
              thread.id,
              line.substring(6),
            );
            this.sendEvent(stopEvt);
            continue;
          }
          if (line.startsWith("EXPRESSION")) {
            this.processExpression(line);
            continue;
          }
          if (line.startsWith("LOG")) {
            this.sendEvent(
              new debugadapter.OutputEvent(
                line.substring(4) + "\r\n",
                "stdout",
              ),
            );
            continue;
          }
          if (line.startsWith("INERROR")) {
            this.sendScope(line[8] === "T");
            continue;
          }
          if (line.startsWith("COMPLETION")) {
            this.processCompletion();
            continue;
          }
          // Pick the LONGEST registered command that prefixes this line.
          // Nested-variable commands ("LOC:1:5:1") share a prefix with their
          // parents ("LOC:1:5:"), so a first-match loop would mis-route the
          // child's echo to the parent and the expand-click would do nothing.
          let longestVarIndex = -1;
          let longestLen = -1;
          for (const [command, varIndex] of this.variablesMap.entries()) {
            if (command.length > longestLen && line.startsWith(command)) {
              longestLen = command.length;
              longestVarIndex = varIndex;
            }
          }
          if (longestVarIndex >= 0) {
            this.sendVariables(longestVarIndex, line);
            continue;
          }
        } catch (lineError) {
          this.sendEvent(
            new debugadapter.OutputEvent(
              `Error processing line: ${(lineError as Error).message}\r\n`,
              "stderr",
            ),
          );
        }
      }
    } catch (error) {
      this.sendEvent(
        new debugadapter.OutputEvent(
          `Debugger error in processInput: ${(error as Error).message}\r\n`,
          "stderr",
        ),
      );
    } finally {
      this.currentThread = prevThread;
    }
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments,
  ): void {
    if (args.locale) {
      reInitLocalize({ locale: args.locale });
    }

    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsDelayedStackTraceLoading = false;
    response.body.supportsConditionalBreakpoints = true;
    response.body.supportsHitConditionalBreakpoints = true;
    response.body.supportsLogPoints = true;
    response.body.supportsCompletionsRequest = true;
    response.body.supportsTerminateRequest = true;
    response.body.exceptionBreakpointFilters = [
      {
        label: localize("harbour.dbgError.all"),
        filter: "all",
        default: false,
      },
      {
        label: localize("harbour.dbgError.notSeq"),
        filter: "notSeq",
        default: true,
      },
    ];
    this.sendResponse(response);
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    if (this.startGo) {
      this.command("GO\r\n");
      this.sendEvent(new debugadapter.ContinuedEvent(this.mainThread.id, true));
    }
    this.sendResponse(response);
  }

  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchArgs,
  ): void {
    const port = args.port ? args.port : 6110;
    const tc = this;
    this.justStart = true;
    this.sourcePaths = [];
    if (args.workspaceRoot) this.sourcePaths.push(args.workspaceRoot);
    if (args.sourcePaths)
      this.sourcePaths = this.sourcePaths.concat(args.sourcePaths);
    for (let idx = 0; idx < this.sourcePaths.length; idx++) {
      try {
        this.sourcePaths[idx] = trueCase.trueCasePathSync(
          this.sourcePaths[idx],
        );
      } catch (_ex) {
        this.sourcePaths.splice(idx, 1);
        idx--;
      }
    }
    this.Debugging = !args.noDebug;
    this.startGo = args.stopOnEntry === false || args.noDebug === true;
    const server = net
      .createServer((socket) => tc.evaluateClient(socket, server, args))
      .listen(port);
    switch (args.terminalType) {
      case "external":
      case "integrated":
        this.runInTerminalRequest(
          {
            kind: args.terminalType,
            cwd: args.workingDir ?? "",
            args: [args.program ?? ""].concat(args.arguments ?? []),
          },
          /*timeout*/ 0,
          (runResp) => {
            if (runResp && runResp.body && runResp.body.processId) {
              tc.setProcess(runResp.body.processId);
            }
          },
        );
        break;
      case "none":
      default: {
        if (!args.program) break;
        const childProcess = args.arguments
          ? cp.spawn(args.program, args.arguments, { cwd: args.workingDir })
          : cp.spawn(args.program, { cwd: args.workingDir });
        childProcess.on("error", (_e) => {
          tc.sendEvent(
            new debugadapter.OutputEvent(
              localize(
                "harbour.dbgError1",
                args.program ?? "",
                args.workingDir ?? "",
              ),
              "stderr",
            ),
          );
          tc.sendEvent(new debugadapter.TerminatedEvent());
        });
        childProcess.on("exit", (code, _signal) => {
          tc.sendEvent(new debugadapter.ExitedEvent(code ?? 0));
          if (!tc.processId) {
            tc.sendEvent(
              new debugadapter.OutputEvent(
                localize("harbour.prematureExit", code ?? 0),
                "stderr",
              ),
            );
            tc.sendEvent(new debugadapter.TerminatedEvent());
          }
        });
        if (childProcess.stderr) {
          childProcess.stderr.on("data", (data: Buffer | string) =>
            tc.sendEvent(
              new debugadapter.OutputEvent(data.toString(), "stderr"),
            ),
          );
        }
        if (childProcess.stdout) {
          childProcess.stdout.on("data", (data: Buffer | string) =>
            tc.sendEvent(
              new debugadapter.OutputEvent(data.toString(), "stdout"),
            ),
          );
        }
        if (childProcess.pid) this.setProcess(childProcess.pid);
        break;
      }
    }
    this.sendResponse(response);
  }

  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    args: AttachArgs,
  ): void {
    const port = args.port ? args.port : 6110;
    if (
      (args.process === undefined || args.process <= 0) &&
      (args.program ?? "").length === 0
    ) {
      response.success = false;
      response.message = "invalid parameter";
      this.sendResponse(response);
      return;
    }
    const tc = this;
    this.justStart = true;
    this.sourcePaths = [];
    if (args.workspaceRoot) this.sourcePaths.push(args.workspaceRoot);
    if (args.sourcePaths)
      this.sourcePaths = this.sourcePaths.concat(args.sourcePaths);
    for (let idx = 0; idx < this.sourcePaths.length; idx++) {
      try {
        this.sourcePaths[idx] = trueCase.trueCasePathSync(
          this.sourcePaths[idx],
        );
      } catch (_ex) {
        this.sourcePaths.splice(idx, 1);
        idx--;
      }
    }
    this.Debugging = !args.noDebug;
    this.startGo = true;
    const server = net
      .createServer((socket) => tc.evaluateClient(socket, server, args))
      .listen(port);
    this.sendResponse(response);
  }

  setProcess(pid: number | undefined): void {
    const tc = this;
    if (!pid) return;
    if (this.processId) {
      // Quietly drop a second pid; the first one wins.
      return;
    }
    this.processId = pid;
    winMonitor?.start((mInfo) => {
      if (mInfo.pid === pid) {
        this.sendEvent(
          new debugadapter.OutputEvent(mInfo.message + "\r\n", "console"),
        );
      }
    });
    this.processInterval = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch (_error) {
        winMonitor?.stop();
        tc.sendEvent(new debugadapter.TerminatedEvent());
        if (tc.processInterval) {
          clearInterval(tc.processInterval);
          tc.processInterval = undefined;
        }
      }
    }, 1000);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): void {
    this.command("DISCONNECT\r\n");
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = undefined;
    }
    winMonitor?.stop();
    this.sendResponse(response);
  }

  protected terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments,
  ): void {
    if (this.processId) {
      process.kill(this.processId, "SIGKILL");
    }
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = undefined;
    }
    winMonitor?.stop();
    this.sendResponse(response);
  }

  evaluateClient(
    socket: net.Socket,
    server: net.Server,
    args: LaunchArgs | AttachArgs,
  ): void {
    const tc = this;

    // Per-socket handshake handler. The handshake is exactly two CRLF-terminated
    // lines: <exeName>\r\n<pid>\r\n. After the handshake validates, the socket
    // is bound to a ThreadState and its data handler is swapped to processInput.
    // Each new connection gets its own ThreadState; the first connection becomes
    // the main thread, subsequent connections emit ThreadEvent('started').
    socket.on("data", (data) => {
      try {
        const lines = data.toString().split("\r\n");
        if (lines.length < 2) {
          socket.write("NO\r\n");
          socket.end();
          return;
        }
        const processId = parseInt(lines[1]);
        if (tc.processId) {
          if (tc.processId !== processId) {
            socket.write("NO\r\n");
            socket.end();
            return;
          }
        } else {
          if (args.program && args.program.length > 0) {
            const exeTarget = path
              .basename(args.program, path.extname(args.program))
              .toLowerCase();
            const clPath = path
              .basename(lines[0], path.extname(lines[0]))
              .toLowerCase();
            if (clPath !== exeTarget) {
              socket.write("NO\r\n");
              socket.end();
              return;
            }
          }
          const attachProcess = (args as AttachArgs).process;
          if (
            attachProcess !== undefined &&
            attachProcess > 0 &&
            attachProcess !== processId
          ) {
            socket.write("NO\r\n");
            socket.end();
            return;
          }
        }

        socket.write("HELLO\r\n");
        tc.setProcess(processId);
        tc.acceptThreadSocket(socket, server);
      } catch (_ex) {
        socket.write("NO\r\n");
        socket.end();
      }
    });
  }

  /**
   * Bind an authenticated socket to a ThreadState. The first connection becomes
   * the main thread (id 1) and triggers InitializedEvent for VS Code; subsequent
   * connections are additional Harbour threads and emit ThreadEvent('started').
   * Socket close emits ThreadEvent('exited') for non-main threads.
   */
  private acceptThreadSocket(socket: net.Socket, server: net.Server): void {
    const tc = this;
    const isFirst = !this.mainThread.socket;
    let thread: ThreadState;
    if (isFirst) {
      thread = this.mainThread;
      thread.socket = socket;
      this.sendEvent(new debugadapter.InitializedEvent());
      // Once the main thread is in, the listener can stop accepting *new* sockets
      // in single-thread builds. For MT, additional Harbour threads need the
      // listener open — so we leave it open and rely on disconnectRequest /
      // terminateRequest to tear it down.
      void server;
    } else {
      const tid = this.nextThreadId++;
      thread = new ThreadState(tid);
      thread.socket = socket;
      this.threads.set(tid, thread);
      this.sendEvent(new debugadapter.ThreadEvent("started", tid));
    }

    socket.removeAllListeners("data");
    socket.on("data", (data2) => {
      try {
        tc.processInput(data2.toString(), thread);
      } catch (error) {
        tc.sendEvent(
          new debugadapter.OutputEvent(
            `Error processing socket data: ${(error as Error).message}\r\n`,
            "stderr",
          ),
        );
      }
    });
    socket.on("error", (error) => {
      tc.sendEvent(
        new debugadapter.OutputEvent(
          `Socket error (thread ${thread.id}): ${error.message}\r\n`,
          "stderr",
        ),
      );
    });
    socket.on("close", () => {
      thread.socket = null;
      if (thread.id !== MAIN_THREAD_ID) {
        tc.threads.delete(thread.id);
        tc.sendEvent(new debugadapter.ThreadEvent("exited", thread.id));
      }
    });

    // Drain any commands queued before the handshake completed.
    try {
      if (thread.queue.length > 0) socket.write(thread.queue);
    } catch (error) {
      tc.sendEvent(
        new debugadapter.OutputEvent(
          `Error writing to socket: ${(error as Error).message}\r\n`,
          "stderr",
        ),
      );
    }
    thread.justStart = false;
    thread.queue = "";
  }

  /** Look up the ThreadState for a DAP-supplied threadId; fall back to the main
   *  thread when threadId is missing or unknown (single-thread programs hit this). */
  selectThread(threadId?: number): ThreadState {
    if (threadId !== undefined) {
      const t = this.threads.get(threadId);
      if (t) return t;
    }
    return this.mainThread;
  }

  /** Mint a new global frame ID for a frame that belongs to `thread`. */
  allocateFrameId(thread: ThreadState, localFrameIdx: number): number {
    const id = this.nextFrameId++;
    this.frameIds.set(id, { thread, localFrameIdx });
    return id;
  }

  /**
   * Return the global var ref for `(thread, localIdx)`, allocating once and
   * memoising on the thread so that callers within a single STOP that hit the
   * same local index (the dedup path through `variablesMap`) get back the same
   * global ref VS Code already saw.
   */
  ensureGlobalRef(thread: ThreadState, localIdx: number): number {
    const existing = thread.localToGlobalRef.get(localIdx);
    if (existing !== undefined) return existing;
    const id = this.nextVarRef++;
    this.varRefs.set(id, { thread, localIdx });
    thread.localToGlobalRef.set(localIdx, id);
    return id;
  }

  /**
   * Drop a thread's frame IDs from the session registry. Called from sendStack
   * before allocating a new batch — without this the registry would grow
   * unboundedly across stops, and stale IDs could collide with VS Code's
   * post-invalidation re-requests.
   */
  clearThreadFrameIds(thread: ThreadState): void {
    for (const [id, info] of this.frameIds) {
      if (info.thread === thread) this.frameIds.delete(id);
    }
  }

  /**
   * Drop a thread's variables registrations + the corresponding global refs.
   * Called from stackTraceRequest when the runtime's stack is being refetched,
   * mirroring the existing per-thread `variables`/`variablesMap` reset.
   */
  clearThreadVars(thread: ThreadState): void {
    for (const globalRef of thread.localToGlobalRef.values()) {
      this.varRefs.delete(globalRef);
    }
    thread.variables = [];
    thread.variablesMap.clear();
    thread.localToGlobalRef.clear();
  }

  command(cmd: string): void {
    this.commandTo(this.currentThread, cmd);
  }

  commandTo(thread: ThreadState, cmd: string): void {
    if (thread.justStart) {
      thread.queue += cmd;
    } else if (thread.socket && !thread.socket.destroyed) {
      try {
        thread.socket.write(cmd);
      } catch (error) {
        this.sendEvent(
          new debugadapter.OutputEvent(
            `Debugger error: ${(error as Error).message}\r\n`,
            "stderr",
          ),
        );
      }
    }
  }

  /// STACK
  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): void {
    const thread = this.selectThread(args.threadId);
    if (thread.stack.length === 0) {
      this.clearThreadVars(thread);
      this.commandTo(thread, "STACK\r\n");
    }
    thread.stack.push(response);
    thread.stackArgs.push(args);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    const threads: DebugProtocol.Thread[] = [];
    for (const t of this.threads.values()) {
      threads.push(new debugadapter.Thread(t.id, t.name));
    }
    response.body = { threads };
    this.sendResponse(response);
  }

  sendStack(line: string): void {
    // Capture the thread that requested the stack now — by the time the
    // line-by-line frame data arrives, processInput will still set
    // currentThread to this same thread (frame data flows on the same socket),
    // but binding `thread` here makes the frameId-allocation below explicit
    // and survives any future change to where processLine fires from.
    const thread = this.currentThread;
    this.clearThreadFrameIds(thread);
    const nStack = parseInt(line.substring(6));
    const frames: DebugProtocol.StackFrame[] = new Array(nStack);
    let j = 0;
    const tc = this;
    this.processLine = function (line: string): void {
      try {
        const infos = line.split(":");
        for (let i = 0; i < infos.length; i++)
          infos[i] = infos[i].replace(";", ":");

        const cacheKey = infos[0];
        let completePath = tc.pathCache.get(cacheKey);
        let found = false;

        if (!completePath && infos[0].length > 0) {
          completePath = infos[0];
          if (path.isAbsolute(infos[0]) && fs.existsSync(infos[0])) {
            found = true;
            try {
              completePath = trueCase.trueCasePathSync(infos[0]);
            } catch (_ex) {
              // keep original on failure
            }
          } else {
            for (let i = 0; i < tc.sourcePaths.length; i++) {
              const joinedPath = path.join(tc.sourcePaths[i], infos[0]);
              if (fs.existsSync(joinedPath)) {
                completePath = joinedPath;
                found = true;
                try {
                  completePath = trueCase.trueCasePathSync(
                    infos[0],
                    tc.sourcePaths[i],
                  );
                } catch (_ex) {
                  try {
                    completePath = trueCase.trueCasePathSync(completePath);
                  } catch (_ex2) {
                    // keep original
                  }
                }
                break;
              }
            }
          }
          if (found && completePath) {
            tc.pathCache.set(cacheKey, completePath);
          }
        } else if (completePath) {
          found = true;
        }

        if (found && completePath) infos[0] = path.basename(completePath);
        const frameId = tc.allocateFrameId(thread, j);
        frames[j] = new debugadapter.StackFrame(
          frameId,
          infos[2],
          new debugadapter.Source(infos[0], completePath),
          parseInt(infos[1]),
        );
        j++;
        if (j === nStack) {
          while (tc.stack.length > 0) {
            const sArgs = tc.stackArgs.shift()!;
            const resp = tc.stack.shift()!;
            sArgs.startFrame = sArgs.startFrame || 0;
            sArgs.levels = sArgs.levels || frames.length;
            sArgs.levels += sArgs.startFrame;
            resp.body = {
              stackFrames: frames.slice(sArgs.startFrame, sArgs.levels),
            };
            tc.sendResponse(resp);
          }
          tc.processLine = undefined;
        }
      } catch (error) {
        tc.processLine = undefined;
        tc.sendEvent(
          new debugadapter.OutputEvent(
            `Error processing stack frame: ${(error as Error).message}\r\n`,
            "stderr",
          ),
        );
      }
    };
  }

  /// VARIABLES
  /**
   * Resolve a DAP frameId back to its owning thread + 0-based local frame
   * index. Falls back to (mainThread, frameId) when the id wasn't allocated by
   * us — that path covers single-thread programs that pre-date the registry as
   * well as synthetic test inputs that pass raw frame indices.
   */
  private resolveFrame(frameId: number): {
    thread: ThreadState;
    localFrameIdx: number;
  } {
    const info = this.frameIds.get(frameId);
    if (info) return info;
    return { thread: this.mainThread, localFrameIdx: frameId };
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): void {
    const { thread, localFrameIdx } = this.resolveFrame(args.frameId);
    thread.currentStack = localFrameIdx + 1;
    thread.scopeResponses.push(response);
    this.commandTo(thread, "INERROR\r\n");
  }

  sendScope(inError: boolean): void {
    // sendScope runs from processInput's INERROR handler, so currentThread is
    // already the thread that emitted the response — bind it locally for clarity.
    const thread = this.currentThread;
    const commands: string[] = [];
    if (inError) commands.push("ERROR_VAR");
    commands.push(
      "LOCALS",
      "PUBLICS",
      "PRIVATES",
      "PRIVATE_CALLEE",
      "STATICS",
      "WORKAREAS",
    );

    if (thread.variablesMap.get(commands[0]) === undefined) {
      commands.forEach((cmd) => {
        const index = thread.variables.length;
        thread.variables.push(new HBVar(cmd));
        thread.variablesMap.set(cmd, index);
      });
    }
    const scopeLabels: string[] = [];
    if (inError) scopeLabels.push("Error");
    scopeLabels.push(
      "Local",
      "Public",
      "Private local",
      "Private external",
      "Statics",
      "Workareas",
    );
    const scopes: debugadapter.Scope[] = [];
    for (let i = 0; i < commands.length; i++) {
      const localIdx = thread.variablesMap.get(commands[i])!;
      scopes.push(
        new debugadapter.Scope(
          scopeLabels[i],
          this.ensureGlobalRef(thread, localIdx),
        ),
      );
    }
    const response = thread.scopeResponses.shift();
    if (!response) {
      this.sendEvent(
        new debugadapter.OutputEvent(
          `No response found for scopes request\r\n`,
          "stderr",
        ),
      );
      return;
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  sendAreaHeaders(
    response: DebugProtocol.VariablesResponse,
    cmd: string,
  ): void {
    // AREA:Alias:Area:fCount:recno:reccount:scope:
    //   0    1    2     3      4     5       6
    const infos = this.areasInfos[parseInt(cmd.substring(4))];
    const vars: DebugProtocol.Variable[] = [];
    const baseEval = infos[1] + "->";
    const recNo = parseInt(infos[4]);
    const recCount = parseInt(infos[5]);

    let v: DebugProtocol.Variable = new debugadapter.Variable(
      "recNo",
      infos[4],
    );
    if (recNo > recCount) v.value = "eof";
    if (recNo <= 0) v.value = "bof";
    v.evaluateName = baseEval + "(recNo())";
    vars.push(v);

    v = new debugadapter.Variable("recCount", infos[5]);
    v.evaluateName = baseEval + "(recCount())";
    vars.push(v);

    v = new debugadapter.Variable("Scope", '"' + infos[6] + '"');
    v.evaluateName = baseEval + "(OrdName(IndexOrd()))";
    v.type = "C";
    vars.push(v);

    const columns: DebugProtocol.Variable = new debugadapter.Variable(
      "Fields",
      "",
    );
    columns.indexedVariables = parseInt(infos[3]);
    columns.variablesReference = this.getVarReference(
      cmd + ":FIELDS",
      baseEval,
    );
    vars.push(columns);
    response.body = { variables: vars };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const ref = this.varRefs.get(args.variablesReference);
    if (!ref) {
      this.sendResponse(response);
      return;
    }
    const { thread, localIdx } = ref;
    if (localIdx >= thread.variables.length) {
      this.sendResponse(response);
      return;
    }
    const hbVar = thread.variables[localIdx];
    const cmd = hbVar.command;
    if (cmd.startsWith("AREA") && cmd.indexOf(":") < 0) {
      // sendAreaHeaders dispatches `getVarReference` for the FIELDS sub-ref,
      // which keys off currentThread; pivot the dispatch context to the owning
      // thread so the FIELDS ref is allocated against it (and not against
      // whichever thread happens to be currentThread today, which is mainThread
      // when called from a DAP request).
      this.withCurrentThread(thread, () =>
        this.sendAreaHeaders(response, cmd),
      );
      return;
    }
    const hbStart = args.start ? args.start + 1 : 1;
    const hbCount = args.count ? args.count : 0;
    hbVar.responses.push(response);
    this.commandTo(
      thread,
      `${cmd}\r\n${thread.currentStack}:${hbStart}:${hbCount}\r\n`,
    );
  }

  /**
   * Run `fn` with `currentThread` pivoted to `thread`. Mirrors the save/restore
   * pattern in processInput so DAP request handlers can borrow a thread's
   * dispatch context for the duration of a synchronous helper that still uses
   * the shim accessors (e.g. sendAreaHeaders -> getVarReference).
   */
  private withCurrentThread<T>(thread: ThreadState, fn: () => T): T {
    const prev = this.currentThread;
    this.currentThread = thread;
    try {
      return fn();
    } finally {
      this.currentThread = prev;
    }
  }

  getVarReference(line: string, evalTxt: string): number {
    const thread = this.currentThread;
    const existingIndex = thread.variablesMap.get(line);
    if (existingIndex !== undefined) {
      return this.ensureGlobalRef(thread, existingIndex);
    }

    const colonCount = (line.match(/:/g) || []).length;
    if (colonCount > 3) {
      const parts = line.split(":");
      line =
        parts.slice(0, 3).join(":") + ":" + parts.slice(3, -1).join(":") + ":";
    }
    const hbVar = new HBVar(line);
    hbVar.evaluation = evalTxt;
    const localIdx = thread.variables.length;
    thread.variables.push(hbVar);
    thread.variablesMap.set(line, localIdx);
    return this.ensureGlobalRef(thread, localIdx);
  }

  getVariableFormat(
    dest: VariableFormatTarget,
    type: string,
    value: string,
    valueName: string,
    line: string,
    id?: number,
  ): VariableFormatTarget {
    if (type === "C") {
      value = value.replace(/\\\$\\n/g, "\n");
      value = value.replace(/\\\$\\r/g, "\r");
    }
    dest[valueName] = value;
    dest.type = type;
    if (
      ["E", "B", "P"].indexOf(type) === -1 &&
      id !== undefined &&
      id >= 0 &&
      id < this.variables.length
    ) {
      dest.evaluateName = "";
      if (this.variables[id].evaluation)
        dest.evaluateName = this.variables[id].evaluation;
      dest.evaluateName += dest.name ?? "";
      if (
        this.variables[id].evaluation &&
        this.variables[id].evaluation.endsWith("[")
      ) {
        dest.evaluateName += "]";
      }
    }
    switch (type) {
      case "A":
        dest.variablesReference = this.getVarReference(
          line,
          (dest.evaluateName ?? "") + "[",
        );
        dest[valueName] = `ARRAY(${value})`;
        dest.indexedVariables = parseInt(value);
        break;
      case "H":
        dest.variablesReference = this.getVarReference(
          line,
          (dest.evaluateName ?? "") + "[",
        );
        dest[valueName] = `HASH(${value})`;
        dest.namedVariables = parseInt(value);
        break;
      case "O": {
        dest.variablesReference = this.getVarReference(
          line,
          (dest.evaluateName ?? "") + ":",
        );
        const infos = value.split(" ");
        dest[valueName] = `CLASS ${infos[0]}`;
        dest.namedVariables = parseInt(infos[1]);
        break;
      }
    }
    return dest;
  }

  sendVariables(id: number, _line: string): void {
    const vars: DebugProtocol.Variable[] = [];
    const tc = this;
    this.processLine = function (line: string): void {
      try {
        if (line.startsWith("END")) {
          const resp = tc.variables[id].responses.shift();
          if (resp) {
            resp.body = { variables: vars };
            tc.sendResponse(resp);
          }
          tc.processLine = undefined;
          return;
        }
        const infos = line.split(":");
        if (infos[0] === "AREA") {
          // AREA:Alias:Area:fCount:recno:reccount:scope:
          //   0    1    2     3       4     5       6
          const value = "AREA " + infos[2];
          const v: DebugProtocol.Variable = new debugadapter.Variable(
            infos[1],
            value,
          );
          v.indexedVariables = 4;
          tc.areasInfos[parseInt(infos[2])] = infos;
          v.variablesReference = tc.getVarReference(
            "AREA" + infos[2],
            infos[1] + "->",
          );
          vars.push(v);
          return;
        }
        const normalized =
          infos[0] + ":" + infos[1] + ":" + infos[2] + ":" + infos[3];
        if (infos.length > 7) {
          infos[6] = infos.splice(6).join(":");
        }
        const v: DebugProtocol.Variable = new debugadapter.Variable(
          infos[4],
          infos[6],
        );
        tc.getVariableFormat(
          v as unknown as VariableFormatTarget,
          infos[5],
          infos[6],
          "value",
          normalized,
          id,
        );
        vars.push(v);
      } catch (error) {
        tc.processLine = undefined;
        tc.sendEvent(
          new debugadapter.OutputEvent(
            `Error processing variable: ${(error as Error).message}\r\n`,
            "stderr",
          ),
        );
        if (
          tc.variables[id] &&
          tc.variables[id].responses &&
          tc.variables[id].responses.length > 0
        ) {
          const resp = tc.variables[id].responses.shift()!;
          resp.body = { variables: vars };
          tc.sendResponse(resp);
        }
      }
    };
  }

  /// PROGRAM FLOW
  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments,
  ): void {
    const thread = this.selectThread(args.threadId);
    this.commandTo(thread, "GO\r\n");
    this.sendResponse(response);
  }
  protected nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments,
  ): void {
    const thread = this.selectThread(args.threadId);
    this.commandTo(thread, "NEXT\r\n");
    this.sendResponse(response);
  }
  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
  ): void {
    const thread = this.selectThread(args.threadId);
    this.commandTo(thread, "STEP\r\n");
    this.sendResponse(response);
  }
  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
  ): void {
    const thread = this.selectThread(args.threadId);
    this.commandTo(thread, "EXIT\r\n");
    this.sendResponse(response);
  }
  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments,
  ): void {
    const thread = this.selectThread(args.threadId);
    this.commandTo(thread, "PAUSE\r\n");
    this.sendResponse(response);
  }

  /// breakpoints
  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const messageParts: string[] = [];
    response.body = { breakpoints: [] };
    const breakpointsArg = args.breakpoints ?? [];
    response.body.breakpoints.length = breakpointsArg.length;
    const src = (args.source.name ?? "").toLowerCase();
    if (!(src in this.breakpoints)) {
      this.breakpoints[src] = {};
    }
    const dest = this.breakpoints[src];
    for (const key of Object.keys(dest)) {
      if (key !== "response") {
        const v = dest[key];
        if (typeof v === "string") dest[key] = "-" + v;
      }
    }
    dest.response = response;
    for (let i = 0; i < breakpointsArg.length; i++) {
      const breakpoint = breakpointsArg[i];
      response.body.breakpoints[i] = new debugadapter.Breakpoint(
        false,
        breakpoint.line,
      );

      const bpParts: string[] = [
        "BREAKPOINT\r\n",
        `+:${src}:${breakpoint.line}`,
      ];
      if (breakpoint.condition && breakpoint.condition.length > 0) {
        bpParts.push(`:?:${breakpoint.condition.replace(/:/g, ";")}`);
      }
      if (breakpoint.hitCondition) {
        bpParts.push(`:C:${breakpoint.hitCondition}`);
      }
      if (breakpoint.logMessage) {
        bpParts.push(`:L:${breakpoint.logMessage.replace(/:/g, ";")}`);
      }
      const thisBreakpoint = bpParts.join("");

      const existing = dest[breakpoint.line];
      if (
        typeof existing === "string" &&
        existing.substring(1) === thisBreakpoint
      ) {
        dest[breakpoint.line] = thisBreakpoint;
        response.body.breakpoints[i].verified = true;
      } else {
        messageParts.push(thisBreakpoint, "\r\n");
        dest[breakpoint.line] = thisBreakpoint;
      }
    }
    for (const key of Object.keys(dest)) {
      if (key !== "response") {
        const v = dest[key];
        if (typeof v === "string" && v.substring(0, 1) === "-") {
          messageParts.push("BREAKPOINT\r\n", `-:${src}:${key}\r\n`);
          dest[key] = "-";
        }
      }
    }
    this.checkBreakPoint(src);
    this.command(messageParts.join(""));
  }

  processBreak(line: string): void {
    try {
      const aInfos = line.split(":");
      if (aInfos.length < 2 || !(aInfos[1] in this.breakpoints)) return;
      const aLine = parseInt(aInfos[2]);
      const aActual = parseInt(aInfos[3]);
      const dest = this.breakpoints[aInfos[1]];
      if (
        !dest ||
        !dest.response ||
        !dest.response.body ||
        !dest.response.body.breakpoints
      )
        return;
      const idBreak = dest.response.body.breakpoints.findIndex(
        (b) => b.line === aLine,
      );
      if (idBreak === -1) {
        if (String(aLine) in dest) {
          delete dest[String(aLine)];
          this.checkBreakPoint(aInfos[1]);
        }
        return;
      }
      if (aActual > 1) {
        dest.response.body.breakpoints[idBreak].line = aActual;
        dest.response.body.breakpoints[idBreak].verified = true;
        dest[String(aLine)] = 1;
      } else {
        dest.response.body.breakpoints[idBreak].verified = false;
        if (aInfos[4] === "notfound") {
          dest.response.body.breakpoints[idBreak].message = localize(
            "harbour.dbgNoModule",
          );
        } else {
          dest.response.body.breakpoints[idBreak].message =
            localize("harbour.dbgNoLine");
        }
        dest[String(aLine)] = 1;
      }
      this.checkBreakPoint(aInfos[1]);
    } catch (error) {
      this.sendEvent(
        new debugadapter.OutputEvent(
          `Error processing breakpoint: ${(error as Error).message}\r\n`,
          "stderr",
        ),
      );
    }
  }

  checkBreakPoint(src: string): void {
    const dest = this.breakpoints[src];
    for (const key of Object.keys(dest)) {
      if (key !== "response" && dest[key] !== 1) return;
    }
    if (dest.response) this.sendResponse(dest.response);
  }

  /// Exception / error
  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    let errorType = args.filters.length;
    // 0 - no stop on error; 1 - only out-of-sequence; 2 - stop all
    if (errorType === 1 && args.filters[0] !== "notSeq") {
      errorType++;
    }
    this.command(`ERRORTYPE\r\n${errorType}\r\n`);
    this.sendResponse(response);
  }

  /// Evaluation
  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): void {
    // When the caller supplies frameId we look up its owning thread; otherwise
    // (Watch panel without an active stack frame) fall back to the main thread
    // and its currentStack — preserving pre-MT behaviour.
    let thread: ThreadState;
    let frameNumber: number;
    if (Number.isInteger(args.frameId)) {
      const resolved = this.resolveFrame(args.frameId as number);
      thread = resolved.thread;
      frameNumber = resolved.localFrameIdx + 1;
    } else {
      thread = this.mainThread;
      frameNumber = thread.currentStack;
    }
    response.body = { result: args.expression, variablesReference: 0 };
    thread.evaluateResponses.push(response);
    this.commandTo(
      thread,
      `EXPRESSION\r\n${frameNumber}:${args.expression.replace(/:/g, ";")}\r\n`,
    );
  }

  processExpression(line: string): void {
    try {
      // EXPRESSION:{frame}:{type}:{result}
      // result is the last field and may itself contain ':' (e.g. Windows paths),
      // so take everything after the third ':' verbatim.
      const colonIndex1 = line.indexOf(":", 11); // After "EXPRESSION:"
      const colonIndex2 = line.indexOf(":", colonIndex1 + 1);

      const frame = line.substring(11, colonIndex1);
      const type = line.substring(colonIndex1 + 1, colonIndex2);
      const result = line.substring(colonIndex2 + 1);

      const resp = this.evaluateResponses.shift();
      if (!resp) {
        this.sendEvent(
          new debugadapter.OutputEvent(
            `No response found for expression evaluation\r\n`,
            "stderr",
          ),
        );
        return;
      }
      const originalResult = (resp.body as { result: string }).result;
      const expLine =
        "EXP:" + frame + ":" + originalResult.replace(/:/g, ";") + ":";
      const body = resp.body as VariableFormatTarget & { result: string };
      body.name = originalResult;
      body.evaluateName = originalResult;
      if (type === "E") {
        resp.success = false;
        resp.message = result;
        (resp as { body?: unknown }).body = undefined;
      } else {
        this.getVariableFormat(body, type, result, "result", expLine);
      }
      this.sendResponse(resp);
    } catch (error) {
      this.sendEvent(
        new debugadapter.OutputEvent(
          `Error processing expression: ${(error as Error).message}\r\n`,
          "stderr",
        ),
      );
    }
  }

  /// Completion
  protected completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments,
  ): void {
    let thread: ThreadState;
    let frameNumber: number;
    if (args.frameId !== undefined) {
      const resolved = this.resolveFrame(args.frameId);
      thread = resolved.thread;
      frameNumber = resolved.localFrameIdx + 1;
    } else {
      thread = this.mainThread;
      frameNumber = thread.currentStack;
    }
    thread.completionsResponse = response;
    const linesArr = args.text.split(/[\r\n]{1,2}/);
    let completionText = args.line ? linesArr[args.line - 1] : linesArr[0];
    completionText = completionText.substring(0, args.column - 1);
    const lastWord = completionText.match(/[\w\:]+$/i);
    if (lastWord) completionText = lastWord[0];
    this.commandTo(
      thread,
      `COMPLETION\r\n${frameNumber}:${completionText}\r\n`,
    );
  }

  processCompletion(): void {
    const tc = this;
    this.processLine = function (line: string): void {
      try {
        if (line === "END") {
          if (tc.completionsResponse) tc.sendResponse(tc.completionsResponse);
          tc.processLine = undefined;
          return;
        }
        if (!tc.completionsResponse) return;
        if (!tc.completionsResponse.body)
          tc.completionsResponse.body = { targets: [] };
        if (!tc.completionsResponse.body.targets)
          tc.completionsResponse.body.targets = [];
        const type = line.substring(0, line.indexOf(":"));
        line = line.substring(line.indexOf(":") + 1);
        const thisCompletion: DebugProtocol.CompletionItem =
          new debugadapter.CompletionItem(line, 0);
        thisCompletion.type =
          type === "F"
            ? "function"
            : type === "M"
              ? "field"
              : type === "D"
                ? "variable"
                : "value";
        tc.completionsResponse.body.targets.push(thisCompletion);
      } catch (error) {
        tc.processLine = undefined;
        tc.sendEvent(
          new debugadapter.OutputEvent(
            `Error processing completion: ${(error as Error).message}\r\n`,
            "stderr",
          ),
        );
        if (tc.completionsResponse) {
          if (!tc.completionsResponse.body)
            tc.completionsResponse.body = { targets: [] };
          if (!tc.completionsResponse.body.targets)
            tc.completionsResponse.body.targets = [];
          tc.sendResponse(tc.completionsResponse);
        }
      }
    };
  }
}

/// END
if (require.main === module) {
  debugadapter.DebugSession.run(harbourDebugSession);
}
