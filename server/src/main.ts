import * as provider from "./provider";
import * as server from "vscode-languageserver/node";
import * as fs from "fs";
import * as path from "path";
import { URI as Uri } from "vscode-uri";
import * as trueCase from "true-case-path";
import * as server_textdocument from "vscode-languageserver-textdocument";
import { isHarbourGeneratedCFile } from "./workspaceScan";

interface FieldInfo {
  name: string;
  files: string[];
}

interface AggregatedDbInfo {
  name: string;
  fields: Record<string, FieldInfo>;
}

interface FoldingRangeRecord {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: string;
}

type Cancellation = { isCancellationRequested: boolean };

// Different LSP clients send file URIs in different forms — nvim sends
// `file:///C:/foo` (literal colon, uppercase drive), while our own
// `Uri.file(...).toString()` produces `file:///c%3A/foo`. Both refer to the
// same on-disk file, but used as raw keys they collide as separate entries
// in the `files` map and produce duplicate references / definitions.
// Canonicalize once at every entry point.
function canonicalUri(rawUri: string): string {
  const parsed = Uri.parse(rawUri);
  if (parsed.scheme !== "file") return parsed.toString();
  let fsPath = parsed.fsPath;
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(fsPath)) {
    fsPath = fsPath[0].toLowerCase() + fsPath.slice(1);
  }
  return Uri.file(fsPath).toString();
}

// vscode-languageclient (TransportKind.ipc) forks the server with a Node IPC
// channel; Neovim and other LSP clients spawn it over stdio.
const connection: server.Connection =
  typeof process.send === "function"
    ? server.createConnection(
        new server.IPCMessageReader(process),
        new server.IPCMessageWriter(process),
      )
    : server.createConnection(process.stdin, process.stdout);

let workspaceRoots: string[] = [];
let includeDirs: string[] = [];
let workspaceDepth: number | undefined;
let wordBasedSuggestions: boolean = true;
let files: Record<string, provider.Provider> = {};
let includes: Record<string, provider.Provider> = {};
/** the list of documentation harbour base functions */
let docs: provider.HarbourDocInfo[] = [];
/** the list of undocumented harbour base functions */
let missing: Array<[string, string]> = [];

let databases: Record<string, AggregatedDbInfo> = {};
let canLocationLink: boolean = false;
let lineFoldingOnly: boolean = true;
let currStyleConfig: any;

const keywords = provider.keywords;

/*
    every database contains a name (the text before the ->)
    and a list of field, objects with name (the text after the ->)
    and a files, array of string with the file where found the db.name->field.name
*/
connection.onInitialize((params) => {
  canLocationLink = false;
  if (params.capabilities.textDocument?.declaration?.linkSupport)
    canLocationLink = true;
  lineFoldingOnly = true;
  const foldingRange = params.capabilities.textDocument?.foldingRange;
  if (
    foldingRange &&
    "lineFoldingOnly" in foldingRange &&
    foldingRange.lineFoldingOnly !== undefined
  )
    lineFoldingOnly = foldingRange.lineFoldingOnly;

  if (
    params.capabilities.workspace?.workspaceFolders &&
    params.workspaceFolders
  ) {
    workspaceRoots = [];
    for (let i = 0; i < params.workspaceFolders.length; i++) {
      const wf = params.workspaceFolders[i];
      if (wf?.uri) workspaceRoots.push(wf.uri);
    }
  } else {
    const rootUri = params.rootUri;
    workspaceRoots = rootUri ? [rootUri] : []; //this deprecation is a false positive because it uses workspaceFolders right above here
    if (!workspaceRoots[0] && params.rootPath) {
      if (path.sep === "\\")
        //window
        workspaceRoots = [
          "file://" + encodeURI(params.rootPath.replace(/\\/g, "/")),
        ];
      else workspaceRoots = ["file://" + encodeURI(params.rootPath)];
    }
    if (!workspaceRoots[0]) workspaceRoots = [];
  }
  fs.readFile(path.join(__dirname, "hbdocs.json"), "utf8", (err, data) => {
    if (!err) docs = JSON.parse(data);
  });
  fs.readFile(path.join(__dirname, "hbdocs.missing"), "utf8", (err, data) => {
    if (!err) missing = JSON.parse(data);
  });
  return {
    capabilities: {
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      // declarationProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["("],
      },
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [">", "<", '"'],
      },
      // Tell the client that the server works in FULL text document sync mode
      textDocumentSync: 1,
      workspace: {
        supported: true,
      } as any,
      hoverProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [
            server.SemanticTokenTypes.variable,
            server.SemanticTokenTypes.parameter,
          ],
          tokenModifiers: [
            server.SemanticTokenModifiers.declaration,
            server.SemanticTokenModifiers.static,
          ],
        },
        full: true,
      },
      documentFormattingProvider: true,
    },
  };
});
connection.onInitialized(() => {
  // When no onDidChangeConfiguration is received (e.g. Neovim),
  // parse the workspace with a default depth so go-to-definition
  // and other cross-file features work immediately.
  if (workspaceDepth === undefined) {
    includeDirs = ["."];
    workspaceDepth = 3;
    parseWorkspace();
  }
});

connection.onDidChangeConfiguration((params) => {
  if (!params.settings) return;
  // const searchExclude = params.settings.search && params.settings.search.exclude;
  // minimatch
  if (params.settings.editor)
    wordBasedSuggestions = params.settings.editor.wordBasedSuggestions;
  if (params.settings.harbour && params.settings.harbour.formatter)
    currStyleConfig = params.settings.harbour.formatter;
  const oldDepth = workspaceDepth;
  if (params.settings.harbour && params.settings.harbour.extraIncludePaths) {
    includeDirs = params.settings.harbour.extraIncludePaths;
    includeDirs.splice(0, 0, ".");
  }
  if (
    params.settings.harbour &&
    params.settings.harbour.workspaceDepth !== undefined
  )
    workspaceDepth = params.settings.harbour.workspaceDepth;
  if (workspaceDepth !== oldDepth) parseWorkspace();
});

interface DirEntry {
  name: string;
  completePath: string;
  info: fs.Stats;
  pathParse: path.ParsedPath;
  prgFile: boolean;
  cFile: boolean;
}

function parseWorkspace(): void {
  let nOpenend = 0;
  const fileQueue: Array<[string, boolean]> = [];
  function appendFile(completePath: string, cMode: boolean): void {
    if (nOpenend < 1000) {
      const fileUri = canonicalUri(Uri.file(completePath).toString());
      const pp = new provider.Provider(true);
      nOpenend++;
      pp.parseFile(completePath, fileUri, cMode).then((prov) => {
        nOpenend--;
        UpdateFile(prov);
        if (fileQueue.length > 0) {
          const nextFile = fileQueue.pop()!;
          appendFile(nextFile[0], nextFile[1]);
        }
      });
    } else {
      fileQueue.push([completePath, cMode]);
    }
  }
  function parseDir(dir: string, depth: number, prgFiles?: string[]): void {
    if (!prgFiles) prgFiles = [];
    fs.readdir(dir, function (_err, ff) {
      if (ff === undefined) return;
      const files: DirEntry[] = new Array(ff.length);
      for (let i = 0; i < ff.length; i++) {
        const completePath = path.join(dir, ff[i]);
        const info = fs.statSync(completePath);
        const pathParse = path.parse(ff[i]);
        pathParse.ext = pathParse.ext.toLowerCase();
        let prgFile: boolean;
        let cFile: boolean;
        if (info.isFile()) {
          prgFile = pathParse.ext === ".prg" || pathParse.ext === ".ch";
          cFile =
            !prgFile &&
            (pathParse.ext.startsWith(".c") || pathParse.ext === ".h");
        } else {
          cFile = false;
          prgFile = false;
        }
        files[i] = {
          name: ff[i],
          completePath,
          info,
          pathParse,
          prgFile,
          cFile,
        };
      }
      // 1st cycle: parse all harbour file
      for (let i = 0; i < files.length; i++) {
        const dest = files[i];
        if (dest.prgFile) {
          prgFiles!.push(dest.completePath);
          appendFile(dest.completePath, false);
        }
      }
      // 2nd cycle: parse companion C/H files, but skip the .c
      // output emitted by the Harbour→C compiler. Generated
      // artefacts contain `HB_FUNC( NAME )` p-code shims that
      // duplicate the .prg PROCEDURE/FUNCTION definitions and
      // would otherwise shadow them in go-to-definition / hover.
      // Hand-written companion C and `#pragma BEGINDUMP` blocks
      // remain indexable.
      for (let i = 0; i < files.length; i++) {
        const dest = files[i];
        if (
          dest.cFile &&
          prgFiles!.findIndex((v) => v.indexOf(dest.pathParse.name) >= 0) >= 0
        ) {
          if (isHarbourGeneratedCFile(dest.completePath)) continue;
          appendFile(dest.completePath, true);
        }
      }
      if (depth > 0) {
        // 3rd cycle: parse all sub dir
        for (let i = 0; i < files.length; i++) {
          const dest = files[i];
          if (dest.info.isDirectory()) {
            parseDir(dest.completePath, depth - 1, prgFiles);
          }
        }
      }
    });
  }
  databases = {};
  files = {};
  includes = {};
  for (let i = 0; i < workspaceRoots.length; i++) {
    // other scheme of uri unsupported
    if (workspaceRoots[i] == null) continue;
    const uri = Uri.parse(workspaceRoots[i]);
    if (uri.scheme !== "file") continue;
    parseDir(uri.fsPath, workspaceDepth ?? 0);
  }
}

/**
 * Update a file in the workspace
 */
