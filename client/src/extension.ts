import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

import * as validation from "./validation";
import * as decorator from "./decorator";
import * as docCreator from "./docCreator";
import * as taskProvider from "./taskProvider";
import * as formatEditor from "./formatEditor";
import * as debugProvider from "./debugProvider";

// On some hosts (notably VS Code on win32-arm64) the default `runtime: node`
// declared in the `debuggers` contribution silently fails to resolve `node`
// from the spawn environment, so F5 produces no visible result. Returning
// `process.execPath` (the Code.exe binary, which Electron runs in node mode
// for this entrypoint) bypasses PATH lookup entirely. See bug #31.
class HarbourDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  constructor(private readonly extensionPath: string) {}

  createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const program = path.join(this.extensionPath, "dist", "debugger.js");
    return new vscode.DebugAdapterExecutable(process.execPath, [program]);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  vscode.languages.setLanguageConfiguration("harbour", {
    indentationRules: {
      increaseIndentPattern:
        /^\s*((?:(?:static|init|exit)\s+)?(?:proc(?:e(?:d(?:u(?:r(?:e)?)?)?)?)?|func(?:t(?:i(?:o(?:n)?)?)?)?)|class(?!\s*(?:var|data|method))|method|if|else(?:if)?|for|if|try|case|otherwise|(?:do\s+)?while|switch|begin)\b/i,
      decreaseIndentPattern: /^\s*(end\s*([a-z]*)?|next|else|elseif|return)\b/i,
    },
  });
  validation.activate(context);

  const serverModuleDbg = context.asAbsolutePath(path.join("..", "server"));
  const serverModule = context.asAbsolutePath("server");
  const debugOptions = { execArgv: ["--nolazy", "--inspect-brk=21780"] };
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModuleDbg,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: ["harbour"],
    synchronize: {
      configurationSection: ["harbour", "search", "editor"],
    },
  };
  const cl = new LanguageClient(
    "HarbourServer",
    "Harbour Server",
    serverOptions,
    clientOptions,
  );
  cl.registerProposedFeatures();
  cl.start();
  context.subscriptions.push(cl);

  debugProvider.activate(context);

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      "harbour-dbg",
      new HarbourDebugAdapterDescriptorFactory(context.extensionPath),
    ),
  );

  vscode.commands.registerCommand("harbour.getDbgCode", () => {
    getDbgCode(context);
  });
  vscode.commands.registerCommand("harbour.debugList", DebugList);
  vscode.commands.registerCommand("harbour.setupCodeFormat", () => {
    formatEditor.showEditor(context);
  });
  decorator.activate(context, cl);
  docCreator.activate(context, cl);
  taskProvider.activate();
}

interface DebugListArgs {
  port?: number;
  program?: string;
}

interface PickItem extends vscode.QuickPickItem {
  process: number;
}

function DebugList(args: DebugListArgs): Promise<string> {
  return new Promise<string>((resolve) => {
    const picks = vscode.window.createQuickPick<PickItem>();
    picks.placeholder = "select the process to attach with";
    picks.busy = true;
    picks.items = [];
    const port = args.port ? args.port : 6110;
    const server = net
      .createServer((socket) => {
        socket.on("data", (data) => {
          try {
            while (true) {
              const lines = data.toString().split("\r\n");
              if (lines.length < 2) break;
              const clPath = path
                .basename(lines[0], path.extname(lines[0]))
                .toLowerCase();
              const processId = parseInt(lines[1]);
              if (args.program && args.program.length > 0) {
                const exeTarget = path
                  .basename(args.program, path.extname(args.program))
                  .toLowerCase();
                if (clPath !== exeTarget) break;
              }
              if (!picks.items.find((v) => v.process === processId)) {
                picks.items = picks.items.concat([
                  { label: clPath + ":" + processId, process: processId },
                ]);
              }
              break;
            }
          } catch (_ex) {
            // ignore
          }
          socket.write("NO\r\n");
          socket.end();
        });
      })
      .listen(port);
    picks.onDidAccept(() => picks.hide());
    picks.onDidHide(() => {
      server.close();
      if (picks.selectedItems.length > 0) {
        resolve(picks.selectedItems[0].process.toString());
      } else resolve("");
    });
    picks.show();
  });
}

function getDbgCode(context: vscode.ExtensionContext): void {
  fs.readFile(
    path.join(context.extensionPath, "extra", "dbg_lib.prg"),
    (err, data) => {
      if (!err) {
        vscode.workspace
          .openTextDocument({ content: data.toString(), language: "harbour" })
          .then((doc) => {
            vscode.window.showTextDocument(doc);
          });
      }
    },
  );
}

export function deactivate(): void {
  validation.deactivate();
}
