import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(_context: vscode.ExtensionContext, _client: LanguageClient): void {
    client = _client;
    vscode.window.onDidChangeTextEditorSelection((e) => WriteDoc(e));
}

function WriteDoc(evt: vscode.TextEditorSelectionChangeEvent): void {
    if (evt.kind !== 1) return; // only keyboard
    const editor = evt.textEditor;
    if (!editor || !editor.document) return;
    if (editor.document.languageId !== "harbour") return;
    if (
        evt.selections.length > 1 ||
        evt.selections[0].start.line !== evt.selections[0].end.line ||
        evt.selections[0].start.character !== evt.selections[0].end.character
    )
        return;
    const destRange = new vscode.Range(
        evt.selections[0].start.line,
        0,
        evt.selections[0].start.line,
        100
    );
    const line = editor.document.getText(destRange);
    if (!line.startsWith("/* $DOC$")) return;
    const param: Record<string, unknown> = {
        textDocument: { uri: editor.document.uri.toString() },
        sel: destRange,
    };
    param["eol"] = editor.document.eol;
    client.sendRequest<string | undefined>("harbour/docSnippet", param).then((snippet) => {
        if (snippet) {
            evt.textEditor.insertSnippet(new vscode.SnippetString(snippet), destRange);
        }
    });
}