function UpdateFile(pp: provider.Provider): void {
  const doc = pp.currentDocument;
  const ext = path.extname(pp.currentDocument).toLowerCase();
  if (ext !== ".prg") {
    files[doc] = pp;
    return;
  }
  if (doc in files)
    for (const db in databases) {
      for (const f in databases[db].fields) {
        const idx = databases[db].fields[f].files.indexOf(doc);
        if (idx >= 0) {
          databases[db].fields[f].files.splice(idx, 1);
          if (databases[db].fields[f].files.length === 0) {
            delete databases[db].fields[f];
          }
        }
      }
      if (Object.keys(databases[db].fields).length === 0) {
        delete databases[db];
      }
    }
  files[doc] = pp;
  for (const db in pp.databases) {
    const ppDB = pp.databases[db];
    if (!(db in databases)) databases[db] = { name: ppDB.name, fields: {} };
    const gbDB = databases[db];
    for (const f in ppDB.fields) {
      if (!(f in gbDB.fields))
        gbDB.fields[f] = { name: ppDB.fields[f], files: [doc] };
      else {
        const idx = gbDB.fields[f].files.indexOf(doc);
        if (idx < 0) gbDB.fields[f].files.push(doc);
      }
    }
  }
  AddIncludes(path.dirname(doc), pp.includes);
}

function AddIncludes(startPath: string, includesArray: string[]): void {
  if (includesArray.length === 0) return;
  if (startPath.startsWith("file:///")) startPath = Uri.parse(startPath).fsPath;
  function FindInclude(dir: string, fileName: string): boolean {
    if (startPath && !path.isAbsolute(dir)) dir = path.join(startPath, dir);
    if (!fs.existsSync(dir)) return false;
    if (fileName.length < 1) return false;
    const completePath = path.join(dir, fileName);
    if (!fs.existsSync(completePath)) return false;
    const info = fs.statSync(completePath);
    if (!info.isFile()) return false;
    let fileUri = Uri.file(completePath);
    try {
      fileUri = Uri.file(trueCase.trueCasePathSync(completePath));
    } catch (ex) {
      /* keep original */
    }
    const canonicalFileUri = canonicalUri(fileUri.toString());
    const pp = new provider.Provider(true);
    includes[fileName] = pp;
    pp.parseFile(completePath, canonicalFileUri, false).then((prov) => {
      includes[fileName] = prov;
      AddIncludes(dir, prov.includes);
    });
    return true;
  }
  for (let j = 0; j < includesArray.length; j++) {
    const inc = includesArray[j];
    if (inc in includes) continue;
    let found = false;
    for (let i = 0; i < workspaceRoots.length; i++) {
      // other scheme of uri unsupported
      const uri = Uri.parse(workspaceRoots[i]);
      if (uri.scheme !== "file") continue;
      found = FindInclude(uri.fsPath, inc);
      if (found) break;
    }
    if (found) continue;
    for (let i = 0; i < includeDirs.length; i++) {
      found = FindInclude(includeDirs[i], inc);
      if (found) break;
    }
  }
}

function ParseInclude(
  startPath: string,
  includeName: string,
  addGlobal: boolean,
): provider.Provider | undefined {
  if (includeName.length === 0) return undefined;
  if (includeName in includes) return includes[includeName];
  function FindInclude(dir: string): provider.Provider | undefined {
    if (startPath && !path.isAbsolute(dir)) dir = path.join(startPath, dir);
    if (!fs.existsSync(dir)) return undefined;
    const test = path.join(dir, includeName);
    if (!fs.existsSync(test)) return undefined;
    const info = fs.statSync(test);
    if (!info.isFile()) return undefined;
    const pp = new provider.Provider();
    pp.parseString(
      fs.readFileSync(test).toString(),
      canonicalUri(Uri.file(test).toString()),
    );
    if (addGlobal) includes[includeName] = pp;
    return pp;
  }
  for (let i = 0; i < workspaceRoots.length; i++) {
    // other scheme of uri unsupported
    const uri = Uri.parse(workspaceRoots[i]);
    if (uri.scheme !== "file") continue;
    const r = FindInclude(uri.fsPath);
    if (r) return r;
  }
  for (let i = 0; i < includeDirs.length; i++) {
    const r = FindInclude(includeDirs[i]);
    if (r) return r;
  }
  return undefined;
}

function kindToVS(
  kind: string,
  sk?: boolean,
): server.SymbolKind | server.CompletionItemKind {
  if (sk === undefined) sk = true;
  switch (kind) {
    case "class":
      return sk ? server.SymbolKind.Class : server.CompletionItemKind.Class;
    case "method":
      return sk ? server.SymbolKind.Method : server.CompletionItemKind.Method;
    case "data":
      return sk
        ? server.SymbolKind.Property
        : server.CompletionItemKind.Property;
    case "function*":
    case "procedure*":
      return sk
        ? server.SymbolKind.Interface
        : server.CompletionItemKind.Interface;
    case "function":
    case "procedure":
    case "C-FUNC":
      return sk
        ? server.SymbolKind.Function
        : server.CompletionItemKind.Function;
    case "local":
    case "static":
    case "public":
    case "private":
    case "param":
    case "memvar":
      return sk
        ? server.SymbolKind.Variable
        : server.CompletionItemKind.Variable;
    case "field":
      return sk ? server.SymbolKind.Field : server.CompletionItemKind.Field;
    case "define":
      return sk
        ? server.SymbolKind.Constant
        : server.CompletionItemKind.Constant;
  }
  return 0 as server.SymbolKind;
}

connection.onDocumentSymbol((param) => {
  const doc = documents.get(param.textDocument.uri);
  if (!doc) return [];
  const p = getDocumentProvider(doc);
  const dest: server.DocumentSymbol[] = [];
  for (let fn = 0; fn < p.funcList.length; fn++) {
    const info = p.funcList[fn];
    if (info.kind === "field") continue;
    if (info.kind === "memvar") continue;
    if (typeof info.endLine !== "number") continue;
    const selRange = server.Range.create(
      info.startLine,
      info.startCol,
      info.endLine,
      info.endCol,
    );
    if (info.endLine !== info.startLine)
      selRange.end = server.Position.create(info.startLine, 1e8);
    const docSym = server.DocumentSymbol.create(
      info.name,
      info.comment && info.comment.length > 0
        ? info.comment.replace(/[\r\n]+/g, " ")
        : "",
      kindToVS(info.kind) as server.SymbolKind,
      server.Range.create(
        info.startLine,
        info.startCol,
        info.endLine,
        info.endCol,
      ),
      selRange,
      undefined,
    );
    let parent: server.DocumentSymbol[] = dest;
    if (
      info.parent &&
      info.parent.endLine !== undefined &&
      info.startLine <= info.parent.endLine
    ) {
      let pp: provider.Info | undefined = info.parent;
      const names: string[] = [];
      while (pp) {
        if (
          pp.kind === "method" &&
          pp.foundLike === "definition" &&
          (!pp.parent ||
            (pp.parent.endLine !== undefined &&
              pp.startLine > pp.parent.endLine))
        ) {
          if (pp.parent) names.push(pp.parent.name + ":" + pp.name);
          else if (pp.parentName) names.push(pp.parentName + "???:" + pp.name);
          else names.push("???:" + pp.name);
          break;
        } else names.push(pp.name);
        pp = pp.parent;
      }
      while (names.length > 0) {
        const n = names.pop();
        const i = parent.findIndex((v) => v.name === n);
        if (i >= 0) {
          const target = parent[i];
          if (!target.children) target.children = [];
          parent = target.children;
        }
      }
    } else if (info.kind === "method") {
      if (info.parent) docSym.name = info.parent.name + ":" + info.name;
      else if (info.parentName)
        docSym.name = info.parentName + "???:" + info.name;
      else docSym.name = "???:" + info.name;
    }
    parent.push(docSym);
  }
  return dest;
});

/**
 * Checks if word1 is contained on word2, return a string with word1 filled with Z where it is not present on word2
 * @example IsInside('a',"ciao") -> ZZa
 * @example IsInside('ab',"ciao belli") -> ZZaZZb
 * @example IsInside('ab',"ciao") -> undefined
 */
function IsInside(word1: string, word2: string): string | undefined {
  if (word1.length === 0) return "";
  let ret = "";
  let i1 = 0;
  let lenMatch = 0,
    maxLenMatch = 0,
    minLenMatch = word1.length;
  for (let i2 = 0; i2 < word2.length; i2++) {
    if (word1[i1] === word2[i2]) {
      lenMatch++;
      if (lenMatch > maxLenMatch) maxLenMatch = lenMatch;
      ret += word1[i1];
      i1++;
      if (i1 === word1.length) {
        return ret;
      }
    } else {
      ret += "Z";
      if (lenMatch > 0 && lenMatch < minLenMatch) minLenMatch = lenMatch;
      lenMatch = 0;
    }
  }
  return undefined;
}

connection.onWorkspaceSymbol((param) => {
  const dest: server.SymbolInformation[] = [];
  let src = param.query.toLowerCase();
  let parent: string | undefined = undefined;
  const colon = src.indexOf(":");
  if (colon > 0) {
    parent = src.substring(0, colon);
    if (parent.endsWith("()")) parent = parent.substring(0, parent.length - 2);
    src = src.substring(colon + 1);
  }
  for (const file in files) {
    const pp = files[file];
    for (let fn = 0; fn < pp.funcList.length; fn++) {
      const info = pp.funcList[fn];
      if (
        info.kind !== "class" &&
        info.kind !== "method" &&
        info.kind !== "data" &&
        info.kind !== "public" &&
        info.kind !== "define" &&
        !info.kind.startsWith("procedure") &&
        !info.kind.startsWith("function")
      )
        continue;
      // workspace symbols takes statics too
      if (src.length > 0 && !IsInside(src, info.nameCmp)) continue;
      // public has parent, but they are visible everywhere
      if (
        parent &&
        info.kind !== "public" &&
        (!info.parent || !IsInside(parent, info.parent.nameCmp))
      )
        continue;
      dest.push(
        server.SymbolInformation.create(
          info.name,
          kindToVS(info.kind) as server.SymbolKind,
          server.Range.create(
            info.startLine,
            info.startCol,
            info.endLine ?? info.startLine,
            info.endCol,
          ),
          file,
          info.parent ? info.parent.name : "",
        ),
      );
      if (dest.length === 100) return dest;
    }
  }
  return dest;
});

