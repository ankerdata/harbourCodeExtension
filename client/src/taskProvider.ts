import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import * as os from "os";
import { localize } from "./myLocalize";
import { getAllWorkspaceFiles } from "./utils";

function resolvePredefinedVariables(v: string): string {
  function replace(what: string, solved: string): void {
    if (v.indexOf(what) >= 0) {
      do {
        v = v.replace(what, solved);
      } while (v.indexOf(what) >= 0);
    }
  }
  let textDocument: vscode.TextDocument | undefined;
  let parsed: path.ParsedPath | undefined;
  if (
    vscode &&
    vscode.window &&
    vscode.window.activeTextEditor &&
    vscode.window.activeTextEditor.document
  ) {
    textDocument = vscode.window.activeTextEditor.document;
    parsed = path.parse(textDocument.uri.fsPath);
  }
  let workspace0: vscode.WorkspaceFolder | undefined;
  let relativeParsed: path.ParsedPath | undefined;
  let relativePath: string | undefined;
  if (textDocument) {
    workspace0 = vscode.workspace.getWorkspaceFolder(textDocument.uri);
  }
  if (workspace0 && textDocument) {
    relativePath = path.relative(
      workspace0.uri.fsPath,
      textDocument.uri.fsPath,
    );
    relativeParsed = path.parse(relativePath);
  } else if (vscode.workspace.workspaceFolders) {
    workspace0 = vscode.workspace.workspaceFolders[0];
  }
  if (workspace0) {
    replace("${workspaceFolder}", workspace0.uri.fsPath);
    replace("${workspaceFolderBasename}", workspace0.name);
  }
  replace("${file}", textDocument ? textDocument.uri.fsPath : "");
  replace("${relativeFile}", relativePath ? relativePath : "");
  replace("${relativeFileDirname}", relativeParsed ? relativeParsed.dir : "");
  replace("${fileBasename}", parsed ? parsed.base : "");
  replace("${fileBasenameNoExtension}", parsed ? parsed.name : "");
  replace("${fileDirname}", parsed ? path.basename(parsed.dir) : "");
  replace("${fileExtname}", parsed ? parsed.ext : "");
  return v;
}

class HRBTask implements vscode.TaskProvider {
  GetArgs(fileName: string): string[] {
    const section = vscode.workspace.getConfiguration("harbour");
    const warningLevel = section.get<number>("warningLevel", 1);
    const args: string[] = ["-w" + warningLevel, fileName];
    const extraIncludePaths = section.get<string[]>("extraIncludePaths", []);
    for (let i = 0; i < extraIncludePaths.length; i++) {
      const pathVal = resolvePredefinedVariables(extraIncludePaths[i]);
      args.push("-I" + pathVal);
    }
    const extraOptions = section.get<string>("extraOptions", "");
    return args.concat(extraOptions.split(" ").filter((el) => el.length !== 0));
  }

