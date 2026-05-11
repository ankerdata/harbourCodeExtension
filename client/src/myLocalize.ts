import * as fs from "fs";
import * as path from "path";
import * as nls from "vscode-nls";

const nlsLocalize = nls.loadMessageBundle();

interface NlsConfig {
    locale?: string;
}

let messages: Record<string, string> = {};
let messagesFall: Record<string, string> = {};

export function reInit(config: NlsConfig | string): void {
    const locale = typeof config === "object" && config !== null ? config.locale : undefined;
    const fallbackFile = path.resolve(__dirname, path.join("..", "package.nls.json"));
    try {
        const localeFile = path.resolve(__dirname, path.join("..", "package.nls." + locale + ".json"));
        messages = JSON.parse(fs.readFileSync(localeFile, "utf8"));
        messagesFall = JSON.parse(fs.readFileSync(fallbackFile, "utf8"));
    } catch (_error) {
        messages = JSON.parse(fs.readFileSync(fallbackFile, "utf8"));
        messagesFall = messages;
    }
}

function indexTrim(str: string, ch: string): string {
    let start = 0;
    let end = str.length;
    while (start < end && str[start] === ch) ++start;
    while (end > start && str[end - 1] === ch) --end;
    return start > 0 || end < str.length ? str.substring(start, end) : str;
}

export function localize(key: string, ...args: Array<string | number | boolean>): string {
    let resolvedKey = indexTrim(key, "%");
    if (resolvedKey in messages) {
        resolvedKey = messages[resolvedKey];
    } else if (resolvedKey in messagesFall) {
        resolvedKey = messagesFall[resolvedKey];
    } else {
        resolvedKey = "Error: '" + resolvedKey + "' not found";
    }
    return nlsLocalize(resolvedKey, resolvedKey, ...args);
}

function Init(): void {
    if (process.env.VSCODE_NLS_CONFIG) {
        reInit(JSON.parse(process.env.VSCODE_NLS_CONFIG) as NlsConfig);
    } else {
        reInit("");
    }
}

Init();