type GetWordResult = string | [string, string, number] | [];

function GetWord(
  params: server.TextDocumentPositionParams,
  withPrev?: boolean,
): GetWordResult {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const pos = doc.offsetAt(params.position);
  let delta = 20;
  let word: RegExpExecArray | null = null;
  let prev: string | undefined;
  const r = /\b[a-z_][a-z0-9_]*\b/gi;
  while (true) {
    r.lastIndex = 0;
    const text = doc.getText(
      server.Range.create(
        doc.positionAt(Math.max(pos - delta, 0)),
        doc.positionAt(pos + delta),
      ),
    );
    const txtPos = pos < delta ? pos : delta;
    word = null;
    let candidate: RegExpExecArray | null;
    while ((candidate = r.exec(text))) {
      if (
        candidate.index <= txtPos &&
        candidate.index + candidate[0].length >= txtPos
      ) {
        word = candidate;
        break;
      }
    }
    if (!word) return [];
    if (word.index !== 0 && word.index + word[0].length !== delta + delta) {
      if (withPrev) {
        let idx = word.index - 1;
        prev = text[idx];
        while (idx >= 0 && (prev === " " || prev === "\t")) {
          prev = text[--idx];
        }
        let canBreak = prev !== " " && prev !== "\t";
        if (prev === ">") {
          canBreak = idx > 0;
          if (canBreak) prev = text[--idx] + prev; //can become ->
        }
        if (canBreak) break;
      } else {
        break;
      }
      // resolve text-edge cases by widening the window
      delta += 10;
      continue;
    }
    delta += 10;
  }
  const worldPos = pos - delta + word.index;
  const wordStr = word[0];
  return withPrev ? [wordStr, prev ?? "", worldPos] : wordStr;
}

connection.onDefinition(
  (params): server.Definition | server.LocationLink[] | undefined => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return undefined;
    const docUri = canonicalUri(doc.uri);
    const line = doc.getText(
      server.Range.create(params.position.line, 0, params.position.line, 100),
    );
    const include =
      /^\s*#(?:pragma\s+__(?:c|binary)?stream)?include\s+[<"]([^>"]*)/i.exec(
        line,
      );
    if (include !== null) {
      let startPath: string | undefined = undefined;
      if (
        params.textDocument.uri &&
        params.textDocument.uri.startsWith("file")
      ) {
        startPath = path.dirname(Uri.parse(params.textDocument.uri).fsPath);
      }
      const pos = include[0].indexOf(include[1]);
      const found = definitionFiles(
        include[1],
        startPath,
        server.Range.create(
          params.position.line,
          pos,
          params.position.line,
          pos + include[1].length,
        ),
      );
      return canLocationLink
        ? (found as server.LocationLink[])
        : (found as server.Location[]);
    }
    const wordRes = GetWord(params, true);
    if ((wordRes as string | unknown[]).length === 0) return undefined;
    const wordTuple = wordRes as [string, string, number];
    const dest: Array<server.Location | server.LocationLink> = [];
    let thisDone = false;
    const prev = wordTuple[1];
    let className: string | undefined;
    const pos = wordTuple[2];
    if (
      prev === ":" &&
      doc.getText(
        server.Range.create(
          doc.positionAt(Math.max(pos - 3, 0)),
          doc.positionAt(pos),
        ),
      ) === "():"
    ) {
      const tmp = params.position;
      const lookupParams: server.TextDocumentPositionParams = {
        textDocument: params.textDocument,
        position: doc.positionAt(Math.max(pos - 3, 0)),
      };
      const cn = GetWord(lookupParams);
      className = (typeof cn === "string" ? cn : "").toLowerCase();
      params.position = tmp;
      let found = false;
      for (const file in files) {
        if (file === docUri) thisDone = true;
        const pp = files[file];
        for (let fn = 0; fn < pp.funcList.length; fn++) {
          const info = pp.funcList[fn];
          if (info.kind !== "class") continue;
          if (info.nameCmp === className) {
            found = true;
            break;
          }
        }
      }
      if (!thisDone && !found) {
        const pThis = getDocumentProvider(doc);
        for (let fn = 0; fn < pThis.funcList.length; fn++) {
          const info = pThis.funcList[fn];
          if (info.kind !== "class") continue;
          if (info.nameCmp === className) {
            found = true;
            break;
          }
        }
      }
      if (!found) className = undefined;
    }

    const word = wordTuple[0].toLowerCase();
    function DoProvider(pp: provider.Provider, file: string): void {
      for (let fn = 0; fn < pp.funcList.length; fn++) {
        const info = pp.funcList[fn];
        if (info.foundLike !== "definition") continue;
        if (info.nameCmp !== word) continue;
        if (info.kind.endsWith("*") && file !== docUri) continue;
        if (info.kind === "static" && file !== docUri) continue;
        if (info.kind === "data" || info.kind === "method") {
          if (className && info.parent && className !== info.parent.nameCmp)
            continue;
        }
        if (info.kind === "local" || info.kind === "param") {
          if (file !== docUri) continue;
          const ppParent = info.parent;
          if (ppParent) {
            if (ppParent.startLine > params.position.line) continue;
            if (
              ppParent.endLine !== undefined &&
              ppParent.endLine < params.position.line
            )
              continue;
          }
        }
        dest.push(
          server.Location.create(
            file,
            server.Range.create(
              info.startLine,
              info.startCol,
              info.endLine ?? info.startLine,
              info.endCol,
            ),
          ),
        );
      }
    }
    for (const file in files) {
      if (file === docUri) thisDone = true;
      DoProvider(files[file], file);
    }
    let pThis: provider.Provider;
    if (!thisDone) {
      pThis = getDocumentProvider(doc);
      DoProvider(pThis, docUri);
    } else {
      pThis = files[docUri];
    }

    const incList = pThis.includes;
    let i = 0;
    const startDir = path.dirname(Uri.parse(docUri).fsPath);
    while (i < incList.length) {
      const pp = ParseInclude(startDir, incList[i], thisDone);
      if (pp) {
        DoProvider(pp, pp.currentDocument);
        for (let j = 0; j < pp.includes.length; j++) {
          if (incList.indexOf(pp.includes[j]) < 0) incList.push(pp.includes[j]);
        }
      }
      i++;
    }

    return canLocationLink
      ? (dest as server.LocationLink[])
      : (dest as server.Location[]);
  },
);

connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  let pos: number | undefined = doc.offsetAt(params.position) - 1;
  const text = doc.getText(); //here takes all text because the line can break with ;
  // backwards find (
  pos = findBracket(text, pos, -1, "(");
  if (pos === undefined) return undefined;
  // Get parameter position
  const endPos = doc.offsetAt(params.position);
  const nC = CountParameter(
    text.substring(pos + 1, endPos),
    doc.offsetAt(params.position) - pos - 1,
  );
  // Get the word
  pos--;
  const rge = /[0-9a-z_]/i;
  let word = "";
  let className: string | undefined = undefined;
  while (rge.test(text[pos])) {
    word = text[pos] + word;
    pos--;
  }
  word = word.toLowerCase();
  // special case for new, search the class name
  const prev = text.substring(pos - 2, pos + 1);
  if (prev === "():") // se è un metodo
  {
    pos -= 3;
    className = "";
    while (rge.test(text[pos])) {
      className = text[pos] + className;
      pos--;
    }
    className = className.toLowerCase();
  }
  let signatures: server.SignatureInformation[] = (
    [] as server.SignatureInformation[]
  ).concat(getWorkspaceSignatures(word, doc, className, nC));
  if (signatures.length === 0 && className !== undefined) {
    signatures = ([] as server.SignatureInformation[]).concat(
      getWorkspaceSignatures(word, doc, undefined, nC),
    );
  }
  signatures = signatures.concat(getStdHelp(word, nC));
  return { signatures, activeParameter: nC };
});

function findBracket(
  text: string,
  pos: number,
  dir: number,
  bracket: string,
): number | undefined {
  let nP = 0;
  let str: string | undefined;
  while (nP !== 0 || text[pos] !== bracket || str !== undefined) {
    if (pos < 0) return undefined;
    if (pos >= text.length) return undefined;
    if (str) {
      if (text[pos] === str) str = undefined;
    } else {
      switch (text[pos]) {
        case "(":
          nP--;
          break;
        case ")":
          nP++;
          break;
        case "[":
          if (dir > 0) str = "]";
          break;
        case "]":
          if (dir < 0) str = "[";
          break;
        case "{":
          if (dir > 0) str = "}";
          break;
        case "}":
          if (dir < 0) str = "{";
          break;
        case '"':
          str = '"';
          break;
        case "'":
          str = "'";
          break;
        case "\n": {
          let nSpace = 1;
          while (pos - nSpace > 0 && text[pos - nSpace] !== "\n") nSpace++;
          let thisLine = text.substring(pos - nSpace + 1, pos);
          thisLine = thisLine.replace(/\/\/[^\n]*\n/, "\n");
          thisLine = thisLine.replace(/&&[^\n]*\n/, "\n");
          thisLine = thisLine.replace(/\s+\n/, "\n");
          if (thisLine[thisLine.length - 2] === ";") break;
          return undefined;
        }
      }
    }
    pos += dir;
  }
  return pos;
}

