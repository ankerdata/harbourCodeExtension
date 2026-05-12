import * as fs from "fs";
import * as readline from "readline";

export const keywords: string[] = [
  "local",
  "static",
  "private",
  "memvar",
  "function",
  "procedure",
  "return",
  "if",
  "else",
  "elseif",
  "end if",
  "end while",
  "end case",
  "end do",
  "end switch",
  "end class",
  "end sequence",
  "do while",
  "case",
  "switch",
  "endcase",
  "otherwise",
  "default",
  "for",
  "for each",
  "to",
  "in",
  "next",
  "exit",
  "loop",
  "try",
  "catch",
  "finally",
  "begin sequence",
  "begin sequence with",
  "recover",
  "recover using",
];

// beta feature
const commandParsingEnabled = false;

const procRegEx =
  /\s*((?:proc(?:e(?:d(?:u(?:r(?:e)?)?)?)?)?)|func(?:t(?:i(?:o(?:n)?)?)?)?)\s+([a-z_][a-z0-9_]*)\s*(?:\(([^\)]*)\))?/i;
const methodRegEx =
  /\s*(meth(?:o(?:d)?)?)\s+(?:(?:(?:proc(?:e(?:d(?:u(?:r(?:e)?)?)?)?)?)|func(?:t(?:i(?:o(?:n)?)?)?)?)\s+)?([a-z_][a-z0-9_]*)\s*(?:\(([^\)]*)\))?(?:\s*class\s+([a-z_][a-z0-9_]*))?(\s+inline)?/i;