  provideTasks(
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Task[]> {
    let textDocument: vscode.TextDocument | undefined;
    if (
      vscode &&
      vscode.window &&
      vscode.window.activeTextEditor &&
      vscode.window.activeTextEditor.document
    )
      textDocument = vscode.window.activeTextEditor.document;
    const retValue: vscode.Task[] = [];
    if (textDocument && textDocument.languageId === "harbour") {
      const section = vscode.workspace.getConfiguration("harbour");
      const compilerExecutable = section.get<string>(
        "compilerExecutable",
        "harbour",
      );
      const args = this.GetArgs(textDocument.fileName);
      const file_cwd = path.dirname(textDocument.fileName);
      retValue.push(
        new vscode.Task(
          { type: "Harbour", input: "${file}", output: "portable" },
          vscode.TaskScope.Workspace,
          localize("harbour.task.portableName"),
          "Harbour",
          new vscode.ShellExecution(compilerExecutable, args.concat(["-gh"]), {
            cwd: file_cwd,
          }),
          "$harbour",
        ),
      );
      retValue.push(
        new vscode.Task(
          {
            type: "Harbour",
            input: "${file}",
            output: "C code",
            "c-type": "compact",
          },
          vscode.TaskScope.Workspace,
          localize("harbour.task.cCodeName"),
          "Harbour",
          new vscode.ShellExecution(compilerExecutable, args.concat(["-gc0"]), {
            cwd: file_cwd,
          }),
          "$harbour",
        ),
      );
    }
    return retValue;
  }

  resolveTask(
    task: vscode.Task,
    _token: vscode.CancellationToken,
  ): vscode.Task | undefined {
    const definition = task.definition as unknown as {
      input: string;
      output?: string;
      "c-type"?: string;
    };
    const input = resolvePredefinedVariables(definition.input);
    const ext = path.extname(input);
    if (ext !== ".prg") return undefined;
    const retTask = new vscode.Task(
      task.definition,
      vscode.TaskScope.Workspace,
      "build " + input,
      "Harbour",
    );

    let args = this.GetArgs(input);
    if (definition.output === "C code") {
      if (definition["c-type"]) {
        const id = ["compact", "normal", "verbose", "real C Code"].indexOf(
          definition["c-type"],
        );
        if (id >= 0) {
          args = args.concat(["-gc" + id]);
        } else args = args.concat(["-gc"]);
      } else args = args.concat(["-gc"]);
    } else args = args.concat(["-gh"]);
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc) return undefined;
    const file_cwd = path.dirname(activeDoc.fileName);
    const section = vscode.workspace.getConfiguration("harbour");
    const compilerExecutable = section.get<string>(
      "compilerExecutable",
      "harbour",
    );
    retTask.execution = new vscode.ShellExecution(
      compilerExecutable,
      args.concat(["-gc"]),
      { cwd: file_cwd },
    );
    if (
      !Array.isArray(task.problemMatchers) ||
      task.problemMatchers.length === 0
    )
      retTask.problemMatchers = ["$harbour"];
    else retTask.problemMatchers = task.problemMatchers;
    return retTask;
  }
}

const myTerminals: Record<string, HBMK2Terminal | undefined> = {};

function getTerminalFn(task: vscode.Task): () => HBMK2Terminal {
  if (!(task.name in myTerminals)) {
    myTerminals[task.name] = undefined;
  }
  return () => {
    if (!myTerminals[task.name])
      myTerminals[task.name] = new HBMK2Terminal(task);
    const taskBatch = getBatch(task);
    const existing = myTerminals[task.name];
    if (
      existing &&
      (existing.batch || taskBatch) &&
      taskBatch !== existing.batch
    ) {
      myTerminals[task.name] = new HBMK2Terminal(task);
    }
    const ret = myTerminals[task.name]!;
    ret.append(task);
    return ret;
  };
}

