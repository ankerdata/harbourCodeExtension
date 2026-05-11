import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { localize } from "./myLocalize";

declare const v8debug: unknown;

function escapeHTML(html: string): string {
    html = html.replace(/&/g, "&amp;");
    html = html.replace(/</g, "&lt;");
    html = html.replace(/>/g, "&gt;");
    html = html.replace(/"/g, "&quot;");
    html = html.replace(/'/g, "&#039;");
    return html;
}

interface PackageProperty {
    type: string;
    description: string;
    enum?: string[];
}

type PackageProperties = Record<string, PackageProperty>;
type FormatterConfig = Record<string, Record<string, unknown>>;

export function showEditor(context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
        "harbourFmtEditor",
        localize("harbour.formatter.title"),
        vscode.ViewColumn.Active,
        {}
    );
    const pkg = JSON.parse(
        fs.readFileSync(path.join(context.extensionPath, "package.json"), "utf8")
    ) as { contributes: { configuration: { properties: PackageProperties } } };
    const properties = pkg.contributes.configuration.properties;
    const section = vscode.workspace
        .getConfiguration("harbour")
        .get<FormatterConfig>("formatter", {});

    const localResources = vscode.Uri.file(path.join(context.extensionPath, "formatter-settings"));
    const codiconsUri = vscode.Uri.joinPath(
        context.extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist"
    );
    panel.webview.options = {
        localResourceRoots: [localResources, codiconsUri],
        enableScripts: true,
    };
    const baseUri = panel.webview.asWebviewUri(localResources);
    const cspSource = panel.webview.cspSource;
    const debug = typeof v8debug === "object";
    let html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none';
        font-src ${cspSource};
        style-src ${cspSource};
        script-src ${cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cat Coding</title>
    <link href="${panel.webview.asWebviewUri(codiconsUri)}/codicon.css" rel="stylesheet" />
    <link href="${baseUri}/style.css" rel="stylesheet" />
    <script src="${baseUri}/jquery-3.6.0.slim${debug ? "" : ".min"}.js"></script>
    <script src="${baseUri}/code.js"></script>
    </head><body>`;

    for (const subZone in section) {
        const k0 = `harbour.formatter.${subZone}`;
        html += `<h1>${localize(k0)}</h1><div>`;
        for (const zone in section[subZone]) {
            const cnf = section[subZone][zone];
            const k = k0 + `.${zone}`;
            const cfg = properties[k];
            html += `<label>`;
            switch (cfg.type) {
                case "boolean":
                    html += `<input type="checkbox" id="${k}" class="config"`;
                    if (cnf) html += " checked ";
                    html += ">" + escapeHTML(localize(cfg.description));
                    break;
                case "string":
                    if (cfg.enum) {
                        html += `${escapeHTML(localize(cfg.description))}<br><select id="${k}" class="config">`;
                        for (let idx = 0; idx < cfg.enum.length; ++idx) {
                            let v: string = cfg.enum[idx];
                            if (v.startsWith("use")) {
                                v = localize("harbour.formatter.enum.value.use", v.substring(4));
                            } else {
                                v = localize("harbour.formatter.enum.value." + v);
                            }
                            html += `<option value="${cfg.enum[idx]}"`;
                            if (cnf === cfg.enum[idx]) html += " selected ";
                            html += `>${escapeHTML(v)}</option>`;
                        }
                        html += `</select>`;
                    } else {
                        html += `<input></input>`;
                    }
                    break;
                default:
                    break;
            }
            html += `</label>`;
        }
        html += "</div>";
    }
    html += `<div id="preview"></div>`;
    html += `</body></html>`;
    panel.webview.onDidReceiveMessage((m) => onEditorMessage(m));
    panel.webview.html = html;
}

interface EditorMessage {
    command: string;
    value: { formatter: FormatterConfig };
}

function onEditorMessage(m: EditorMessage): void {
    switch (m.command) {
        case "currConfig":
            updateConfig(m.value);
            break;
        default:
            break;
    }
}

function updateConfig(readedValue: { formatter: FormatterConfig }): void {
    const currValue = vscode.workspace.getConfiguration("harbour");
    const section = readedValue.formatter;
    for (const subZone in section) {
        const k0 = `formatter.${subZone}`;
        for (const zone in section[subZone]) {
            const k = k0 + `.${zone}`;
            const ins = currValue.inspect(k);
            const rv = section[subZone][zone];
            if (ins && rv === ins.defaultValue) {
                currValue.update(k, undefined);
            } else {
                currValue.update(k, rv);
            }
        }
    }
}