function CountParameter(txt: string, position: number): number {
  let i = 0;
  while (true) {
    i++;
    let filter: RegExp | undefined = undefined;
    switch (i) {
      case 1:
        filter = /;\s*\r?\n/g;
        break; // new line with ;
      case 2:
        filter = /'[^']*'/g;
        break; // ' strings
      case 3:
        filter = /"[^"]*"/g;
        break; // " strings
      case 4:
        filter = /\[[^\[\]]*\]/g;
        break; // [] strings or array index
      case 5:
        filter = /{[^{}]*}/g;
        break; // {} array
      case 6:
        filter = /\([^\(\)]*\)/g;
        break; // couple of parenthesis
    }
    if (filter === undefined) break;
    let someChange: boolean;
    do {
      someChange = false;
      txt = txt.replace(filter, function (matchString) {
        someChange = true;
        return Array(matchString.length + 1).join("X");
      });
    } while (someChange);
  }
  return (txt.substring(0, position).match(/,/g) || []).length;
}

function getWorkspaceSignatures(
  word: string,
  doc: server_textdocument.TextDocument,
  className: string | undefined,
  nC: number,
): server.SignatureInformation[] {
  const docUri = canonicalUri(doc.uri);
  const signatures: server.SignatureInformation[] = [];
  let thisDone = false;
  function GetSignatureFromInfo(
    pp: provider.Provider,
    info: provider.Info,
    iSign: number,
  ): server.SignatureInformation | undefined {
    if (info.hDocIdx !== undefined)
      return GetHelpFromDoc(pp.harbourDocs[info.hDocIdx]);
    const s: server.SignatureInformation = { label: "", parameters: [] };
    if (info.kind.startsWith("method")) {
      if (info.parent) {
        s.label = info.parent.name + ":" + info.name;
        if (className && className !== info.parent.nameCmp) return undefined;
      } else {
        s.label = "??:" + info.name;
        if (className) return undefined;
      }
    } else {
      s.label = info.name;
    }
    s.label += "(";
    const subParams: server.ParameterInformation[] = [];
    for (let iParam = iSign + 1; iParam < pp.funcList.length; iParam++) {
      const subInfo = pp.funcList[iParam];
      if (subInfo.parent === info && subInfo.kind === "param") {
        const pInfo: server.ParameterInformation = { label: subInfo.name };
        if (subInfo.comment && subInfo.comment.trim().length > 0)
          pInfo.documentation = "<" + subInfo.name + "> " + subInfo.comment;
        subParams.push(pInfo);
        if (!s.label.endsWith("(")) s.label += ", ";
        s.label += subInfo.name;
      } else break;
    }
    s.label += ")";
    s.parameters = subParams;
    if (info.comment && info.comment.trim().length > 0)
      s.documentation = info.comment;
    return s;
  }
  for (const file in files) {
    if (file === docUri) thisDone = true;
    const pp = files[file];
    for (let iSign = 0; iSign < pp.funcList.length; iSign++) {
      const info = pp.funcList[iSign];
      if (
        !info.kind.startsWith("method") &&
        !info.kind.startsWith("procedure") &&
        !info.kind.startsWith("function")
      )
        continue;
      if (info.nameCmp !== word) continue;
      if (info.kind.endsWith("*") && file !== docUri) continue;
      const s = GetSignatureFromInfo(pp, info, iSign);
      if (s && s.parameters && s.parameters.length >= nC) signatures.push(s);
    }
  }
  if (!thisDone) {
    const pp = getDocumentProvider(doc);
    for (let iSign = 0; iSign < pp.funcList.length; iSign++) {
      const info = pp.funcList[iSign];
      if (
        !info.kind.startsWith("method") &&
        !info.kind.startsWith("procedure") &&
        !info.kind.startsWith("function")
      )
        continue;
      if (info.nameCmp !== word) continue;
      const s = GetSignatureFromInfo(pp, info, iSign);
      if (s && s.parameters && s.parameters.length >= nC) signatures.push(s);
    }
  }
  return signatures;
}

function GetHelpFromDoc(
  doc: provider.HarbourDocInfo,
): server.SignatureInformation {
  const s: server.SignatureInformation = {
    label: doc.label ?? "",
    parameters: [],
  };
  if (doc.documentation) s.documentation = doc.documentation;
  const subParams: server.ParameterInformation[] = [];
  if (doc.arguments) {
    for (let iParam = 0; iParam < doc.arguments.length; iParam++) {
      subParams.push({
        label: doc.arguments[iParam].label ?? "",
        documentation: doc.arguments[iParam].documentation,
      });
    }
  }
  s.parameters = subParams;
  return s;
}

function getStdHelp(word: string, _nC: number): server.SignatureInformation[] {
  const signatures: server.SignatureInformation[] = [];
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].name && docs[i].name!.toLowerCase() === word) {
      signatures.push(GetHelpFromDoc(docs[i]));
    }
  }
  return signatures;
}

const documents = new server.TextDocuments(server_textdocument.TextDocument);
documents.listen(connection);

documents.onDidChangeContent((e) => {
  const uri = Uri.parse(e.document.uri);
  if (uri.scheme !== "file") return;
  let found = false;
  for (let i = 0; i < workspaceRoots.length; i++)
    if (e.document.uri.startsWith(workspaceRoots[i])) found = true;
  if (!found) return; //not include file outside the current workspace
  const ext = path.extname(uri.fsPath).toLowerCase();
  const cMode = ext.startsWith(".c") && ext !== ".ch";
  if (ext === ".prg" || ext === ".ch" || cMode) {
    // Don't index Harbour→C compiler output even if the user
    // opened it explicitly: its `HB_FUNC( NAME )` shims would
    // shadow the .prg PROCEDURE/FUNCTION definitions in
    // go-to-definition and hover.
    if (cMode && isHarbourGeneratedCFile(uri.fsPath)) return;
    const docUri = canonicalUri(e.document.uri);
    let doGroups = false;
    if (docUri in files) doGroups = files[docUri].doGroups;
    const pp = parseDocument(e.document, (p) => {
      p.cMode = cMode;
      p.doGroups = doGroups;
    });
    UpdateFile(pp);
  }
});

function parseDocument(
  doc: server_textdocument.TextDocument,
  onInit?: (p: provider.Provider) => void,
): provider.Provider {
  const pp = new provider.Provider(false);
  pp.Clear();
  pp.currentDocument = canonicalUri(doc.uri);
  if (onInit !== undefined) onInit(pp);
  for (let i = 0; i < doc.lineCount; i++) {
    pp.parse(doc.getText(server.Range.create(i, 0, i, 1e8)));
  }
  pp.endParse();
  return pp;
}

let lastDocOutsideWorkspaceProvider: provider.Provider =
  new provider.Provider();
function getDocumentProvider(
  doc: server_textdocument.TextDocument,
  checkGroup?: boolean,
): provider.Provider {
  const docUri = canonicalUri(doc.uri);
  let pp: provider.Provider;
  if (docUri in files) {
    pp = files[docUri];
    if (checkGroup && !pp.doGroups)
      pp = files[docUri] = parseDocument(doc, (p) => (p.doGroups = true));
    return pp;
  }
  if (docUri in includes) {
    return includes[docUri];
  }
  if (docUri === lastDocOutsideWorkspaceProvider.currentDocument) {
    pp = lastDocOutsideWorkspaceProvider;
    if (checkGroup && !pp.doGroups)
      pp = lastDocOutsideWorkspaceProvider = parseDocument(
        doc,
        (p) => (p.doGroups = true),
      );
    return pp;
  }
  if (checkGroup)
    pp = lastDocOutsideWorkspaceProvider = parseDocument(
      doc,
      (p) => (p.doGroups = true),
    );
  else pp = lastDocOutsideWorkspaceProvider = parseDocument(doc);
  return pp;
}

