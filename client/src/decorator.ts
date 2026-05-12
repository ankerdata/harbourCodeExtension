import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

interface GroupRange {
  line: number;
  startCol: number;
  endCol: number;
}

let decoration: vscode.TextEditorDecorationType;
let client: LanguageClient;

export function activate(
  context: vscode.ExtensionContext,
  _client: LanguageClient,
): void {
  client = _client;
  decoration = vscode.window.createTextEditorDecorationType({
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: new vscode.ThemeColor("editorBracketMatch.border"),
    backgroundColor: new vscode.ThemeColor("editorBracketMatch.background"),
  });
  vscode.window.onDidChangeTextEditorSelection((e) => showGroups(e));
}

function showGroups(evt: vscode.TextEditorSelectionChangeEvent): void {
  const section = vscode.workspace.getConfiguration("harbour");
  if (!section.get<boolean>("decorator")) return;

  const editor = evt.textEditor;
  if (!editor || !editor.document) return;
  if (editor.document.languageId !== "harbour") return;
  if (evt.selections.length !== 1) {
    evt.textEditor.setDecorations(decoration, []);
    return;
  }
  const sel = evt.selections[0];
  client
    .sendRequest<GroupRange[]>("harbour/groupAtPosition", {
      textDocument: { uri: editor.document.uri.toString() },
      sel: sel,
    })
    .then((ranges) => {
      const places: vscode.DecorationOptions[] = [];
      for (let k = 0; k < ranges.length; k++) {
        const rr = ranges[k];
        places.push({
          range: new vscode.Range(rr.line, rr.startCol, rr.line, rr.endCol),
        });
      }
      evt.textEditor.setDecorations(decoration, places);
    });
}
