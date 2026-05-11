import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as readline from "readline";
import { localize } from "./myLocalize";

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext): void {
    diagnosticCollection = vscode.languages.createDiagnosticCollection("harbour");
    context.subscriptions.push(diagnosticCollection);

    vscode.workspace.onDidOpenTextDocument(validate, undefined, context.subscriptions);
    vscode.workspace.onDidSaveTextDocument(validate, undefined, context.subscriptions);
    vscode.workspace.onDidCloseTextDocument(removeValidation, undefined, context.subscriptions);
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
        validate(vscode.window.activeTextEditor.document);
    }
}

export function deactivate(): void {
    diagnosticCollection.dispose();
}

const valRegEx = /^\r?(?:([^\(]*)\((\d+)\)\s+)?(Warning|Error)\s+([^\r\n]*)/;
const lineContRegEx = /;(\s*(\/\/|&&|\/\*))?/;

function validate(textDocument: vscode.TextDocument): void {
    if (textDocument.languageId !== "harbour") return;
    const section = vscode.workspace.getConfiguration("harbour");
    if (!section.get<boolean>("validating")) return;
    const warningLevel = section.get<number>("warningLevel", 1);
    const args: string[] = [
        "-s",
        "-q0",
        "-m",
        "-n0",
        "-w" + warningLevel,
        textDocument.fileName,
    ];
    const file_cwd = path.dirname(textDocument.fileName);
    const extraIncludePaths = section.get<string[]>("extraIncludePaths", []);
    for (let i = 0; i < extraIncludePaths.length; i++) {
        let pathVal = extraIncludePaths[i];
        if (pathVal.indexOf("${workspaceFolder}") >= 0) {
            pathVal = pathVal.replace("${workspaceFolder}", file_cwd);
        }
        args.push("-I" + pathVal);
    }
    const extraOptions = section.get<string>("extraOptions", "");
    args.push(
        ...extraOptions.split(" ").filter((el) => el.length !== 0 || el === "-ge1")
    );
    const diagnostics: Record<string, vscode.Diagnostic[]> = {};
    diagnostics[textDocument.fileName] = [];
    const doneSubjects: Record<number, string[]> = {};
    function parseLine(subLine: string): void {
        const r = valRegEx.exec(subLine);
        if (!r) return;
        if (!r[1]) r[1] = "";
        let lineNr = r[2] ? parseInt(r[2]) - 1 : 0;
        const subject = r[4].match(/'([^']+)'/g);
        if (subject && subject.length > 1 && subject[1].indexOf("(") >= 0) {
            const nSub = subject[1].match(/\(([0-9]+)\)/);
            if (nSub) {
                lineNr = parseInt(nSub[1]) - 1;
            }
        }
        if (subject && subject.length > 0) {
            if (lineNr in doneSubjects && doneSubjects[lineNr].indexOf(subject[0]) >= 0)
                return;
            if (!(lineNr in doneSubjects)) doneSubjects[lineNr] = [];
            doneSubjects[lineNr].push(subject[0]);
        }
        let line = textDocument.lineAt(lineNr);
        if (!(r[1] in diagnostics)) diagnostics[r[1]] = [];
        let putAll = true;
        if (subject) {
            let m: RegExpExecArray | null;
            subject[0] = subject[0].substring(1, subject[0].length - 1);
            const rr = new RegExp(
                "\\b" +
                    subject[0].replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") +
                    "\\b",
                "ig"
            );
            let testLine = line;
            do {
                while ((m = rr.exec(testLine.text))) {
                    putAll = false;
                    const diag = new vscode.Diagnostic(
                        new vscode.Range(lineNr, m.index, lineNr, m.index + subject[0].length),
                        r[4],
                        r[3] === "Warning"
                            ? vscode.DiagnosticSeverity.Warning
                            : vscode.DiagnosticSeverity.Error
                    );
                    if (r[4].indexOf("not used") > 0) {
                        diag.tags = [vscode.DiagnosticTag.Unnecessary];
                    }
                    diagnostics[r[1]].push(diag);
                }
                if (lineNr === 0) break;
                testLine = textDocument.lineAt(--lineNr);
            } while (lineContRegEx.test(testLine.text));
        }
        if (putAll) {
            diagnostics[r[1]].push(
                new vscode.Diagnostic(
                    line.range,
                    r[4],
                    r[3] === "Warning" ? 1 : 0
                )
            );
        }
    }
    const compilerExecutable = section.get<string>("compilerExecutable", "harbour");
    const child = cp.spawn(compilerExecutable, args, { cwd: file_cwd });
    child.on("error", () => {
        vscode.window.showWarningMessage(
            localize("harbour.validation.NoExe", compilerExecutable)
        );
    });
    const reader = readline.createInterface({ input: child.stderr });
    reader.on("line", (d) => parseLine(d));
    child.on("exit", () => {
        for (const file in diagnostics) {
            if (Object.prototype.hasOwnProperty.call(diagnostics, file)) {
                const infos = diagnostics[file];
                diagnosticCollection.set(vscode.Uri.file(file), infos);
            }
        }
    });
}

function removeValidation(textDocument: vscode.TextDocument): void {
    diagnosticCollection.delete(textDocument.uri);
}