connection.onCompletion((param, cancelled) => {
  const doc = documents.get(param.textDocument.uri);
  if (!doc) return server.CompletionList.create([], false);
  const docUri = canonicalUri(doc.uri);
  let line = doc.getText(
    server.Range.create(
      server.Position.create(param.position.line, 0),
      server.Position.create(param.position.line, 1e8),
    ),
  );
  if (
    param.context?.triggerKind ===
      server.CompletionTriggerKind.TriggerCharacter &&
    line[param.position.character - 1] !== param.context?.triggerCharacter
  ) {
    // sometime the triggerCharacter is not included on the line
    line =
      line.substring(0, param.position.character - 1) +
      param.context?.triggerCharacter +
      line.substring(param.position.character - 1);
  }
  const include =
    /^\s*#(pragma\s+__(?:c|binary)?stream)?include\s+[<"]([^>"]*)/i.exec(line);
  let prevLetter: string | undefined = "";
  if (param.position.character > 0)
    prevLetter = doc.getText(
      server.Range.create(
        server.Position.create(
          param.position.line,
          param.position.character - 1,
        ),
        param.position,
      ),
    );
  if (include !== null) {
    if (prevLetter === ">") {
      return server.CompletionList.create([], false); // wrong call
    }
    let startPath: string | undefined = undefined;
    if (param.textDocument.uri && param.textDocument.uri.startsWith("file")) {
      startPath = path.dirname(Uri.parse(param.textDocument.uri).fsPath);
    }
    const includePos = line.lastIndexOf(include[2]);
    return completionFiles(
      include[2],
      startPath,
      include[1] !== undefined,
      server.Range.create(
        server.Position.create(param.position.line, includePos),
        server.Position.create(
          param.position.line,
          includePos + include[2].length - 1,
        ),
      ),
    );
  }
  const completions: server.CompletionItem[] = [];
  let pos = param.position.character - 1;
  // Get the word
  const rge = /[0-9a-z_]/i;
  let word = "";
  while (pos >= 0 && rge.test(line[pos])) {
    word = line[pos] + word;
    pos--;
  }
  word = word.toLowerCase();
  let pp: provider.Provider | undefined = getDocumentProvider(doc);
  prevLetter = line[pos];
  if (prevLetter === ">") {
    if (pos > 0 && line[pos - 1] === "-") {
      prevLetter = "->";
      const dbCompletions = CompletionDBFields(word, line, pos, pp);
      for (const c of dbCompletions) completions.push(c);
      if (completions.length > 0)
        return server.CompletionList.create(completions, true); // put true because added all known field of this db
    }
  }
  const done: Record<string, boolean> = {};
  function CheckAdd(
    label: string,
    kind: server.CompletionItemKind,
    sort: string,
  ): server.CompletionItem | undefined {
    const ll = label.toLowerCase();
    if (ll in done) return undefined;
    done[ll] = true;
    const sortLabel = IsInside(word, ll);
    if (sortLabel === undefined) return undefined;
    const c = server.CompletionItem.create(label);
    c.kind = kind;
    c.sortText = sort + sortLabel;
    completions.push(c);
    return c;
  }
  if (prevLetter !== "->" && prevLetter !== ":") prevLetter = undefined;
  if (!prevLetter) {
    for (const dbName in databases) {
      CheckAdd(
        databases[dbName].name,
        server.CompletionItemKind.Struct,
        "AAAA",
      );
      if (cancelled.isCancellationRequested)
        return server.CompletionList.create(completions, false);
    }
    if (pp) {
      for (const dbName in pp.databases) {
        CheckAdd(
          pp.databases[dbName].name,
          server.CompletionItemKind.Struct,
          "AAAA",
        );
        if (cancelled.isCancellationRequested)
          return server.CompletionList.create(completions, false);
      }
    }
  }
  function GetCompletions(
    pp: provider.Provider,
    file: string,
  ): server.CompletionList | undefined {
    for (let iSign = 0; iSign < pp.funcList.length; iSign++) {
      const info = pp.funcList[iSign];
      if (word.length > 0 && !IsInside(word, info.nameCmp)) continue;
      if (
        info.endCol === param.position.character &&
        info.endLine === param.position.line &&
        file === docUri
      )
        continue;
      if (prevLetter === "->" && info.kind !== "field") continue;
      if (prevLetter !== "->" && info.kind === "field") continue;
      if (prevLetter === ":" && info.kind !== "method" && info.kind !== "data")
        continue;
      if (
        prevLetter !== ":" &&
        (info.kind === "method" || info.kind === "data")
      )
        continue;
      if (
        info.kind === "function*" ||
        info.kind === "procedure*" ||
        info.kind === "static"
      ) {
        if (file !== docUri) continue;
      }
      if (
        info.parent &&
        (info.parent.kind.startsWith("function") ||
          info.parent.kind.startsWith("procedure") ||
          info.parent.kind === "method")
      ) {
        if (file !== docUri) continue;
        if (
          param.position.line < info.parent.startLine ||
          (info.parent.endLine !== undefined &&
            param.position.line > info.parent.endLine)
        )
          continue;
      }
      const added = CheckAdd(
        info.name,
        kindToVS(info.kind, false) as server.CompletionItemKind,
        "AAA",
      );
      if (
        added &&
        (info.kind === "method" || info.kind === "data") &&
        info.parent
      )
        added.documentation = info.parent.name;
      if (cancelled.isCancellationRequested) return undefined;
    }
    return undefined;
  }
  for (const file in files) {
    GetCompletions(files[file], file);
    if (cancelled.isCancellationRequested)
      return server.CompletionList.create(completions, false);
  }
  if (pp) {
    GetCompletions(pp, docUri);
  } else if (docUri in files) {
    pp = files[docUri];
  }
  if (pp) {
    const thisDone = docUri in files;
    const incList = pp.includes;
    let i = 0;
    const startDir = path.dirname(Uri.parse(docUri).fsPath);
    while (i < incList.length) {
      const pInc = ParseInclude(startDir, incList[i], thisDone);
      if (pInc) {
        GetCompletions(pInc, pInc.currentDocument);
        for (let j = 0; j < pInc.includes.length; j++) {
          if (incList.indexOf(pInc.includes[j]) < 0)
            incList.push(pInc.includes[j]);
        }
      }
      i++;
      if (cancelled.isCancellationRequested)
        return server.CompletionList.create(completions, false);
    }
    if (wordBasedSuggestions) {
      for (const ref in pp.references) {
        if (Object.hasOwnProperty.call(pp.references, ref)) {
          const allRefs = pp.references[ref];
          const localDone: Record<string, boolean> = {};
          for (let i = 0; i < allRefs.length; i++) {
            const refObj = allRefs[i];
            if (refObj.howWrite in localDone) continue;
            localDone[refObj.howWrite] = true;
            CheckAdd(refObj.howWrite, server.CompletionItemKind.Text, "");
          }
        }
      }
    }
  }
  if (prevLetter !== ":" && prevLetter !== "->") {
    for (let i = 0; i < docs.length; i++) {
      if (!docs[i].name) continue;
      const c = CheckAdd(
        docs[i].name!,
        server.CompletionItemKind.Function,
        "AA",
      );
      if (c) c.documentation = docs[i].documentation;
      if (cancelled.isCancellationRequested)
        return server.CompletionList.create(completions, true);
    }
    for (let i = 1; i < keywords.length; i++) {
      CheckAdd(keywords[i], server.CompletionItemKind.Keyword, "AAA");
      if (cancelled.isCancellationRequested)
        return server.CompletionList.create(completions, true);
    }
    for (let i = 1; i < missing.length; i++) {
      const c = CheckAdd(
        missing[i][0],
        server.CompletionItemKind.Function,
        "A",
      );
      if (c) c.detail = missing[i][1];
      if (cancelled.isCancellationRequested)
        return server.CompletionList.create(completions, true);
    }
  }
  if (wordBasedSuggestions && !pp) {
    const wordRE = /\b[a-z_][a-z0-9_]*\b/gi;
    let foundWord: RegExpExecArray | null;
    const cursor = param.position.character;
    while ((foundWord = wordRE.exec(line))) {
      // remove current word
      if (
        foundWord.index < cursor &&
        foundWord.index + foundWord[0].length >= cursor
      )
        continue;
      CheckAdd(foundWord[0], server.CompletionItemKind.Text, "");
      if (cancelled.isCancellationRequested)
        return server.CompletionList.create(completions, true);
    }
  }
  return server.CompletionList.create(completions, false);
});

function completionFiles(
  word: string,
  startPath: string | undefined,
  allFiles: boolean,
  includeRange: server.Range,
): server.CompletionList {
  const completions: server.CompletionItem[] = [];
  let foundSlash: string = path.sep;
  word = word.replace("\r", "").replace("\n", "");
  let startDone = false;
  let deltaPath = "";
  const lastSlash = Math.max(word.lastIndexOf("\\"), word.lastIndexOf("/"));
  if (lastSlash > 0) {
    foundSlash = word.substring(lastSlash, lastSlash + 1);
    deltaPath = word.substring(0, lastSlash);
    word = word.substring(lastSlash + 1);
  }
  if (process.platform.startsWith("win")) {
    word = word.toLowerCase();
    if (startPath) startPath = startPath.toLowerCase();
  }
  const dirDone: string[] = [];
  function CheckDir(dir: string): void {
    if (startPath && !path.isAbsolute(dir)) dir = path.join(startPath, dir);
    dir = path.join(dir, deltaPath);
    if (process.platform.startsWith("win")) {
      if (dirDone.indexOf(dir.toLowerCase()) >= 0) return;
      dirDone.push(dir.toLowerCase());
    } else {
      if (dirDone.indexOf(dir) >= 0) return;
      dirDone.push(dir);
    }
    if (!fs.existsSync(dir)) return;

    if (startPath && dir.toLowerCase() === startPath) startDone = true;
    const ff = fs.readdirSync(dir);
    let subFiles: string[];
    const extRE = /\.c?h$/i;
    for (let fi = 0; fi < ff.length; fi++) {
      let fileName = ff[fi];
      if (process.platform.startsWith("win")) fileName = fileName.toLowerCase();
      const completePath = path.join(dir, ff[fi]);
      const info = fs.statSync(completePath);
      if (info.isDirectory()) {
        subFiles = fs.readdirSync(completePath);
        if (!allFiles && subFiles.findIndex((v) => extRE.test(v)) === -1)
          continue;
      } else if (!allFiles && !extRE.test(ff[fi])) continue;
      let sortText: string | undefined = undefined;
      if (word.length !== 0) {
        sortText = IsInside(word, fileName);
        if (!sortText) continue;
      }
      const result = path
        .join(deltaPath, ff[fi])
        .replace(new RegExp("\\" + path.sep, "g"), foundSlash);
      const c = server.CompletionItem.create(result);
      c.kind = info.isDirectory()
        ? server.CompletionItemKind.Folder
        : server.CompletionItemKind.File;
      c.sortText = sortText ? sortText : ff[fi];
      c.detail = dir;
      c.textEdit = server.TextEdit.replace(includeRange, result);
      completions.push(c);
    }
  }

  for (let i = 0; i < workspaceRoots.length; i++) {
    // other scheme of uri unsupported
    const uri = Uri.parse(workspaceRoots[i]);
    if (uri.scheme !== "file") continue;
    CheckDir(uri.fsPath);
  }
  for (let i = 0; i < includeDirs.length; i++) {
    CheckDir(includeDirs[i]);
  }
  if (startPath && !startDone) {
    CheckDir(startPath);
  }
  return server.CompletionList.create(completions, false);
}