const defineRegEx = /\s*(#\s*define)\s+([^\s\(]+)(?:\(([^\)]*)\))?(\s+.*)?/i;
const hb_funcRegEx = /HB_FUNC\s*\(\s*([A-Z0-9_]+)\s*\)/;

export interface DbInfo {
  name: string;
  fields: Record<string, string>;
}

interface CommentInfo {
  line: number;
  pos: number;
  value: string;
}

export interface CommandPart {
  text: string;
  fixed: boolean;
  regEx?: RegExp;
  snippet?: string;
  repeatable?: boolean;
}

export type Command = CommandPart[] & {
  name: string;
  regEx?: RegExp;
  startLine: number;
  endLine: number;
};

export interface HarbourArgInfo {
  name?: string;
  label?: string;
  documentation?: string;
  help?: string;
}

export interface HarbourDocInfo {
  name?: string;
  label?: string;
  documentation?: string;
  template?: string;
  arguments?: HarbourArgInfo[];
  return?: HarbourArgInfo;
}

export type LineType = 0 | 1 | 2;
export type LineEndState = 0 | 1 | 2;

export class lineState {
  type: LineType;
  state: LineEndState;
  constructor(type?: LineType, state?: LineEndState) {
    this.type = typeof type === "number" ? type : 0;
    this.state = typeof state === "number" ? state : 0;
  }
}

export type ReferenceType =
  | "variable"
  | "function"
  | "data"
  | "method"
  | "field";

export class reference {
  type: ReferenceType;
  line: number;
  col: number;
  howWrite: string;
  constructor(
    type: ReferenceType,
    line: number,
    col: number,
    howWrite: string,
  ) {
    this.type = type;
    this.line = line;
    this.col = col;
    this.howWrite = howWrite;
  }
}

export class Info {
  name: string;
  nameCmp: string;
  kind: string;
  foundLike: string;
  parent: Info | undefined;
  parentName?: string;
  document: string;
  startLine: number;
  startCol: number;
  endLine: number | undefined;
  endCol: number;
  comment?: string;
  body?: string;
  hDocIdx?: number;

  constructor(
    name: string,
    kind: string,
    foundLike: string,
    parent: Info | string | undefined,
    document: string,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
    comment?: string,
  ) {
    this.name = name;
    this.nameCmp = name.toLowerCase();
    this.kind = kind;
    this.foundLike = foundLike;
    if (typeof parent === "string") {
      this.parentName = parent;
      this.parent = undefined;
    } else {
      this.parent = parent;
    }
    this.document = document;
    this.startLine = startLine;
    this.startCol = startCol;
    this.endLine = endLine;
    this.endCol = endCol;
    if (comment) {
      // remove the first newline and replace every character repeated more than 3 times that it is not a space, with 2 of them.
      this.comment = comment.trim().replace(/(\S)\1{2,}/g, "$1$1");
    }
  }
}

export class KeywordPos {
  line: number;
  startCol: number;
  endCol: number;
  text: unknown;
  constructor(line: number, startCol: number, endCol: number, text: unknown) {
    this.line = line;
    this.startCol = startCol;
    this.endCol = endCol;
    this.text = text;
  }
}

export class Group {
  type: string;
  positions: KeywordPos[];
  constructor(type: string) {
    this.type = type;
    this.positions = [];
  }
  addRange(
    line: number,
    startCol: number,
    endCol: number,
    text: unknown,
  ): void {
    this.positions.push(new KeywordPos(line, startCol, endCol, text));
  }
}

export class Provider {
  // *********** options
  light: boolean;
  doGroups: boolean = false;

  // *********** data used during the parsing
  /** is true for multi line comments */
  comment: boolean = false;
  /** is true for pragma text */
  pragmaText: boolean = false;
  /** current line parsing, with string and comments */
  currLinePreProc: string = "";
  /** current line parsing, without string and comments */
  currLine: string = "";
  clPPArray: string[] = [];
  clArray: string[] = [];
  /** current line number */
  lineNr: number = -1;
  /** for statement that continues on next line, it indicates the first */
  startLine: number = 0;
  /** last line number not empty after removing all comments */
  lastCodeLine: number = 0;
  /** is true if parsing a c file or inside the pragma dump */
  cMode: boolean = false;
  /** has value inside class declaration */
  currentClass: Info | undefined = undefined;
  /** has value inside a procedure, function or method */
  currentMethod: Info | undefined = undefined;
  /** removed comments */
  removedComments: CommentInfo[] = [];
  /** file name on the disk (program.prg) */
  currentDocument: string = "";
  /** An array of current groups */
  groupStack: Group[] = [];
  /** An array of current groups of preprocessor */
  preprocGroupStack: Group[] = [];
  /** is true if previous line ends with `;` (continued statement) */
  cont: boolean = false;

  // **** OUTPUTS
  funcList: Info[] = [];
  /** every key is the lowercase name of db */
  databases: Record<string, DbInfo> = {};
  /** The array of groups found */
  groups: Group[] = [];
  /** The array of preproc groups found */
  preprocGroups: Group[] = [];
  /** The array of included file */
  includes: string[] = [];
  /** Position of multiline comments. Each entry is [start, end] */
  multilineComments: number[][] = [];
  /** TEMP: current first line of comment */
  firstLineComment: number = -1;
  /** Position of curly braces {} on C Code: [openLine, openCol, closeLine, closeCol] */
  cCodeFolder: number[][] = [];
  /** list of docs defined with $DOC$ */
  harbourDocs: HarbourDocInfo[] = [];
  /** command definitions */
  commands: Command[] = [];
  /** the state of lines */
  lineStates: lineState[] = [];
  references: Record<string, reference[]> = {};

  constructor(light?: boolean) {
    this.light = light !== undefined ? light : false;
    this.Clear();
  }

  get lastComment(): string {
    return this.removedComments[this.removedComments.length - 1].value;
  }
  set lastComment(v: string) {
    const dest = this.removedComments[this.removedComments.length - 1];
    if (dest.line < 0) dest.line = this.lineNr;
    dest.value = v;
  }
  set lastCommentPos(v: number) {
    this.removedComments[this.removedComments.length - 1].pos = v;
  }

  Clear(): void {
    this.comment = false;
    this.pragmaText = false;
    this.currLinePreProc = "";
    this.currLine = "";
    this.clPPArray = [];
    this.clArray = [];
    this.lineNr = -1;
    this.startLine = 0;
    this.lastCodeLine = 0;
    this.cMode = false;
    this.currentClass = undefined;
    this.currentMethod = undefined;
    this.removedComments = [];
    this.resetComments();
    this.currentDocument = "";
    this.groupStack = [];
    this.preprocGroupStack = [];
    this.cont = false;
    // OUTPUTS
    this.funcList = [];
    this.databases = {};
    this.groups = [];
    this.preprocGroups = [];
    this.includes = [];
    this.multilineComments = [];
    this.firstLineComment = -1;
    this.cCodeFolder = [];
    this.harbourDocs = [];
    this.commands = [];
    this.lineStates = [];
    this.references = {};
  }

  resetComments(): void {
    this.removedComments = [];
    this.newComment();
  }

  newComment(): void {
    if (this.removedComments.length > 0) {
      const lc = this.removedComments[this.removedComments.length - 1];
      if (lc.line === -1) return;
    }
    this.removedComments.push({
      line: -1,
      pos: 0,
      value: "",
    });
  }

  addInfo(
    name: string,
    kind: string,
    like: string,
    parent: Info | string | undefined,
    search?: boolean,
  ): Info {
    if (search !== true) search = false;
    if (search) {
      const lines = this.currLine.split("\r\n");
      const rr = new RegExp(
        "\\b" +
          name.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&") +
          "\\b",
        "i",
      );
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = rr.exec(line);
        if (m) {
          let thisComment = "";
          let nextComma = line.indexOf(",", m.index);
          if (nextComma < 0) nextComma = line.indexOf(")", m.index);
          if (nextComma < 0) nextComma = line.length + 10;
          const prevComma = line.lastIndexOf(",", m.index);
          for (let ic = 0; ic < this.removedComments.length; ic++) {
            if (
              this.removedComments[ic].line === this.startLine + i && //same line
              ((this.removedComments[ic].pos < nextComma && //inside this elements commas
                this.removedComments[ic].pos > prevComma) ||
                (this.removedComments[ic].pos >= line.length && // the comment is at end of line
                  line.indexOf(",", nextComma + 1) < 0))
            )
              // it is the last element in the line
              thisComment = this.removedComments[ic].value;
          }
          const ii = new Info(
            name,
            kind,
            like,
            parent,
            this.currentDocument,
            this.startLine + i,
            m.index,
            this.startLine + i,
            m.index + name.length,
            thisComment,
          );
          this.funcList.push(ii);
          return ii;
        }
      }
    }
    let comment = this.lastComment;
    if (this.removedComments.length > 0)
      for (let i = 0; i < this.removedComments.length; i++) {
        const comm = this.removedComments[i];
        if (comm.line < this.startLine) comment = comm.value;
        else break;
      }
    const ii = new Info(
      name,
      kind,
      like,
      parent,
      this.currentDocument,
      this.startLine,
      0,
      this.lineNr,
      1000,
      comment,
    );
    this.funcList.push(ii);
    return ii;
  }

  linePP(line: string): string {
    let i = 0;
    if (this.comment) {
      const endComment = line.indexOf("*/");
      if (endComment === -1) {
        this.lastComment += "\r\n" + line;
        this.lineStates.push(new lineState(this.cMode ? 1 : 0, 1));
        return "";
      }
      this.lastComment += "\r\n" + line.substring(0, endComment);
      line = " ".repeat(endComment + 2) + line.substr(endComment + 2);
      this.comment = false;
      i = endComment + 2;
    }
    if (this.pragmaText) {
      if (/^\s*(?:#\s*pragma\s+__)?endtext/i.test(line)) {
        this.pragmaText = false;
        this.lineStates.push(new lineState());
        return "";
      } else {
        this.lineStates.push(new lineState(2));
        return "";
      }
    }
    if (line.trim().length === 0) {
      if (!this.cont) this.resetComments();
      this.lineStates.push(new lineState(this.cMode ? 1 : 0));
      return "";
    }
    if (
      !this.cont &&
      (/^\s*#\s*pragma\s+(?:__text|__stream|__cstream)\b/i.test(line) ||
        /^\s*(text)\b/i.test(line))
    ) {
      this.pragmaText = true;
      this.lineStates.push(new lineState(this.cMode ? 1 : 0));
      return "";
    }

    let prevJustStart: boolean;
    let justStart = !this.cont;
    let prevC = " ",
      c = " ",
      prevCNoSpace = "";
    let lineStart = 0;
    for (; i < line.length; i++) {
      prevC = c;
      prevCNoSpace = c === " " || c === "\t" ? prevCNoSpace : c;
      prevJustStart = justStart;
      c = line[i];
      if (justStart) {
        justStart = prevC === " " || prevC === "\t";
        lineStart = i;
      }
      // check code
      if (
        justStart &&
        !this.cMode &&
        (c === "n" || c === "N") &&
        !this.cMode &&
        line.substring(i, i + 4).toLowerCase() === "note"
      ) {
        this.lastComment += "\r\n" + line.trim().substr(4);
        if (this.firstLineComment < 0) this.firstLineComment = this.lineNr;
        this.lineStates.push(new lineState(this.cMode ? 1 : 0));
        return "";
      }
      if (c === "*") {
        if (justStart && !this.cMode) {
          // commented line: skip
          this.lastComment += "\r\n" + line.substr(i + 1);
          if (this.firstLineComment < 0) this.firstLineComment = this.lineNr;
          this.lineStates.push(new lineState(this.cMode ? 1 : 0));
          return "";
        }
        if (prevC === "/") {
          const endComment = line.indexOf("*/", i + 1);
          if (endComment > 0) {
            if (!prevJustStart) this.newComment();
            this.lastComment = "\r\n" + line.substr(i + 1, endComment - i - 1);
            this.lastCommentPos = i - lineStart;
            this.newComment();
            line =
              line.substring(0, i - 1) +
              " ".repeat(endComment - i + 3) +
              line.substr(endComment + 2);
            c = " ";
            i = endComment;
            continue;
          } else {
            if (!prevJustStart) this.newComment();
            this.lastComment += "\r\n" + line.substr(i + 1);
            this.lastCommentPos = i - lineStart;
            this.comment = true;
            line = line.substring(0, i - 1);
            if (this.firstLineComment < 0) this.firstLineComment = this.lineNr;
            break;
          }
        }
      }
      if (
        (c === "/" && prevC === "/") ||
        (c === "&" && prevC === "&" && !this.cMode)
      ) {
        if (!prevJustStart) {
          this.newComment();
          if (this.firstLineComment < 0) this.firstLineComment = this.lineNr;
        }
        this.lastComment += "\r\n" + line.substr(i + 1);
        this.lastCommentPos = i + 1 - lineStart;
        line = line.substring(0, i - 1);
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
        if (c === '"' && (prevC === "e" || this.cMode)) {
          while (endString > 0 && line[endString - 1] === "\\") {
            endString = line.indexOf('"', endString + 1);
          }
        }
        if (endString < 0) {
          //error
          line = line.substring(0, i - 1);
          break;
        }
        line =
          line.substring(0, i + 1) +
          " ".repeat(endString - i - 1) +
          line.substr(endString);
        i = endString + 1;
        c = " ";
        continue;
      }
    }
    this.cont = line.trim().endsWith(";");
    this.lineStates.push(
      new lineState(this.cMode ? 1 : 0, this.comment ? 1 : this.cont ? 2 : 0),
    );
    return line;
  }

  parseDeclareList(
    list: string,
    kind: string,
    parent: Info | string | undefined,
  ): void {
    let i = -1;
    while (true) {
      i++;
      let filter: RegExp | undefined = undefined;
      switch (i) {
        case 0:
          filter = /\([^\(\)]*\)/g;
          break; // () couple
        case 1:
          filter = /;\s*\r?\n/g;
          break; // New line
        case 2:
          filter = /'[^']*'/g;
          break; // '' string
        case 3:
          filter = /"[^"]*"/g;
          break; // "" string
        case 4:
          filter = /\[[^\[\]]*\]/g;
          break; // [] string or array index
        case 5:
          filter = /{[^{}]*}/g;
          break; // {} array declaration
        case 6:
          filter = /:=(?:[^,]|$)*/g;
          break; // Assignation
      }
      if (filter === undefined) break;
      let old: string;
      do {
        old = list;
        list = list.replace(filter, "");
      } while (old.length !== list.length);
    }
    const items = list.split(",");
    for (let j = 0; j < items.length; j++) {
      const m = items[j].trim().split(/\s+/g)[0];
      if (m.length > 0 && m.match(/[a-z0-9_]+/i))
        this.addInfo(m, kind, "definition", parent, true);
    }
  }

  parseCommand(translate: boolean): void {
    if (!commandParsingEnabled) return;
    // find the define part and the result part
    const headerMatch = this.currLine.match(
      /^\s*#\w?(?:command|translate)\s+/i,
    );
    if (!headerMatch) return;
    const pos = headerMatch.index! + headerMatch[0].length;
    const endDefine = this.currLine.indexOf("=>");
    if (endDefine < 0) return; // incomplete code
    const definePart = this.currLine
      .substring(pos, endDefine)
      .replace(/;\s+/g, "");
    const resultPart = this.currLine
      .substring(endDefine + 2)
      .replace(/;\s+/g, "");
    // split the define part
    const splitParts = CommandSplitDefinition(definePart);
    if (!splitParts) return;
    const commandResult = splitParts as Command;
    // create a name from first fixed part
    let i = 0;
    while (!commandResult[i].fixed) i++;
    commandResult.name = commandResult[i].text
      .trim()
      .replace(/<[^>]+>/g, "")
      .replace(/[,]+/g, "")
      .replace(/\s+/g, " ");
    if (commandResult.name.length <= 0) return; //circular command ?
    // convert define parts in snippets
    for (let j = 0; j < commandResult.length; ++j) {
      commandResult[j].text = commandResult[j].text.trim();
      commandResult[j].regEx = CommandPartToRegex(commandResult[j].text);
      const snip = CommandPartToSnippet(
        commandResult[j].text,
        commandResult[j].fixed,
        resultPart,
      );
      if (!snip) return;
      commandResult[j].repeatable = snip.repeatable;
      commandResult[j].snippet = snip.snippet;
    }
    let k = 0;
    commandResult.regEx = undefined;
    while (!commandResult.regEx) {
      if (!commandResult[k].fixed) {
        k++;
        continue;
      }
      if (!commandResult[k].regEx) {
        k++;
        continue;
      }
      if (k > 0 || translate) commandResult.regEx = commandResult[k].regEx;
      else
        commandResult.regEx = new RegExp(
          "^\\s*" + commandResult[k].regEx!.source,
          "i",
        );
    }
    commandResult.startLine = this.startLine;
    commandResult.endLine = this.lineNr;
    this.commands.push(commandResult);
  }

  parseHarbour(words: string[]): void {
    if (
      this.currLine.indexOf("#pragma") >= 0 &&
      this.currLine.indexOf("BEGINDUMP") >= 0
    ) {
      if (this.currentMethod) {
        this.currentMethod.endLine = this.lastCodeLine;
        this.currentMethod = undefined;
      }
      this.cMode = true;
      return;
    }
    let words1 = "";
    if (words.length > 1) {
      words1 = words[1];
      words[1] = words[1].toLowerCase();
    } else {
      words[1] = "";
    }
    if (words[0][0] === "#") {
      if (words[0] === "#include") {
        //TODO: check if words1 first and last letter are "" or <>
        const incWords = this.currLinePreProc
          .replace(/\s+/g, " ")
          .trim()
          .split(" ");
        if (incWords.length > 1)
          this.includes.push(incWords[1].substr(1, incWords[1].length - 2));
      } else if (words[0] === "#define") {
        const r = defineRegEx.exec(this.currLinePreProc);
        if (r) {
          const define = this.addInfo(
            r[2],
            "define",
            "definition",
            undefined,
            true,
          );
          define.body = r[4] ? r[4].trim() : "";
          if (r[3] && r[3].length) this.parseDeclareList(r[3], "param", define);
        }
      } else if (
        words[0].endsWith("command") ||
        words[0].endsWith("translate")
      ) {
        this.parseCommand(words[0].endsWith("translate"));
      }
    } else {
      if (
        this.currentClass &&
        (words[0] === "endclass" ||
          (words[0] === "end" && words[1] === "class"))
      ) {
        if (this.currentMethod) this.currentMethod.endLine = this.lastCodeLine;
        this.currentMethod = undefined;
        this.currentClass.endLine = this.lineNr;
      } else if (words[0].length >= 4) {
        if (
          (words[0] === "class" &&
            (!this.currentClass || this.currentClass.endLine)) ||
          (words[0] === "create" && words[1] === "class")
        ) {
          if (this.currentMethod)
            this.currentMethod.endLine = this.lastCodeLine;
          this.currentMethod = undefined;
          if (words[0] === "create")
            this.currentClass = this.addInfo(
              words[2],
              "class",
              "definition",
              undefined,
            );
          else
            this.currentClass = this.addInfo(
              words1,
              "class",
              "definition",
              undefined,
            );
          this.currentClass.endLine = undefined;
        } else if (
          ["data", "var", "classdata", "classvar"].indexOf(words[0]) >= 0 ||
          (words[0] === "class" && ["data", "var"].indexOf(words[1]) >= 0)
        ) {
          if (this.currentClass) {
            words[1] = words1;
            let subList: string;
            if (words[0] === "class") subList = words.slice(2).join(" ");
            else subList = words.slice(1).join(" ");
            this.parseDeclareList(subList, "data", this.currentClass);
          }
        } else if (
          words[0] === "method" ||
          words[0] === "classmethod" ||
          (words[0] === "class" && words[1] === "method")
        ) {
          const r = methodRegEx.exec(this.currLine);
          if (r) {
            let fLike = "definition";
            if (this.currentClass && !this.currentClass.endLine)
              fLike = "declaration";
            if (r[4] && r[4].length) {
              r[4] = r[4].toLowerCase();
              fLike = "definition";
              if (
                (this.currentClass && this.currentClass.nameCmp !== r[4]) ||
                !this.currentClass
              ) {
                this.currentClass = this.funcList.find(
                  (v) => v.nameCmp === r[4],
                );
              }
            }
            if (r[5] && r[5].length) fLike = "definition";
            if (this.currentMethod)
              this.currentMethod.endLine = this.lastCodeLine;
            this.currentMethod = this.addInfo(
              r[2],
              "method",
              fLike,
              this.currentClass || r[4],
            );

            if (r[3] && r[3].length)
              this.parseDeclareList(r[3], "param", this.currentMethod);
          }
        } else if (
          words[0] === "procedure".substring(0, words[0].length) ||
          words[0] === "function".substring(0, words[0].length) ||
          ((words[0] === "static".substring(0, words[0].length) ||
            words[0] === "init" ||
            words[0] === "exit") &&
            words[1].length >= 4 &&
            (words[1] === "procedure".substring(0, words[1].length) ||
              words[1] === "function".substring(0, words[1].length)))
        ) {
          const r = procRegEx.exec(this.currLine);
          if (r) {
            let kind =
              r[1].startsWith("p") || r[1].startsWith("P")
                ? "procedure"
                : "function";
            if (words[0].startsWith("stat")) kind += "*";
            if (this.currentMethod)
              this.currentMethod.endLine = this.lastCodeLine;
            this.currentMethod = this.addInfo(
              r[2],
              kind,
              "definition",
              undefined,
            );
            if (r[3] && r[3].length)
              this.parseDeclareList(r[3], "param", this.currentMethod);
          }
        } else if (
          words[0] === "local".substring(0, words[0].length) ||
          words[0] === "public".substring(0, words[0].length) ||
          words[0] === "private".substring(0, words[0].length) ||
          words[0] === "static".substring(0, words[0].length) ||
          words[0] === "memvar".substring(0, words[0].length) ||
          words[0] === "field".substring(0, words[0].length)
        ) {
          // skip this in light mode
          if (this.currentMethod && this.light) return;
          if (
            this.currentMethod ||
            words[0].startsWith("stat") ||
            words[0].startsWith("memv") ||
            words[0].startsWith("fiel")
          ) {
            let kind = "local";
            if (words[0].startsWith("publ")) kind = "public";
            if (words[0].startsWith("priv")) kind = "private";
            if (words[0].startsWith("stat")) kind = "static";
            if (words[0].startsWith("memv")) kind = "memvar";
            if (words[0].startsWith("fiel")) kind = "field";
            words[1] = words1;
            this.parseDeclareList(
              words.slice(1).join(" "),
              kind,
              this.currentMethod,
            );
          }
        }
      }
    }
  }

  parseC(): void {
    if (
      this.currLine.indexOf("pragma") >= 0 &&
      this.currLine.indexOf("ENDDUMP") >= 0
    ) {
      this.cMode = false;
      return;
    }
    if (this.currLine.indexOf("HB_FUNC") >= 0) {
      const r = hb_funcRegEx.exec(this.currLine);
      if (r) {
        this.addInfo(r[1], "C-FUNC", "definition", undefined);
      }
    }
    let open = this.currLine.indexOf("{"),
      close = this.currLine.indexOf("}");
    while (open >= 0 || close >= 0) {
      if (open >= 0 && (open < close || close < 0)) {
        this.cCodeFolder.push([this.lineNr, open]);
        open = this.currLine.indexOf("{", open + 1);
      } else {
        let idx = this.cCodeFolder.length - 1;
        while (idx >= 0 && this.cCodeFolder[idx].length > 2) idx--;
        if (idx >= 0) this.cCodeFolder[idx].push(this.lineNr, close);
        close = this.currLine.indexOf("}", close + 1);
      }
    }
  }

  AddMultilineComment(startLine: number, endLine: number): void {
    this.multilineComments.push([startLine, endLine]);
    let mComment: string | undefined;
    for (let i = 0; i < this.removedComments.length; i++) {
      const comm = this.removedComments[i];
      if (comm.line === startLine) {
        mComment = comm.value;
        break;
      }
    }
    if (!mComment) return;
    if (mComment.indexOf("$DOC$") < 0) return;
    const lines = mComment.split("\r\n");
    let docInfo: HarbourDocInfo | undefined;
    let lastSpecifyLine: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      if (line.startsWith("$")) {
        lastSpecifyLine = line;
        switch (lastSpecifyLine) {
          case "$DOC$":
            docInfo = {};
            break;
          case "$END$":
            if (docInfo) this.harbourDocs.push(docInfo);
            docInfo = undefined;
            break;
        }
        continue;
      }
      switch (lastSpecifyLine) {
        case "$TEMPLATE$": {
          const currTemplate = line.toLowerCase();
          if (currTemplate === "function" || currTemplate === "procedure") {
            docInfo = {};
            docInfo.label = undefined;
            docInfo.documentation = undefined;
            docInfo.arguments = [];
            docInfo.template = currTemplate;
          }
          break;
        }
        case "$ONELINER$":
          if (docInfo) {
            if (docInfo.documentation) docInfo.documentation += " " + line;
            else docInfo.documentation = line;
          }
          break;
        case "$SYNTAX$":
          if (docInfo) {
            if (docInfo.label) docInfo.label += " " + line;
            else {
              const p = line.indexOf("(");
              if (p < 0) break;
              const name = line.substring(0, p);
              if (name.indexOf(" ") > 0) {
                docInfo = undefined;
                break;
              }
              docInfo.name = name;
              docInfo.label = line;
            }
          }
          break;
        case "$ARGUMENTS$":
          if (docInfo) {
            const ck = /<[^>]+>/;
            const mm = line.match(ck);
            if (!docInfo.arguments) docInfo.arguments = [];
            if (mm) {
              const arg: HarbourArgInfo = {};
              arg.label = mm[0];
              arg.documentation = line;
              docInfo.arguments.push(arg);
            } else if (docInfo.arguments.length > 0) {
              const last = docInfo.arguments[docInfo.arguments.length - 1];
              last.documentation = (last.documentation ?? "") + " " + line;
            }
          }
          break;
        case "$RETURNS$":
          if (docInfo) {
            const ck = /<[^>]+>/;
            const mm = line.match(ck);
            if (mm) {
              const arg: HarbourArgInfo = {};
              arg.name = mm[0];
              arg.help = line.replace(mm[0], "").trim();
              docInfo.return = arg;
            } else if (docInfo.return) {
              docInfo.return.help = (docInfo.return.help ?? "") + " " + line;
            }
          }
          break;
      }
    }
  }

  parse(line: string): void {
    this.lineNr++;
    const wasCont = this.cont;
    const linePP = this.linePP(line);
    if (wasCont) {
      this.clPPArray.push(line);
      this.clArray.push(linePP);
    } else {
      this.clPPArray = [line];
      this.clArray = [linePP];
      this.startLine = this.lineNr;
    }
    if (!this.cMode) this.findDBReferences(linePP);
    if (this.comment || this.pragmaText || this.cont) return;
    this.currLinePreProc = this.clPPArray.join("\r\n");
    this.currLine = this.clArray.join("\r\n");
    if (this.currLine.trim().length === 0) return;
    if (this.firstLineComment >= 0) {
      if (this.firstLineComment < this.startLine - 1)
        this.AddMultilineComment(this.firstLineComment, this.startLine - 1);
      this.firstLineComment = -1;
    }
    if (this.cMode) {
      this.parseC();
      if (this.doGroups) this.updateGroups();
    } else {
      const lines = [this.currLine];
      if (!/^\s*#/.test(this.currLine)) {
        // if does not start with #, see #44
        // split line in its component for example
        // if lCondition ; a+=b ; endif
        this.currLine.split(/;(?!\s+[\r\n])/);
      }
      let pre = "";
      let code = false;
      for (let i = 0; i < lines.length; i++) {
        this.currLine = pre + lines[i];
        const words = this.currLine.replace(/\s+/g, " ").trim().split(" ");
        if (words.length === 0) continue;
        code = true;
        words[0] = words[0].toLowerCase();
        if (this.doGroups) this.updateGroups();
        this.parseHarbour(words);
        pre += " ".repeat(lines[i].length + 1); //add the ; see #44
      }
      if (code && !line.trimStart().startsWith("#"))
        this.lastCodeLine = this.lineNr;
    }
    this.resetComments();
  }

  /**
   * Parse a string
   * @param txt the string to parse
   * @param docName the uri of the file of the incoming text
   * @param cMode if true it is considered a c file (not harbour)
   */
  parseString(txt: string, docName: string, cMode?: boolean): void {
    this.Clear();
    this.currentDocument = docName;
    if (cMode !== undefined) this.cMode = cMode;
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      this.parse(lines[i]);
    }
    this.endParse();
  }

  endParse(): void {
    if (this.currentMethod) this.currentMethod.endLine = this.lastCodeLine;
    this.currentMethod = undefined;
    if (this.firstLineComment > 0 && this.firstLineComment < this.lineNr - 1)
      this.AddMultilineComment(this.firstLineComment, this.lineNr - 1);
    for (let i = 0; i < this.harbourDocs.length; i++) {
      const doc = this.harbourDocs[i];
      if (!doc.name) continue;
      const lCmp = doc.name.toLowerCase();
      for (let j = 0; j < this.funcList.length; j++) {
        const info = this.funcList[j];
        if (info.nameCmp === lCmp) {
          info.hDocIdx = i;
          break;
        }
      }
    }
  }

  /**
   * Parse a file from disc. Async
   * @param file the file to parse, inside the filesystem
   * @param docName the uri of the file to parse
   * @param cMode if true it is considered a c file (not harbour)
   * @param encoding the encoding to use
   * @returns this
   */
  parseFile(
    file: string,
    docName: string,
    cMode?: boolean,
    encoding?: BufferEncoding,
  ): Promise<Provider> {
    this.Clear();
    if (cMode !== undefined) this.cMode = cMode;
    const enc: BufferEncoding = encoding || "utf8";
    this.currentDocument = docName;
    return new Promise<Provider>((resolve) => {
      const reader = readline.createInterface({
        input: fs.createReadStream(file, enc),
      });
      reader.on("line", (d: string) => this.parse(d));
      reader.on("close", () => {
        this.endParse();
        resolve(this);
      });
    });
  }

  findDBReferences(line: string): void {
    const charRegEx = /[a-z0-9_\(\)]/;
    const wordRegEx = /\b([a-z_][a-z0-9_]*)\s*([^a-z0-9_]*)/gi;
    let match: RegExpExecArray | null;
    let dbName: string | undefined;
    if (/^\s*#/.test(this.currLine)) {
      // don't parse pre proc
      if (this.currLine.indexOf("=>") < 0) return;
      const arrow = line.indexOf("=>");
      if (arrow >= 0) {
        line = " ".repeat(arrow + 2) + line.substr(arrow + 2);
      }
    }
    let prevWord: string;
    let cmpName = "";
    while ((match = wordRegEx.exec(line))) {
      prevWord = cmpName;
      const prevC = match.index > 0 ? line[match.index - 1] : "";
      if (match[2][0] === "." && prevC === ".")
        // logical keyword
        continue;
      if (match[2][0] === ">" && prevC === "<")
        // command keyword
        continue;
      if (prevC === "#") continue; //preproc line
      let type: ReferenceType = prevC === ":" ? "data" : "variable";
      cmpName = match[1].toLowerCase();
      if (keywords.indexOf(cmpName) >= 0) continue;
      if (match[2][0] === "(") type = prevC === ":" ? "method" : "function";
      else if (dbName) {
        const dbCmd = dbName.toLowerCase();
        if (dbCmd !== "field") {
          if (!this.databases[dbCmd])
            this.databases[dbCmd] = { name: dbName, fields: {} };
          if (!this.databases[dbCmd].fields[dbCmd]) {
            this.databases[dbCmd].fields[cmpName] = match[1];
          }
        }
        type = "field";
        dbName = "";
      }
      if (prevWord.startsWith("func") || prevWord.startsWith("proc"))
        type = "function";
      if (prevWord === "method") type = "method";
      if (prevWord === "access" || prevWord === "assign" || prevWord === "data")
        type = "data";

      if (match[2].endsWith("->")) {
        const pos = match.index + match[0].length - 3;
        let pdb = pos;
        let nBracket = 0;
        while ((line[pdb] === " " || line[pdb] === "\t") && pdb > 0) pdb--;
        while (nBracket > 0 || charRegEx.test(line[pdb])) {
          const c = line[pdb];
          pdb--;
          if (pdb === -1) break;
          if (c === ")") nBracket++;
          if (c === "(") {
            if (nBracket === 0) {
              pdb++;
              break;
            }
            nBracket--;
          }
        }
        dbName = line.substring(pdb + 1, pos + 1).replace(/\s+/g, "");
      }
      if (cmpName) {
        if (!this.references[cmpName]) {
          this.references[cmpName] = [];
        }
        if (Array.isArray(this.references[cmpName]))
          this.references[cmpName].push(
            new reference(type, this.lineNr, match.index, match[1]),
          );
      }
    }
  }

  updateGroups(): void {
    let checkString = this.currLine.toLowerCase();
    const pos = checkString.length - checkString.trimLeft().length;
    checkString = checkString.substr(pos);
    const ln = this.startLine;
    if (!this.cMode)
      GroupManagement(
        this.groups,
        this.groupStack,
        group_keywords,
        checkString,
        pos,
        ln,
      );
    GroupManagement(
      this.preprocGroups,
      this.preprocGroupStack,
      preproc_keywords,
      checkString,
      pos,
      ln,
    );
  }
}

