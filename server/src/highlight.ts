import * as server from "vscode-languageserver/node";

// Classifies an occurrence as a read or a write for textDocument/documentHighlight.
// The parser's `reference` records carry no assignment context — `howWrite` is
// the identifier's original casing, not its access mode — so the decision is
// made from the surrounding source text instead.

/**
 * Operators that assign to the identifier on their left.
 *
 * Bare `=` is deliberately absent: in Harbour it compares, so treating it as a
 * write would mark every `IF x = 1` as one. `==`, `<=`, `>=` and `!=` are
 * excluded for the same reason — none of them begin with a listed operator.
 */
const ASSIGN_AFTER = /^\s*(?::=|\*\*=|\+=|-=|\*=|\/=|%=|\^=|\+\+|--)/;

/** `++x` / `--x`, where the write operator precedes the identifier. */
const ASSIGN_BEFORE = /(?:\+\+|--)\s*$/;

/**
 * `lineText` is the whole line the occurrence sits on; `col` its start column.
 * `isDefinition` marks the occurrence that *is* the symbol's declaration —
 * `LOCAL x`, a parameter, a `FUNCTION` header — which is always a write.
 */
export function highlightKind(
  lineText: string,
  col: number,
  wordLength: number,
  isDefinition: boolean,
): server.DocumentHighlightKind {
  if (isDefinition) return server.DocumentHighlightKind.Write;
  if (ASSIGN_AFTER.test(lineText.slice(col + wordLength)))
    return server.DocumentHighlightKind.Write;
  if (ASSIGN_BEFORE.test(lineText.slice(0, col)))
    return server.DocumentHighlightKind.Write;
  return server.DocumentHighlightKind.Read;
}