function definitionFiles(
  fileName: string,
  startPath: string | undefined,
  origin: server.Range,
): Array<server.Location | server.LocationLink> {
  const dest: Array<server.Location | server.LocationLink> = [];
  fileName = fileName.toLowerCase();
  let startDone = false;
  if (startPath) startPath = startPath.toLowerCase();
  const emptyRange = server.Range.create(0, 0, 0, 0);
  function DefDir(dir: string): void {
    if (startPath && !path.isAbsolute(dir)) dir = path.join(startPath, dir);
    if (!fs.existsSync(dir)) return;
    if (startPath && dir.toLowerCase() === startPath) startDone = true;
    if (fs.existsSync(path.join(dir, fileName))) {
      let resolvedPath = path.join(dir, fileName);
      try {
        resolvedPath = trueCase.trueCasePathSync(resolvedPath);
      } catch (ex) {
        /* keep original */
      }
      const fileUri = Uri.file(resolvedPath).toString();
      if (canLocationLink)
        dest.push(
          server.LocationLink.create(fileUri, emptyRange, emptyRange, origin),
        );
      else dest.push(server.Location.create(fileUri, emptyRange));
    }
  }
  for (let i = 0; i < workspaceRoots.length; i++) {
    // other scheme of uri unsupported
    const uri = Uri.parse(workspaceRoots[i]);
    if (uri.scheme !== "file") continue;
    DefDir(uri.fsPath);
  }
  for (let i = 0; i < includeDirs.length; i++) {
    DefDir(includeDirs[i]);
  }
  if (startPath && !startDone) {
    DefDir(startPath);
  }
  return dest;
}

function CompletionDBFields(
  word: string,
  allText: string,
  pos: number,
  pp: provider.Provider | undefined,
): server.CompletionItem[] {
  let pdb = pos - 2;
  let dbName = "";
  let nBracket = 0;
  while ((allText[pdb] !== " " && allText[pdb] !== "\t") || nBracket > 0) {
    const c = allText[pdb];
    pdb--;
    if (c === ")") nBracket++;
    if (c === "(") nBracket--;
  }
  dbName = allText.substring(pdb + 1, pos - 1).replace(/\s+/g, "");
  const competitions: server.CompletionItem[] = [];
  function AddDB(db: provider.DbInfo | AggregatedDbInfo): void {
    for (const f in db.fields) {
      const rawName = db.fields[f];
      const name: string = typeof rawName === "string" ? rawName : rawName.name;
      let sortText: string | undefined = name;
      if (word.length > 0) {
        sortText = IsInside(word, f);
      }
      if (!sortText) continue;
      if (
        !competitions.find((v) => v.label.toLowerCase() === name.toLowerCase())
      ) {
        const c = server.CompletionItem.create(name);
        c.kind = server.CompletionItemKind.Field;
        c.documentation = db.name;
        c.sortText = "AAAA" + sortText;
        competitions.push(c);
      }
    }
  }
  function CheckDB(
    databasesRec: Record<string, provider.DbInfo | AggregatedDbInfo>,
  ): void {
    if (!(dbName in databasesRec)) {
      // check if pick too much text
      for (const db in databasesRec) {
        if (dbName.endsWith(db)) {
          dbName = db;
          break;
        }
      }
    }
    if (dbName in databasesRec) {
      AddDB(databasesRec[dbName]);
    }
  }
  dbName = dbName.toLowerCase().replace(" ", "").replace("\t", "");
  if (dbName.toLowerCase() === "field") {
    for (const db in databases) AddDB(databases[db]);
    if (pp) for (const db in pp.databases) AddDB(pp.databases[db]);
  } else {
    CheckDB(databases);
    if (pp && dbName in pp.databases) {
      CheckDB(pp.databases);
    }
  }
  return competitions;
}

connection.onHover((params, cancelled) => {
  const w = GetWord(params);
  const word: string = typeof w === "string" ? w : "";
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  const docUri = canonicalUri(doc.uri);
  const pp = getDocumentProvider(doc);
  if (word.length === 0) return undefined;
  const wLower = word.toLowerCase();

  // Search for #define macros first (current file, then includes)
  if (pp) {
    const result = pp.funcList.filter(
      (v) => v.kind === "define" && v.name === word,
    );
    if (result.length > 0) {
      return { contents: { language: "harbour", value: result[0].body ?? "" } };
    }
  }
  const thisDone = docUri in files;
  if (pp) {
    const incList = pp.includes.slice();
    let i = 0;
    const startDir = path.dirname(Uri.parse(docUri).fsPath);
    while (i < incList.length) {
      const pInc = ParseInclude(startDir, incList[i], thisDone);
      if (pInc) {
        const result = pInc.funcList.filter(
          (v) => v.kind === "define" && v.name === word,
        );
        if (result.length > 0) {
          return {
            contents: { language: "harbour", value: result[0].body ?? "" },
          };
        }
        for (let j = 0; j < pInc.includes.length; j++) {
          if (incList.indexOf(pInc.includes[j]) < 0)
            incList.push(pInc.includes[j]);
        }
      }
      i++;
      if (cancelled.isCancellationRequested) return undefined;
    }
  }

  // Build hover info for functions, procedures, methods, classes, and variables
  function buildHoverForInfo(
    info: provider.Info,
    pp: provider.Provider,
  ): server.Hover | undefined {
    let label = "";
    switch (info.kind) {
      case "function":
      case "function*":
        label = "FUNCTION " + info.name;
        break;
      case "procedure":
      case "procedure*":
        label = "PROCEDURE " + info.name;
        break;
      case "method":
        label = "METHOD " + info.name;
        if (info.parent) label += " CLASS " + info.parent.name;
        else if (info.parentName) label += " CLASS " + info.parentName;
        break;
      case "class":
        label = "CLASS " + info.name;
        break;
      case "data":
        label = "DATA " + info.name;
        if (info.parent) label += " (CLASS " + info.parent.name + ")";
        break;
      case "C-FUNC":
        label = "HB_FUNC(" + info.name + ")";
        break;
      case "local":
      case "static":
      case "public":
      case "private":
      case "memvar":
      case "param":
        label = info.kind.toUpperCase() + " " + info.name;
        if (info.parent) label += " (" + info.parent.name + ")";
        break;
      default:
        return undefined;
    }
    // Append parameter list for functions/procedures/methods
    if (
      info.kind.startsWith("function") ||
      info.kind.startsWith("procedure") ||
      info.kind === "method"
    ) {
      const idx = pp.funcList.indexOf(info);
      if (idx >= 0) {
        const params: string[] = [];
        for (let ip = idx + 1; ip < pp.funcList.length; ip++) {
          const sub = pp.funcList[ip];
          if (sub.parent === info && sub.kind === "param")
            params.push(sub.name);
          else break;
        }
        label += "(" + params.join(", ") + ")";
      }
    }
    // Check for $DOC$ documentation
    if (info.hDocIdx !== undefined) {
      const hDoc = pp.harbourDocs[info.hDocIdx];
      if (hDoc) {
        return {
          contents: {
            kind: "markdown",
            value:
              "```harbour\n" +
              label +
              "\n```" +
              (hDoc.documentation ? "\n\n" + hDoc.documentation : "") +
              (hDoc.return
                ? "\n\n**Returns:** " + (hDoc.return.help || hDoc.return.name)
                : ""),
          },
        };
      }
    }
    let contents = "```harbour\n" + label + "\n```";
    if (info.comment && info.comment.trim().length > 0)
      contents += "\n\n" + info.comment.trim();
    return { contents: { kind: "markdown", value: contents } };
  }

  // Search current file for definitions
  if (pp) {
    for (let i = 0; i < pp.funcList.length; i++) {
      const info = pp.funcList[i];
      if (info.nameCmp !== wLower) continue;
      if (info.foundLike !== "definition") continue;
      // For locals/params, check scope
      if (info.kind === "local" || info.kind === "param") {
        if (info.parent) {
          if (info.parent.startLine > params.position.line) continue;
          if (
            info.parent.endLine !== undefined &&
            info.parent.endLine < params.position.line
          )
            continue;
        }
      }
      const hover = buildHoverForInfo(info, pp);
      if (hover) return hover;
    }
  }

  // Search workspace files for definitions
  for (const file in files) {
    if (file === docUri) continue;
    const fpp = files[file];
    for (let i = 0; i < fpp.funcList.length; i++) {
      const info = fpp.funcList[i];
      if (info.nameCmp !== wLower) continue;
      if (info.foundLike !== "definition") continue;
      if (info.kind.endsWith("*")) continue; // static, skip cross-file
      if (
        info.kind === "local" ||
        info.kind === "param" ||
        info.kind === "static"
      )
        continue;
      const hover = buildHoverForInfo(info, fpp);
      if (hover) return hover;
    }
    if (cancelled.isCancellationRequested) return undefined;
  }

  // Search standard library docs
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].name && docs[i].name!.toLowerCase() === wLower) {
      const label = docs[i].label || docs[i].name!;
      let contents = "```harbour\n" + label + "\n```";
      if (docs[i].documentation) contents += "\n\n" + docs[i].documentation;
      return { contents: { kind: "markdown", value: contents } };
    }
  }

  return undefined;
});

