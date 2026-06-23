import * as server from "vscode-languageserver/node";
import { Provider, Info, ReferenceType } from "./provider";

// Shared scope-resolution + reference-collection logic used by both
// "Find All References" (connection.onReferences) and "Rename Symbol"
// (connection.onPrepareRename / onRenameRequest). Keeping it pure (no
// dependency on the live `documents`/`files` globals) makes it unit-testable
// against parser output the same way definition.test.ts mirrors go-to-def.

export interface RenameScope {
  /** lowercased identifier under the cursor */
  word: string;
  /** the reference bucket type the symbol's occurrences are stored under */
  refType: ReferenceType;
  /** the definition found in the cursor's own provider, if any */
  def: Info | undefined;
  /** true when occurrences must stay within the cursor's file (and, for
   *  locals/params, within the enclosing routine) */
  onlyThis: boolean;
}

/**
 * Map an Info.kind (the parser's symbol vocabulary) onto the ReferenceType
 * bucket that findDBReferences() files its occurrences under.
 *
 * This is the crucial bridge that the old onReferences code lacked: it set
 * `kind = def.kind` directly and then compared it against `ref.type`, so a
 * same-file `PROCEDURE Foo` (def.kind "procedure") never matched its own
 * call-site references (ref.type "function") and silently returned nothing.
 */
export function kindToRefType(kind: string): ReferenceType {
  // module-static functions/procedures are tagged with a trailing "*"
  if (kind.endsWith("*")) kind = kind.slice(0, -1);
  switch (kind) {
    case "function":
    case "procedure":
    case "C-FUNC":
      return "function";
    case "method":
      return "method";
    case "data":
    case "access":
    case "assign":
      return "data";
    case "field":
      return "field";
    default:
      // local, static, public, private, param, memvar, define, ...
      return "variable";
  }
}

/** Infer the reference bucket from surrounding punctuation when no local
 *  definition is available (e.g. a function defined in another file). */
export function inferRefType(prev: string, next: string): ReferenceType {
  if (prev === "->") return "field";
  if (prev === ":") return next === "(" ? "method" : "data";
  return next === "(" ? "function" : "variable";
}

/**
 * Resolve what to rename/find given the cursor's provider and surrounding
 * context. Mirrors the head of the original connection.onReferences.
 */
export function resolveScope(
  pThis: Provider,
  word: string,
  prev: string,
  next: string,
  reqLine: number,
): RenameScope {
  let refType = inferRefType(prev, next);
  const def = pThis.funcList.find(
    (v) =>
      v.nameCmp === word &&
      (v.parent === undefined ||
        (v.parent.startLine <= reqLine &&
          (v.parent.endLine === undefined || v.parent.endLine >= reqLine))),
  );
  let onlyThis = false;
  if (def) {
    refType = kindToRefType(def.kind);
    // module-static (trailing "*"), file-local and routine-local symbols
    // never escape their own file.
    if (def.kind.endsWith("*")) onlyThis = true;
    if (def.kind === "local" || def.kind === "static" || def.kind === "param")
      onlyThis = true;
  }
  return { word, refType, def, onlyThis };
}

/**
 * Collect every occurrence of the resolved symbol as LSP Locations.
 *
 * `providers` is the workspace file map (uri -> Provider). `pThis` is the
 * provider for the cursor's document, passed separately because an unsaved
 * buffer may not yet be in `providers`.
 */
export function collectLocations(
  providers: Record<string, Provider>,
  targetUri: string,
  pThis: Provider,
  scope: RenameScope,
): server.Location[] {
  const { word, refType, def, onlyThis } = scope;
  const out: server.Location[] = [];

  const pushFrom = (uri: string, pp: Provider): void => {
    const refs = pp.references[word];
    if (!refs) return;
    for (const ref of refs) {
      if (ref.type !== refType) continue;
      // For routine-local symbols, restrict to the enclosing routine's body
      // (only meaningful in the cursor's own file).
      if (uri === targetUri && onlyThis && def && def.parent) {
        if (ref.line < def.parent.startLine) continue;
        if (def.parent.endLine !== undefined && ref.line > def.parent.endLine)
          continue;
      }
      out.push(
        server.Location.create(
          uri,
          server.Range.create(ref.line, ref.col, ref.line, ref.col + word.length),
        ),
      );
    }
  };

  pushFrom(targetUri, pThis);
  if (!onlyThis)
    for (const file in providers) {
      if (file === targetUri) continue;
      pushFrom(file, providers[file]);
    }
  return out;
}

/**
 * True when the symbol is actually defined somewhere we can see — used to
 * refuse renaming Harbour built-ins / stdlib functions, whose definitions
 * live outside the workspace and so cannot be consistently rewritten.
 */
export function hasWorkspaceDefinition(
  providers: Record<string, Provider>,
  targetUri: string,
  pThis: Provider,
  scope: RenameScope,
): boolean {
  if (scope.def) return true;
  const { word, refType } = scope;
  const check = (pp: Provider): boolean =>
    pp.funcList.some(
      (i) =>
        i.foundLike === "definition" &&
        i.nameCmp === word &&
        kindToRefType(i.kind) === refType,
    );
  if (check(pThis)) return true;
  for (const file in providers) {
    if (file === targetUri) continue;
    if (check(providers[file])) return true;
  }
  return false;
}

/** Harbour identifiers: a letter/underscore followed by word characters. */
export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