function CommandSplitDefinition(definePart: string): CommandPart[] | undefined {
  const commandResult: CommandPart[] = [];
  // SplitDefinePart
  let pos = 0;
  while (pos < definePart.length) {
    while (
      pos < definePart.length &&
      [" ", "\t", "\r", "\n"].indexOf(definePart.charAt(pos)) >= 0
    )
      pos++;
    const nextChar = definePart.charAt(pos);
    let end: number;
    if (nextChar === "[") {
      end = definePart.indexOf("]", pos);
      if (end < 0) return undefined; // incomplete
      const open = definePart.indexOf("[", pos + 1);
      if (open < end && open > pos) {
        let nPar = 2;
        end = open + 1;
        while (nPar !== 0 && end < definePart.length) {
          switch (definePart.charAt(end)) {
            case "[":
              nPar++;
              break;
            case "]":
              nPar--;
              break;
          }
          end++;
        }
        if (end === definePart.length) return undefined; // incomplete
        end--;
      }
      commandResult.push({
        text: definePart.substring(pos + 1, end),
        fixed: false,
      });
      pos = end + 1;
      continue;
    }
    end = definePart.indexOf("[", pos);
    if (end >= 0) {
      commandResult.push({ text: definePart.substring(pos, end), fixed: true });
      pos = end;
      continue;
    } else {
      if (pos < definePart.length)
        commandResult.push({ text: definePart.substring(pos), fixed: true });
      break;
    }
  }
  return commandResult;
}