connection.onFoldingRanges((params) => {
  const ranges: FoldingRangeRecord[] = [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const pp = getDocumentProvider(doc, true);
  for (let iSign = 0; iSign < pp.funcList.length; iSign++) {
    const info = pp.funcList[iSign];
    if (info.endLine !== undefined && info.startLine !== info.endLine) {
      ranges.push({ startLine: info.startLine, endLine: info.endLine });
    }
  }
  let deltaLine = 0;
  if (lineFoldingOnly) deltaLine = 1;
  for (let iGroup = 0; iGroup < pp.groups.length; iGroup++) {
    const poss = pp.groups[iGroup].positions;
    if (["if", "try", "sequence", "case"].indexOf(pp.groups[iGroup].type) < 0) {
      const i = poss.length - 1;
      ranges.push({
        startLine: poss[0].line,
        endLine: poss[i].line - deltaLine,
        startCharacter: poss[0].endCol,
        endCharacter: poss[i].startCol,
      });
    } else {
      let prev = 0;
      for (let i = 1; i < poss.length; i++) {
        if (poss[i].text !== "exit") {
          ranges.push({
            startLine: poss[prev].line,
            endLine: poss[i].line - deltaLine,
            startCharacter: poss[prev].endCol,
            endCharacter: poss[i].startCol,
          });
          prev = i;
        }
      }
    }
  }
  for (let iGroup = 0; iGroup < pp.preprocGroups.length; iGroup++) {
    const poss = pp.preprocGroups[iGroup].positions;
    const i = poss.length - 1;
    ranges.push({
      startLine: poss[0].line,
      endLine: poss[i].line - deltaLine,
      startCharacter: poss[0].endCol,
      endCharacter: poss[i].startCol,
    });
  }
  for (let iComment = 0; iComment < pp.multilineComments.length; iComment++) {
    const cc = pp.multilineComments[iComment];
    ranges.push({ kind: "comment", startLine: cc[0], endLine: cc[1] });
  }
  for (let iCFolder = 0; iCFolder < pp.cCodeFolder.length; iCFolder++) {
    const folder = pp.cCodeFolder[iCFolder];
    ranges.push({
      startLine: folder[0],
      endLine: folder[2] - deltaLine,
      startCharacter: folder[1],
      endCharacter: folder[3],
    });
  }

  return ranges as server.FoldingRange[];
});

connection.onRequest("harbour/groupAtPosition", (params: any) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const pp = getDocumentProvider(doc, true);
  for (let iGroup = 0; iGroup < pp.groups.length; iGroup++) {
    const poss = pp.groups[iGroup].positions;
    for (let i = 0; i < poss.length; i++) {
      if (
        params.sel.active.line === poss[i].line &&
        params.sel.active.character >= poss[i].startCol &&
        params.sel.active.character <= poss[i].endCol
      ) {
        return poss;
      }
    }
  }
  return [];
});

connection.onRequest("harbour/docSnippet", (params: any) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  const pp = getDocumentProvider(doc);
  let funcInfo: provider.Info | undefined;
  let iSign: number = -1;
  for (let i = 0; i < pp.funcList.length; i++) {
    const info = pp.funcList[i];
    if (!info.kind.startsWith("procedure") && !info.kind.startsWith("function"))
      continue;
    if (info.startLine > params.sel[0].line) {
      funcInfo = info;
      iSign = i;
      break;
    }
  }
  if (!funcInfo) return undefined;
  if (funcInfo.hDocIdx !== undefined) return undefined;
  const subParams: provider.Info[] = [];
  for (let iParam = iSign + 1; iParam < pp.funcList.length; iParam++) {
    const subInfo = pp.funcList[iParam];
    if (subInfo.parent === funcInfo && subInfo.kind === "param") {
      subParams.push(subInfo);
    } else break;
  }

  let snippet = "/* \\$DOC\\$\r\n";
  snippet += "\t\\$TEMPLATE\\$\r\n\t\t" + funcInfo.kind + "\r\n";
  snippet += "\t\\$ONELINER\\$\r\n\t\t$1\r\n";
  snippet += "\t\\$SYNTAX\\$\r\n\t\t" + funcInfo.name + "(";
  for (let iParam = 0; iParam < subParams.length; iParam++) {
    const param = subParams[iParam];
    snippet += "<" + param.name + ">";
    if (iParam !== subParams.length - 1) snippet += ", ";
  }
  if (funcInfo.kind.startsWith("function"))
    snippet += ") --> ${2:retValue}\r\n";
  else snippet += ")\r\n";
  snippet += "\t\\$ARGUMENTS\\$\r\n";
  let nTab = 3;
  for (let iParam = 0; iParam < subParams.length; iParam++) {
    const param = subParams[iParam];
    snippet += "\t\t<" + param.name + "> $" + nTab + "\r\n";
    nTab++;
  }
  if (funcInfo.kind.startsWith("function")) {
    snippet += "\t\\$RETURNS\\$\r\n";
    snippet += "\t\t${2:retValue} $" + nTab + "\r\n";
  }
  snippet += "\t\\$END\\$ */";
  return snippet;
});

connection.onRequest(
  server.SemanticTokensRequest.method,
  (param: server.SemanticTokensParams) => {
    const doc = documents.get(param.textDocument.uri);
    if (!doc) return { data: [] };
    const docUri = canonicalUri(doc.uri);
    let ret: number[][] = [];
    let pp: provider.Provider;
    if (docUri in files) pp = files[docUri];
    else return { data: [] }; // does not parse unknown files
    for (let i = 0; i < pp.funcList.length; i++) {
      const info = pp.funcList[i];
      if (
        (info.kind === "local" || info.kind === "param") &&
        info.nameCmp in pp.references
      ) {
        const id = info.kind === "local" ? 0 : 1;
        const p = info.parent;
        if (!p || p.endLine === undefined) continue;
        for (let ri = 0; ri < pp.references[info.nameCmp].length; ri++) {
          const ref = pp.references[info.nameCmp][ri];
          if (
            ref.type === "variable" &&
            ref.line >= p.startLine &&
            ref.line <= p.endLine
          ) {
            let mod = 0;
            if (ref.line === info.startLine) mod += 1;
            ret.push([ref.line, ref.col, info.nameCmp.length, id, mod]);
          }
        }
      }
      if (info.kind === "static" && info.nameCmp in pp.references) {
        const id = 0;
        for (let ri = 0; ri < pp.references[info.nameCmp].length; ri++) {
          const ref = pp.references[info.nameCmp][ri];
          if (ref.type === "variable") {
            let mod = 2; //static
            if (ref.line === info.startLine) mod += 1;
            ret.push([ref.line, ref.col, info.nameCmp.length, id, mod]);
          }
        }
      }
    }
    ret = ret.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
    for (let i = ret.length - 1; i > 0; --i) {
      if (ret[i][0] !== ret[i - 1][0]) {
        //different lines
        ret[i][0] -= ret[i - 1][0];
      } else {
        ret[i][0] = 0;
        ret[i][1] -= ret[i - 1][1];
      }
    }
    const flat: number[] = ([] as number[]).concat(...ret);
    return { data: flat };
  },
);

connection.onReferences((params) => {
  const w = GetWord(params, true);
  if ((w as string | unknown[]).length === 0) return undefined;
  const wTuple = w as [string, string, number];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return undefined;
  const docUri = canonicalUri(doc.uri);
  const prev = wTuple[1];
  const next = getNextNotSpace(doc, wTuple[2] + wTuple[0].length);
  let kind = "variable";
  if (prev === ":") kind = next === "(" ? "method" : "data";
  else kind = next === "(" ? "function" : "variable";
  if (prev === "->") kind = "field";
  const ret: server.Location[] = [];
  const word = wTuple[0].toLowerCase();
  let pThis: provider.Provider;
  if (docUri in files) pThis = files[docUri];
  else pThis = getDocumentProvider(doc);
  const reqLine = params.position.line;
  const def = pThis.funcList.find(
    (v) =>
      v.nameCmp === word &&
      (v.parent === undefined ||
        (v.parent.startLine <= reqLine &&
          (v.parent.endLine === undefined || v.parent.endLine >= reqLine))),
  );
  let onlyThis = false;
  if (def) {
    kind = def.kind;
    if (def.kind.endsWith("*")) {
      onlyThis = true;
      kind = kind.substring(0, kind.length - 1);
    }
    if (def.kind === "local") onlyThis = true;
    if (def.kind === "static") onlyThis = true;
    if (def.kind === "param") onlyThis = true;
  }
  if (word in pThis.references) {
    for (let i = 0; i < pThis.references[word].length; i++) {
      const ref = pThis.references[word][i];
      if (ref.type !== kind) continue;
      if (def && def.parent && onlyThis) {
        if (ref.line < def.parent.startLine) continue;
        if (def.parent.endLine !== undefined && ref.line > def.parent.endLine)
          continue;
      }
      ret.push(
        server.Location.create(
          docUri,
          server.Range.create(
            ref.line,
            ref.col,
            ref.line,
            ref.col + word.length,
          ),
        ),
      );
    }
  }

  if (!onlyThis)
    for (const file in files) {
      if (file === docUri) continue;
      const pp = files[file];
      if (word in pp.references) {
        for (let i = 0; i < pp.references[word].length; i++) {
          const ref = pp.references[word][i];
          if (ref.type === kind) {
            ret.push(
              server.Location.create(
                file,
                server.Range.create(
                  ref.line,
                  ref.col,
                  ref.line,
                  ref.col + word.length,
                ),
              ),
            );
          }
        }
      }
    }
  return ret;
});

function getNextNotSpace(
  doc: server_textdocument.TextDocument,
  startPos: number,
): string {
  const currPos = doc.positionAt(startPos);
  const endPos = doc.positionAt(startPos);
  endPos.line += 1;
  endPos.character = 0;
  const p = doc.getText(server.Range.create(currPos, endPos)).trimStart();
  return p[0];
}

