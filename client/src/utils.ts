import * as vscode from "vscode";
import * as fs from "fs";

export function getAllWorkspaceFiles(
    token: vscode.CancellationToken
): Promise<fs.Dirent[][]> {
    const promises: Promise<fs.Dirent[]>[] = [];
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return Promise.resolve([]);
    for (let d = 0; d < folders.length; d++) {
        const thisDir = folders[d];
        const uri = vscode.Uri.parse(thisDir.uri.toString());
        if (uri.scheme !== "file") continue;
        const r = new Promise<fs.Dirent[]>((res, reject) => {
            if (token.isCancellationRequested) {
                reject(token);
                return;
            }
            fs.readdir(uri.fsPath, { withFileTypes: true }, (err, ff) => {
                if (token.isCancellationRequested) {
                    reject(token);
                    return;
                }
                if (err) {
                    reject(err);
                    return;
                }
                res(ff);
            });
        });
        promises.push(r);
    }
    return Promise.all(promises);
}