function CommandPartToRegex(text: string): RegExp | undefined {
  const firstVar = /\s*<([^>]+)>\s*/.exec(text);
  // it is only variable, then no regex.
  if (firstVar && firstVar[0] === text) return undefined;
  let pattern: string;
  // https://stackoverflow.com/a/3561711/854279
  // escape all control characters
  pattern = text.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  pattern = pattern.replace(/\s+/g, "\\s*");
  pattern = pattern.replace(/<[^>]+>/g, ".*");
  return new RegExp(pattern, "i");
}

function CommandPartToSnippet(
  text: string,
  fixed: boolean,
  resultPart: string,
): { snippet: string; repeatable: boolean } | undefined {
  let snippet = text;
  let repeatable = !fixed;
  const variableRegEx = /<!?([^!>]+)!?>/;
  let idx = 1;
  let match: RegExpExecArray | null;
  while ((match = variableRegEx.exec(snippet))) {
    let currVar = match[1];
    const colonPos = currVar.indexOf(":");
    let snippetPart = "${" + idx;
    if (colonPos < 0) {
      currVar = currVar.trim().replace(/,\s*\.\.\./, "");
      snippetPart += ":" + currVar;
    } else {
      const names = currVar.substr(colonPos + 1).split(",");
      for (let i = 0; i < names.length; i++) {
        snippetPart += `|${names[i].trim()}`;
      }
      currVar = currVar.substring(0, colonPos).trim();
    }
    if (repeatable) {
      let resMatch: RegExpExecArray | null;
      currVar = currVar.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
      const varRegEx = new RegExp(
        "(\\[[^\\]]*)?<.?\\b" + currVar + "\\b.?>",
        "ig",
      );
      while (repeatable && (resMatch = varRegEx.exec(resultPart))) {
        repeatable = repeatable && Boolean(resMatch[1]);
      }
    }
    snippetPart += "}";
    snippet = snippet.replace(match[0], snippetPart);
    idx++;
  }
  return { snippet, repeatable };
}