/**
 * Removes comment block and empties strings
 * @note merge this with linePP
 */
function getCleanline(
  _line: string,
  lineState: provider.lineState | undefined,
  precLineState: provider.lineState | undefined,
): string {
  let line = _line;
  let i = 0;
  if (line.trim().length === 0) return "";
  if (lineState && lineState.type !== 0) return "";
  if (precLineState && precLineState.state === 1) {
    const endComment = line.indexOf("*/");
    if (endComment === -1) {
      return "";
    }
    line = " ".repeat(endComment + 2) + line.substring(endComment + 2);
    i = endComment + 2;
  }
  const precCont = !!(precLineState && precLineState.state === 2);
  if (!precCont && line.trimStart().startsWith("#")) {
    return "";
  }
  let justStart = !precCont;
  let prevC = " ",
    c = " ",
    prevCNoSpace = "";
  for (; i < line.length; i++) {
    prevC = c;
    prevCNoSpace = c === " " || c === "\t" ? prevCNoSpace : c;
    c = line[i];
    if (justStart) {
      justStart = prevC === " " || prevC === "\t";
    }
    // check code
    if (
      justStart &&
      (c === "n" || c === "N") &&
      line.substring(i, i + 4).toLowerCase() === "note"
    ) {
      return "";
    }
    if (c === "*") {
      if (justStart) {
        // commented line: skip
        return "";
      }
      if (prevC === "/") {
        const endComment = line.indexOf("*/", i + 1);
        if (endComment > 0) {
          line =
            line.substring(0, i - 1) +
            " ".repeat(endComment - i + 3) +
            line.substring(endComment + 2);
          c = " ";
          i = endComment;
          continue;
        } else {
          line = line.substring(0, i - 1);
          break;
        }
      }
    }
    if ((c === "/" && prevC === "/") || (c === "&" && prevC === "&")) {
      break;
    }
    if (
      c === '"' ||
      c === "'" ||
      (c === "[" &&
        /[^a-zA-Z0-9_\[\]]/.test(prevCNoSpace) &&
        !/^\s*#/.test(line))
    ) {
      let endString = line.indexOf(c === "[" ? "]" : c, i + 1);
      if (c === '"' && prevC === "e") {
        while (endString > 0 && line[endString - 1] === "\\") {
          endString = line.indexOf('"', endString + 1);
        }
      }
      if (endString < 0) {
        line = line.substring(0, i - 1);
        break;
      }
      line =
        line.substring(0, i + 1) +
        " ".repeat(endString - i - 1) +
        line.substring(endString);
      i = endString + 1;
      c = " ";
      continue;
    }
  }
  return line;
}

connection.onDocumentFormatting((params) => {
  const ret: server.TextEdit[] = [];
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const docUri = canonicalUri(doc.uri);
  let pThis: provider.Provider;
  if (docUri in files) pThis = files[docUri];
  else pThis = getDocumentProvider(doc);
  const tabs: number[] = new Array(doc.lineCount);
  tabs.fill(0);
  for (let iSign = 0; iSign < pThis.funcList.length; iSign++) {
    const info = pThis.funcList[iSign];
    if (info.endLine !== undefined && info.startLine !== info.endLine) {
      let doTab = false;
      if (
        currStyleConfig?.indent?.funcBody &&
        [
          "class",
          "method",
          "function",
          "procedure",
          "function*",
          "procedure*",
        ].indexOf(info.kind) >= 0
      )
        doTab = true;
      if (doTab) {
        for (let l = info.startLine + 1; l < info.endLine; ++l) {
          tabs[l] += 1;
        }
        let doLast = false;
        if (
          (info.kind.startsWith("func") || info.kind.startsWith("proc")) &&
          info.foundLike === "definition"
        ) {
          const line = doc.getText(
            server.Range.create(info.endLine, 0, info.endLine, 1e8),
          );
          doLast = !line.trimStart().toLowerCase().startsWith("ret");
        }
        if (doLast) tabs[info.endLine] += 1;
      }
    }
  }
  for (let i = 0; i < pThis.groups.length; ++i) {
    const group = pThis.groups[i];
    let doTab = false;
    let checkInside = false;
    switch (group.type) {
      case "if":
      case "try":
      case "sequence":
        doTab = currStyleConfig?.indent?.logical;
        checkInside = true;
        break;
      case "for":
      case "while":
        doTab = currStyleConfig?.indent?.cycle;
        break;
      case "case":
        // simple "case" case,
        doTab =
          currStyleConfig?.indent?.switch && !currStyleConfig?.indent?.case;
        break;
    }
    if (doTab) {
      const startLine = group.positions[0].line + 1;
      const endLine = group.positions[group.positions.length - 1].line;
      for (let l = startLine; l < endLine; ++l) {
        tabs[l] += 1;
      }
      if (checkInside) {
        for (let p = 1; p < group.positions.length - 1; ++p) {
          tabs[group.positions[p].line] -= 1;
        }
      }
    }
    if (
      currStyleConfig?.indent?.switch &&
      currStyleConfig?.indent?.case &&
      group.type === "case"
    ) {
      // complex "case" case,
      const startLine = group.positions[0].line + 1;
      const endLine = group.positions[group.positions.length - 1].line;
      for (let l = startLine; l < endLine; ++l) {
        tabs[l] += 2;
      }
      for (let p = 1; p < group.positions.length; ++p) {
        const text = group.positions[p].text;
        if (
          typeof text === "string"
            ? text.startsWith("case")
            : Array.isArray(text)
              ? typeof text[0] === "string" && text[0].startsWith("case")
              : false
        )
          tabs[group.positions[p].line] -= 1;
      }
    }
  }
  for (let i = 0; i < doc.lineCount; ++i) {
    const state = pThis.lineStates[i];
    const precState = i === 0 ? state : pThis.lineStates[i - 1];
    if (state.type === 0 && precState.state !== 1) {
      let t = tabs[i];
      const precCont = precState.state === 2;
      if (i > 0 && precCont) t++;
      const line = doc.getText(server.Range.create(i, 0, i, 1e8));
      let firstNoSpace = 0;
      while (line[firstNoSpace] === " " || line[firstNoSpace] === "\t")
        firstNoSpace++;
      const line2 = getCleanline(line, state, precState);
      if (currStyleConfig?.replace?.not !== "ignore") {
        if (currStyleConfig?.replace?.not === "use .not.") {
          let p = line2.lastIndexOf("!");
          while (p > 0) {
            const currRange = server.Range.create(i, p, i, p + 1);
            ret.push(server.TextEdit.replace(currRange, ".not."));
            p = line2.lastIndexOf("!", p - 1);
          }
        }
        if (currStyleConfig?.replace?.not === "use !") {
          let p = line2.lastIndexOf(".not.");
          while (p > 0) {
            const currRange = server.Range.create(i, p, i, p + 5);
            ret.push(server.TextEdit.replace(currRange, "!"));
            p = line2.lastIndexOf(".not.", p - 1);
          }
        }
      }
      let commentReplaced = false;
      if (
        precState.state === 0 &&
        currStyleConfig?.replace?.asterisk !== "ignore"
      ) {
        if (/^\s*(\*|\/\/|&&|note)/i.test(line)) {
          commentReplaced = true;
          const firstChar = line.substring(firstNoSpace, firstNoSpace + 1);
          let commentLen = 2;
          if (firstChar === "*") commentLen = 1;
          if (firstChar === "n") commentLen = 4;
          if (firstChar === "N") commentLen = 4;
          if (
            currStyleConfig?.replace?.asterisk === "use //" &&
            firstChar !== "/"
          ) {
            const currRange = server.Range.create(
              i,
              firstNoSpace,
              i,
              firstNoSpace + commentLen,
            );
            ret.push(server.TextEdit.replace(currRange, "//"));
          }
          if (
            currStyleConfig?.replace?.asterisk === "use &&" &&
            firstChar !== "&"
          ) {
            const currRange = server.Range.create(
              i,
              firstNoSpace,
              i,
              firstNoSpace + commentLen,
            );
            ret.push(server.TextEdit.replace(currRange, "&&"));
          }
          if (
            currStyleConfig?.replace?.asterisk === "use *" &&
            firstChar !== "*"
          ) {
            const currRange = server.Range.create(
              i,
              firstNoSpace,
              i,
              firstNoSpace + commentLen,
            );
            ret.push(server.TextEdit.replace(currRange, "*"));
          }
        }
      }
      if (!commentReplaced && currStyleConfig?.replace?.amp !== "ignore") {
        if (currStyleConfig?.replace?.asterisk === "use //") {
          const pAmp = line2.indexOf("&&");
          if (pAmp > 0) {
            const currRange = server.Range.create(i, pAmp, i, pAmp + 2);
            ret.push(server.TextEdit.replace(currRange, "//"));
          }
        }
        if (currStyleConfig?.replace?.asterisk === "use &&") {
          const pAmp = line2.indexOf("//");
          if (pAmp > 0) {
            const currRange = server.Range.create(i, pAmp, i, pAmp + 2);
            ret.push(server.TextEdit.replace(currRange, "&&"));
          }
        }
      }
      const unspaced = line.trimStart();
      if (unspaced.length > 0) {
        let space = "";
        if (params.options.insertSpaces)
          space = " ".repeat((params.options.tabSize as number) * t);
        else space = "\t".repeat(t);
        if (
          !line.startsWith(space) ||
          line[space.length] === " " ||
          line[space.length] === "\t"
        ) {
          const currRange = server.Range.create(i, 0, i, firstNoSpace);
          ret.push(server.TextEdit.replace(currRange, space));
        }
      }
    }
  }
  return ret;
});

connection.listen();