function ToAbsolute(fileName: string): string | undefined {
  if (path.isAbsolute(fileName)) return fileName;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return undefined;
  for (let i = 0; i < folders.length; i++) {
    const thisDir = folders[i];
    const uri = vscode.Uri.parse(thisDir.uri.toString());
    if (uri.scheme !== "file") continue;
    const p = path.join(uri.fsPath, fileName);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

interface TaskDefinitionLike {
  setupBatch?: string;
  options?: { env?: Record<string, string> };
  debugSymbols?: boolean;
  output?: string;
  extraArgs?: string[];
  platform?: string;
  compiler?: string;
  input: string;
  [platform: string]: unknown;
}

function getBatch(task: vscode.Task): string | undefined {
  const def = task.definition as unknown as TaskDefinitionLike;
  let batch = def.setupBatch;
  let platform: string = process.platform;
  if (platform === "win32") platform = "windows";
  if (platform === "darwin") platform = "osx";
  if (platform in def) {
    const platformSpecific = def[platform] as {
      env?: Record<string, string>;
      setupBatch?: string;
    };
    if (platformSpecific.setupBatch) batch = platformSpecific.setupBatch;
  }
  return batch;
}

class HBMK2Terminal implements vscode.Pseudoterminal {
  name: string;
  write: (data: string) => void;
  closeEvt: (exitCode?: number) => void;
  tasks: vscode.Task[];
  settingUp: boolean;
  env: NodeJS.ProcessEnv;
  batch?: string;
  unableToStart?: boolean;
  p?: cp.ChildProcessWithoutNullStreams;

  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();

  constructor(task: vscode.Task) {
    this.name = task.name;
    myTerminals[task.name] = this;
    this.write = () => {};
    this.closeEvt = () => {};
    this.tasks = [];
    this.settingUp = false;
    this.env = { ...process.env };
    const def = task.definition as unknown as TaskDefinitionLike;
    if (def.options && def.options.env) {
      const extraEnv = def.options.env;
      for (const p in extraEnv) {
        if (Object.prototype.hasOwnProperty.call(extraEnv, p)) {
          this.env[p] = extraEnv[p];
        }
      }
    }
    let batch = getBatch(task);
    this.batch = batch;
    if (batch) {
      batch = ToAbsolute(batch);
      if (!batch) {
        this.unableToStart = true;
        return;
      }
      this.settingUp = true;
      let cmd = "setup";
      if (os.platform() === "win32") {
        cmd += ".bat";
        fs.writeFileSync(cmd, `call \"${batch}\"\r\nset\r\n`);
      } else {
        cmd = "./" + cmd + ".sh";
        fs.writeFileSync(cmd, `sh  \"${batch}\"\r\printenv\r\n`);
      }
      const tc = this;
      const env1: NodeJS.ProcessEnv = {};
      function onData(data: Buffer | string): void {
        const str = data.toString().split(/[\r\n]{1,2}/);
        for (let i = 0; i < str.length - 1; ++i) {
          const m = str[i].match(/([^=]+)=(.*)$/);
          if (m) {
            env1[m[1].toUpperCase()] = m[2];
          } else {
            tc.write(str[i] + "\r\n");
          }
        }
      }
      const p1 = cp.spawn(cmd, { env: process.env });
      p1.stdout.on("data", onData);
      p1.on("exit", () => {
        fs.unlink(cmd, () => {});
        tc.env = env1;
        tc.settingUp = false;
        tc.start();
      });
    }
  }

  onDidWrite(fn: (data: string) => void): vscode.Disposable {
    this.write = fn;
    return this.writeEmitter.event(fn);
  }
  onDidClose(fn: (exitCode: number | void) => void): vscode.Disposable {
    this.closeEvt = (code?: number) => fn(code as number | void);
    return this.closeEmitter.event(fn);
  }
  open(): void {
    this.start();
  }
  append(t: vscode.Task): void {
    this.tasks.push(t);
  }
  close(): void {
    if (this.p) this.p.kill();
    myTerminals[this.name] = undefined;
  }
  start(): void {
    if (this.unableToStart) {
      this.write(localize("harbour.task.HBMK2.errorBatch") + ".\r\n");
      this.closeEvt();
      return;
    }
    if (this.settingUp) {
      this.write(localize("harbour.task.HBMK2.setup") + "\r\n");
      return;
    }
    if (this.tasks.length === 0) {
      this.closeEvt(0);
      return;
    }
    const task = this.tasks.splice(0, 1)[0];
    const def = task.definition as unknown as TaskDefinitionLike;
    const inputFile =
      ToAbsolute(resolvePredefinedVariables(def.input)) || def.input;
    const section = vscode.workspace.getConfiguration("harbour");
    const warningLevel = section.get<number>("warningLevel", 1);
    const compilerExecutable = section.get<string>(
      "compilerExecutable",
      "harbour",
    );

    const args: string[] = [inputFile, "-w" + warningLevel];
    if (def.debugSymbols) {
      args.push("-b");
      args.push(
        path.resolve(__dirname, path.join("..", "extra", "dbg_lib.prg")),
      );
    }
    if (def.output) args.push("-o" + def.output);
    if (Array.isArray(def.extraArgs)) args.push(...def.extraArgs);
    if (def.platform) args.push("-plat=" + def.platform);
    if (def.compiler) args.push("-comp=" + def.compiler);
    const file_cwd = path.dirname(inputFile);
    const hbmk2Path = path.join(path.dirname(compilerExecutable), "hbmk2");
    this.write(localize("harbour.task.HBMK2.start") + "\r\n");
    this.p = cp.spawn(hbmk2Path, args, { cwd: file_cwd, env: this.env });
    const tc = this;
    this.p.stderr.on("data", (data: Buffer | string) =>
      tc.write(data.toString()),
    );
    this.p.stdout.on("data", (data: Buffer | string) =>
      tc.write(data.toString()),
    );
    this.p.on("close", (r) => {
      tc.p = undefined;
      tc.closeEvt(r ?? undefined);
    });
    this.p.on("error", () => {
      tc.p = undefined;
      tc.closeEvt(-1);
    });
  }
}

export class HBMK2Task implements vscode.TaskProvider {
  getValidTask(
    name: string,
    input: string,
    definition: vscode.TaskDefinition,
    problemMatches?: unknown[],
  ): vscode.Task {
    const retTask = new vscode.Task(
      { type: "HBMK2", input: input },
      vscode.TaskScope.Workspace,
      name,
      "HBMK2",
    );
    retTask.definition = definition;
    retTask.execution = new vscode.CustomExecution(async () =>
      getTerminalFn(retTask)(),
    );
    if (!Array.isArray(problemMatches) || problemMatches.length === 0)
      retTask.problemMatchers = ["$harbour", "$msCompile"];
    return retTask;
  }

  provideTasks(
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Task[]> {
    if (
      !vscode.workspace.workspaceFolders ||
      vscode.workspace.workspaceFolders.length === 0
    )
      return [];
    return new Promise<vscode.Task[]>((resolve, reject) => {
      const retValue: vscode.Task[] = [];
      let textDocument: vscode.TextDocument | undefined;
      if (
        vscode &&
        vscode.window &&
        vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document
      )
        textDocument = vscode.window.activeTextEditor.document;
      if (textDocument && textDocument.languageId === "harbour") {
        const task = new vscode.Task(
          { type: "HBMK2", input: "${file}" },
          vscode.TaskScope.Workspace,
          localize("harbour.task.HBMK2.provideName2"),
          "HBMK2",
        );
        task.execution = new vscode.CustomExecution(async () =>
          getTerminalFn(task)(),
        );
        task.problemMatchers = ["$harbour", "$msCompile"];
        const task2 = new vscode.Task(
          {
            type: "HBMK2",
            input: "${file}",
            debugSymbols: true,
            output: "${fileBasenameNoExtension}_dbg",
          },
          vscode.TaskScope.Workspace,
          localize("harbour.task.HBMK2.provideName3"),
          "HBMK2",
        );
        task2.execution = new vscode.CustomExecution(async () =>
          getTerminalFn(task2)(),
        );
        task2.problemMatchers = ["$harbour", "$msCompile"];
        retValue.push(task, task2);
      }
      getAllWorkspaceFiles(token).then((values) => {
        if (token.isCancellationRequested) {
          reject(token);
          return;
        }
        for (let j = 0; j < values.length; j++) {
          const ff = values[j];
          for (let i = 0; i < ff.length; ++i) {
            if (!ff[i].isFile()) continue;
            const ext = path.extname(ff[i].name).toLowerCase();
            if (ext === ".hbp") {
              const task = new vscode.Task(
                { type: "HBMK2", input: ff[i].name },
                vscode.TaskScope.Workspace,
                localize(
                  "harbour.task.HBMK2.provideName",
                  path.basename(ff[i].name),
                ),
                "HBMK2",
              );
              task.execution = new vscode.CustomExecution(async () =>
                getTerminalFn(task)(),
              );
              task.problemMatchers = ["$harbour", "$msCompile"];
              retValue.push(task);
            }
          }
        }
        resolve(retValue);
      });
    });
  }

  resolveTask(task: vscode.Task): vscode.Task {
    const def = task.definition as unknown as { input: string };
    const retTask = new vscode.Task(
      task.definition,
      vscode.TaskScope.Workspace,
      "build " + def.input,
      "HBMK2",
    );
    retTask.execution = new vscode.CustomExecution(async () =>
      getTerminalFn(retTask)(),
    );
    if (
      !Array.isArray(task.problemMatchers) ||
      task.problemMatchers.length === 0
    )
      retTask.problemMatchers = ["$harbour", "$msCompile"];
    else retTask.problemMatchers = task.problemMatchers;
    return retTask;
  }
}

export function activate(): void {
  vscode.tasks.registerTaskProvider("Harbour", new HRBTask());
  vscode.tasks.registerTaskProvider("HBMK2", new HBMK2Task());
}