// every group is an array (TODO class?)
// 0 is name, 1 is start keyword, (2...n-2) middle keyword, (n-1) last keyword
const group_keywords: Array<Array<string | RegExp>> = [
  ["if", "if", /else(?:if)?\b/, /end(?:\b|\s*if\b)/],
  ["for", /for(?:\s+each)?\b/, "loop", "exit", "next"],
  [
    "case",
    /(switch|do\s+case)\b/,
    "case",
    "otherwise",
    "default",
    "exit",
    /end\s*(?:switch|case)?\b/,
  ],
  ["while", /(?:do\s*)?while\b/, "loop", "exit", /end(?:\b|\s*do\b)/],
  ["try", "try", "catch", /end(?:\s*do)?\b/],
  ["sequence", /begin\s+sequence\b/, "recover", /end(?:\s*sequence)?\b/],
  ["dump", /#pragma\s+begindump\b/, /#pragma\s+enddump/],
];
//it can be mixed with other groups
const preproc_keywords: Array<Array<string | RegExp>> = [
  ["#if", /#if(?:n?def)?\b/, /#else(?:if)?\b/, /#end\s*(?:if)?\b/],
];

function removeStrings(kwGroups: Array<Array<string | RegExp>>): void {
  for (let i = 0; i < kwGroups.length; ++i)
    for (let j = 1; j < kwGroups[i].length; ++j)
      if (typeof kwGroups[i][j] === "string") {
        kwGroups[i][j] = new RegExp((kwGroups[i][j] as string) + "\\b");
      }
}
removeStrings(group_keywords);
//removeStrings(preproc_keywords);

/**
 * @param dest destination array of found groups
 * @param destStack destination array of pending groups
 * @param keywords array of groups keywords
 * @param checkString string to check, already trimmed at start and converted to lowercase
 * @param pos number of trimmed character at start
 * @param lineNr current line number
 */
function GroupManagement(
  dest: Group[],
  destStack: Group[],
  keywords: Array<Array<string | RegExp>>,
  checkString: string,
  pos: number,
  lineNr: number,
): void {
  let currKeywords: Array<string | RegExp> | undefined;
  let currGroup: Group;
  // looking for new group start
  for (let i = 0; i < keywords.length; i++) {
    let m: RegExpMatchArray | null;
    if ((m = checkString.match(keywords[i][1])) && m.index === 0) {
      currGroup = new Group(keywords[i][0] as string);
      // put it on pending
      destStack.push(currGroup);
      currGroup.addRange(lineNr, pos, pos + m[0].length, m);
      return;
    }
  }
  // looking for pending group, starting from the last opened
  for (let j = destStack.length - 1; j >= 0; j--) {
    currGroup = destStack[j];
    // find the current examined group keyword list
    currKeywords = keywords.find((v) => v[0] === currGroup.type);
    if (!currKeywords) continue;
    for (let i = 2; i < currKeywords.length; i++) {
      let m: RegExpMatchArray | null;
      if ((m = checkString.match(currKeywords[i])) && m.index === 0) {
        currGroup.addRange(lineNr, pos, pos + m[0].length, m);
        if (i === currKeywords.length - 1) {
          // the last keyword close the group
          // pop from pending push on found
          const popped = destStack.pop();
          if (popped) dest.push(popped);
        }
        return;
      }
    }
  }
}
