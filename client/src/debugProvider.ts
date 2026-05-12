import * as vscode from "vscode";
import * as path from "path";
import { localize } from "./myLocalize";
import { getAllWorkspaceFiles } from "./utils";

class HarbourDBGProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(
    _folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    if (!token) return [];
    return getAllWorkspaceFiles(token).then((values) => {
      const retValue: vscode.DebugConfiguration[] = [
        {
          type: "harbour-dbg",
          request: "launch",
          name: "Launch currentFile",
          preLaunchTask: localize("harbour.task.HBMK2.provideName3"),
        },
      ];
      if (token.isCancellationRequested) return undefined;
      for (let j = 0; j < values.length; j++) {
        const ff = values[j];
        for (let i = 0; i < ff.length; ++i) {
          if (!ff[i].isFile()) continue;
          const ext = path.extname(ff[i].name).toLowerCase();
          if (ext === ".hbp") {
            retValue.push({
              type: "harbour-dbg",
              request: "launch",
              name: "Launch currentFile",
              preLaunchTask: localize(
                "harbour.task.HBMK2.provideName",
                path.basename(ff[i].name),
              ),
            });
          }
        }
      }
      return retValue;
    });
  }

  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!debugConfiguration || !debugConfiguration.type) {
      return {
        type: "harbour-dbg",
        request: "launch",
        name: "Launch currentFile",
        preLaunchTask: localize("harbour.task.HBMK2.provideName3"),
      };
    }
    return debugConfiguration;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "harbour-dbg",
      new HarbourDBGProvider(),
    ),
  );
}
