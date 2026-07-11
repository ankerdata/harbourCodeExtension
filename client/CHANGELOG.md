# Change Log
All notable changes to the "Harbour and xHarbour" extension will be documented in this file.

# 1.2.1
 - **Debugger (dbg_lib)** fixed a breakpoint on the **first executable line of a function** never firing. A thread parks on that line while it performs the debug-server handshake, and the client sends the breakpoint set followed by `GO` while it sits there; `CheckSocket` honoured the `GO` and returned *before* reaching its `inBreakpoint()` test, so the parked line was consumed without ever being compared against the breakpoints that had just been installed on it. `CheckSocket` now tests the parked line once, on the call that completed the handshake, before honouring the `GO`. Breakpoints on the `FUNCTION`/`PROCEDURE` header line are fixed too, since those resolve forward onto the first executable line. This affected **both worker threads and the main thread**:
   - `hb_threadStart( @thFunc() )` workers ran straight past a breakpoint set at the top of `thFunc` — a worker *always* parks on its thread function's first executable line, so such a breakpoint could never be hit.
   - Single-threaded programs were affected whenever no `LOCAL` declaration preceded the breakpoint. A `LOCAL` is itself a stop line, so `main()` usually parks on *it* and the breakpoint below is safely downstream — which is why the failure looked intermittent ("sometimes it stops, sometimes it doesn't") and why inserting an `AltD()` before the line appeared to fix it: it merely gives `main()` an earlier line to park on. No `AltD()` is needed any more.

   **Users shipping their own compiled `dbg_lib` need to rebuild it** (run "Harbour: Get debugger code" to fetch the updated `extra/dbg_lib.prg`). Part of #46.
 - **Debugger** fixed the adapter recording a breakpoint's acknowledgement *on top of* the breakpoint itself, which silently broke two things. `breakpoints[src][line]` holds that breakpoint's wire command, and `processBreak` overwrote the slot with the number `1` once the runtime ACKed it — but every other reader of that slot assumes it stays a string:
   - **Breakpoints never fired in any non-main thread.** `currentBreakpointsMessage()` (the replay `acceptThreadSocket` sends to a newly-connected worker) skips non-string entries. Main ACKs its breakpoints within milliseconds of launch, long before any worker spawns, so the replay was **empty in every real session** and workers ran with no breakpoints at all. This means the replay-on-connect added in 1.1.3 never actually worked; its tests exercised the pre-ACK state and so passed.
   - **Removing a breakpoint didn't remove it.** `setBreakPointsRequest`'s tombstone loop also only marks string-valued slots, so an ACKed breakpoint could never be marked for removal, the `-:src:line` command was never sent, and a breakpoint deleted in the editor kept firing in the runtime.

   Ack state now lives beside the wire command in a separate `ackedLines` map rather than on top of it, and `number` is gone from `BreakpointSource`'s value union so the overloading can't return. Closes #46.
 - **Debugger (dbg_lib)** fixed **editing a breakpoint's condition permanently disabling that breakpoint**. `setBreakpoint` *appended* a re-sent line's condition / hit-count / logpoint extras instead of replacing them, and `inBreakpoint()` requires **every** `?` extra to hold. The client re-sends `+` for a line whenever its breakpoint changes — that is how a condition is edited or cleared — so changing a condition from `a` to `b` left both in force, and since they are typically mutually exclusive the breakpoint could never fire again. Clearing a condition likewise left the old one installed, so the breakpoint stayed silently conditional. Re-setting a line now truncates its extras first, which also resets hit counters (what a re-set should do anyway). This is the "conditional breakpoints do not seem to work, at least not all the time" report — setting a condition *once* always worked, which is why it looked intermittent. Closes #47.
 - **Tests** added 12 tests. Breakpoint state across the runtime's ACK: replay to a late-connecting worker (including its condition and hit count), un-setting an ACKed breakpoint, keeping unchanged breakpoints across a re-set, not replaying a removal that's still in flight, and broadcasting the un-set to every live thread — six of these fail against the previous code. Plus conditional / hit-count / logpoint wire encoding: colon escaping, re-send on condition edit, re-send plain on condition clear, and no re-send when unchanged.

# 1.2.0
 - **Language server** added **Rename Symbol** support (<kbd>F2</kbd>) — `renameProvider` with `prepareProvider`, implementing `textDocument/prepareRename` and `textDocument/rename`. Renaming a function, procedure, method, class `DATA` member, local or parameter rewrites every occurrence in one edit. Scope is honoured: workspace-wide functions/procedures/methods/data members rename across every file; module-static functions (`STATIC FUNCTION`) and routine `LOCAL`/`PARAM`/`STATIC` variables stay confined to their own file and routine. `prepareRename` refuses keywords and Harbour built-ins / stdlib functions (whose definitions live outside the workspace and so can't be consistently rewritten), and `rename` rejects new names that aren't valid Harbour identifiers. Implements APerricone/harbourCodeExtension's long-standing rename feature request.
 - **Language server** fixed *Find All References* (and therefore the new rename) silently returning nothing for a **same-file procedure**: occurrences are bucketed by reference type (`function`/`variable`/`data`/`method`/`field`), but the old code compared them against the raw symbol kind, so a `PROCEDURE Foo` defined in the same file (kind `procedure`) never matched its own `Foo()` call sites (type `function`). A new `kindToRefType` mapping bridges symbol kinds to reference buckets.
 - **Language server** the parser now recognises `THREAD STATIC` / `THREAD LOCAL` declarations by stripping the leading `thread` qualifier, so the symbol is recorded and scoped like a plain `STATIC`/`LOCAL`. Previously the `thread` keyword hid the declaration entirely, which made the variable look global — rename leaked it across the whole workspace, and definition/hover/references missed it too. Benefits every symbol feature, not just rename.
 - **Language server** rename now resolves a symbol's scope against a full re-parse of the live buffer instead of the cached workspace-scan provider. The scan stores light-mode providers that can lag the editor until an unrelated edit triggers a full re-parse, which made a freshly-opened file's `STATIC PROCEDURE` intermittently report "The element can't be renamed" (its own definition wasn't resolvable, so `prepareRename` refused) and then start working after any edit.
 - **Language server** fixed a `GetWord` off-by-window bug where the computed symbol offset was shifted left for identifiers near the very start of a file (`pos - delta` instead of `Math.max(pos - delta, 0)`). This made `prepareRename` hand VS Code a range that didn't cover the cursor, so renaming e.g. a `STATIC PROCEDURE` declared on the first lines failed with "The element can't be renamed."
 - **Internal** extracted the shared scope-resolution / occurrence-collection engine into `server/src/rename.ts` (pure, no dependency on the live document set) so References and Rename can't drift apart, and added `server/test/rename.test.ts` (17 tests) covering function/procedure/method/data/local/param and file-static (incl. `THREAD STATIC`) scoping, cross-file collection, case-insensitive rewriting, and built-in rejection.

# 1.1.3
 - **Debugger** fixed multi-threaded debugging UX where hitting a breakpoint on a non-main thread silently paused the main thread "wherever it happens to be," stepping the breakpoint thread also stepped main, and VS Code's focus ricocheted between threads. Two adapter-side bugs made MT debugging feel like an all-stop debugger even though the runtime was per-thread since 1.1.0: `StoppedEvent.allThreadsStopped` was never set (VS Code's UI fell into all-stop semantics) and `ContinueResponse.body.allThreadsContinued` was unset (DAP-spec default `true` told VS Code every thread continued, so it re-snapshotted unrelated threads on the next stop). Now every `StoppedEvent` carries `allThreadsStopped: false` and every `ContinueResponse` carries `allThreadsContinued: false`. Part of #34.
 - **Debugger** main and every worker thread no longer halts on their first executed line. The adapter sends an auto-`GO` and arms a one-shot swallow on every newly-connected non-main thread (in `acceptThreadSocket`) and on main (in `configurationDoneRequest`), so dbg_lib's `CheckSocket` sleep+`STOP:step` race — which surfaces as a phantom "stopped on first line" pause — is silently absorbed. Threads now run silently until they hit a breakpoint or a runtime error, matching what users expect from VS Code's MT debugging UX. The `stopOnEntry` launch.json flag is a deprecated no-op for the same reason. Set a breakpoint at the start of `main()` if you want the old pause-on-entry behaviour. Part of #34.
 - **Debugger** `configurationDoneRequest`'s `ContinuedEvent` now carries `allThreadsContinued: false` (was implicitly `true`). Workers that connect concurrently with main were being misclassified as "running" by the client and re-snapshotted on their first stop, contributing to the stop/continue UX confusion fixed elsewhere in this release.
 - **Debugger** unexpected non-main thread socket close is now surfaced as a stderr `OutputEvent` ("Thread N (name) exited (socket closed)") so users get a visible signal when a worker dies mid-debug instead of silent hangs. Part of #34.
 - **Debugger** stopped emitting a synthetic `invalidated` event after every `StoppedEvent`. Per the DAP spec, "debug adapters do not have to emit this event for runtime changes like stopped or thread events because in that case the client refetches the new state anyway." The redundant event triggered "No event handler" warnings in clients that don't support invalidated (notably nvim-dap) and was implicated in adapter-exit timeouts when those clients silently dropped subsequent requests. VS Code already refreshes panes on `stopped`, so behaviour there is unchanged.
 - **Debugger** breakpoints and exception filters now reach every live worker thread, not just main. The runtime stores `aBreaks` / `errorType` per-thread (HB_TSD_NEW since 1.1.0), but the adapter was sending `BREAKPOINT` / `ERRORTYPE` only to `currentThread` (== mainThread by default), so workers ran with empty `aBreaks` and breakpoints set in the editor silently never fired in any non-main thread. Fixed in two ways: `setBreakPointsRequest` and `setExceptionBreakPointsRequest` now broadcast the delta to every live thread; `acceptThreadSocket` replays the full current breakpoint set + last-broadcast `ERRORTYPE` to a newly-connected worker before its auto-`GO` so it can't run past a breakpoint that was set before it spawned. Part of #34.
 - **Debugger (dbg_lib)** fixed module-level statics being invisible from non-main threads' debug evaluation context (Watch panel returned "Variable does not exist," Statics panel was missing entries). Root cause: the 1.1.0 `HB_TSD_NEW` change moved `t_oDebugInfo` to per-thread storage, which inadvertently scoped `aModules` (the module-name → line-bitmap + module-static-metadata table) per-thread too — even though `_INITSTATICS` / `_INITLINES` only run in main at startup, so worker threads' `aModules` stayed empty forever. `aModules` is now backed by a process-wide `s_pSharedModules` `PHB_ITEM` exposed via a new `__DBG_SHAREDMODULES()` C function, restoring cross-thread visibility without giving up per-thread isolation for the rest of the debug state. **Users shipping their own compiled `dbg_lib` need to rebuild it** (run "Harbour: Get debugger code" to fetch the updated `extra/dbg_lib.prg`). Closes #34.
 - **Tests** added 3 tests pinning the corrected `StoppedEvent` / `ContinueResponse` shape; added auto-GO + race-window swallow tests for the new worker-thread bootstrap path

# 1.1.2
 - **Debugger** completed multi-threaded debugging by routing variable inspection per-thread. `scopesRequest`, `evaluateRequest`, and `variablesRequest` don't carry `args.threadId` — they identify their target via the opaque `frameId` / `variablesReference` returned by previous requests. Those ids now encode the owning thread: `sendStack` allocates a global frame id per emitted frame and stores `{thread, localFrameIdx}` in a session registry; `sendScope` and `getVarReference` do the same for variables references. The variable-inspection handlers look up the registry, pivot dispatch onto the originating thread's socket, and use that thread's `currentStack` — so the Variables panel for a stopped non-main thread now shows that thread's locals/statics, and `Evaluate` from a non-main frame uses that thread's stack. Closes #29.
 - **Tests** added 9 round-trip tests asserting frame ids and variable refs allocated on a non-main thread route back to that thread (and never bleed into the main thread)

# 1.1.1
 - **Debugger** fixed F5 silently failing to launch the debug adapter on win32-arm64. VS Code's default resolution of the `runtime: node` declared in the `debuggers` contribution silently fails to find `node` in the debug-adapter spawn environment on that platform, producing no status-bar change, no spawn, and no error. The extension now registers an explicit `DebugAdapterDescriptorFactory` that returns `process.execPath` (Code.exe, which Electron runs in node mode for this entrypoint) so the adapter spawn no longer depends on PATH lookup. Also wires up `debugProvider.activate()` (the file was added in 1.0.11 but never activated), passes the user's launch config through `resolveDebugConfiguration` unchanged instead of overwriting it with a stub, and adds `onDebugResolve:harbour-dbg` as an activation event. Closes #31.

# 1.1.0
 - **Debugger** multi-threaded debugging support — each Harbour thread of an MT program now appears as its own thread in VS Code's Call Stack panel with independent stop/continue/step control. `dbg_lib.prg` makes `__DEBUGITEM()` per-thread via `HB_TSD_NEW` (Harbour 3.2+; xHarbour and pre-3.2 fall back to the original single-thread global). The client accepts multiple Harbour socket connections, allocates a `ThreadState` per connection, and emits `ThreadEvent('started'/'exited')` on connect/disconnect. Control requests (`continue`/`next`/`stepIn`/`stepOut`/`pause`/`stackTrace`) route by `args.threadId`. Variable inspection (scopes/evaluate/variables) still routes to the main thread — see follow-up issue for per-thread variable routing.
 - **Tests** added integration coverage for two-thread handshake, per-thread stop events, ThreadEvent lifecycle, and pid-mismatch rejection
 - **Internal** `harbourDebugSession` mutable state extracted into a per-thread `ThreadState` class with `Map<number, ThreadState>` keyed by harbour thread id

# 1.0.11
 - **Client** migrated to TypeScript with `strictNullChecks` for stronger compile-time safety; esbuild compiles `.ts` directly so the shipped bundle is byte-equivalent
 - **Tests** added a Jest test suite under `client/test/` covering the debugger expression evaluator — `processExpression` line parsing, `getVariableFormat` for each Harbour type (`A`/`H`/`O`/scalars/`E`/`B`/`P`), and `evaluateName` construction including regression coverage for the colon-string and nested-array fixes shipped in 1.0.8
 - **CI** client typecheck and tests now run on every push and PR across Linux and Windows

# 1.0.10
 - **Server** fixed go-to-definition and hover landing in the `.c` files emitted by the Harbour→C compiler instead of the original `.prg` source; the workspace scan now detects generated artefacts via the `Generated C source from` header comment and `HB_INIT_SYMBOLS_BEGIN` / `HB_FUNC_INITSTATICS` / `HB_FUNC_INITLINES` macros and skips them. Hand-written companion `.c` files and `#pragma BEGINDUMP` blocks are still indexed, preserving go-to-definition for symbols that are only defined in C.
 - **Tests** added unit tests and fixtures for the new `workspaceScan` predicate covering generated, hand-written, and edge-case inputs

# 1.0.9
 - **Server** migrated to TypeScript with `strictNullChecks` for stronger compile-time safety; esbuild compiles `.ts` directly so the shipped bundle is byte-equivalent
 - **Server** fixed duplicate references and definitions when an LSP client sends a different URI form than the server synthesizes (surfaced on Windows + Neovim, where the client used `file:///C:/foo` while the server used `file:///c%3A/foo`); all URIs are now canonicalized at every entry point
 - **Tests** added a Jest test suite under `server/test/` covering parser output for representative `.prg` fixtures, definition lookup, hover data, and semantic-token computation
 - **CI** server tests now run on every push and PR across Linux and Windows
 - **Tests** removed the broken `server/test_parse.js` one-off harness in favour of the new suite

# 1.0.8
 - **Server** auto-detect LSP transport (IPC for VSCode, stdio for Neovim and other clients) so the same server binary works in both editors
 - **Server** parse the workspace on `initialized` when no `didChangeConfiguration` arrives, so go-to-definition works under clients that do not push configuration (e.g. Neovim)
 - **Server** richer hover for functions, procedures, methods, classes, locals and standard-library symbols, including parameter lists and `$DOC$` documentation
 - **Server** `onDidChangeConfiguration` is now defensive against partial settings payloads
 - **Server** `SemanticTokensRequest` returns the spec-compliant `{ data: [] }` instead of `[]` for unknown documents
 - **Debugger** support `invalidatedEvent` from the runtime
 - **Debugger** fix nested-array evaluation in watches and locals
 - **Debugger** fix string evaluation when the value contains a colon
 - **Debugger** fix locals/watch errors when values are nil

# 1.0.7
 - **Server** fixed completion on trigger character
 - **Debugger** fixed start on non-windows system [#87](https://github.com/APerricone/harbourCodeExtension/issues/86)


# 1.0.6
 - **Server** better classData, classVar, classMethod support
 - **Syntax** better classData, classVar, classMethod support
 - **Debugger** better handshake

# 1.0.5
 - **Server** Added classData, classVar, classMethod support [#86](https://github.com/APerricone/harbourCodeExtension/issues/86)
 - **Syntax** Added classData, classVar, classMethod support
 - **Validation** Better Ambiguous reference support [#85](https://github.com/APerricone/harbourCodeExtension/issues/85)

# 1.0.4
 - **Debugger** Added messages in case of early exit [#84](https://github.com/APerricone/harbourCodeExtension/issues/84)
 - **Debugger** Added wapi_OutputDebugString/hb_OutDebug support on windows using [@yagisumi/win-output-debug-string](https://github.com/yagisumi/node-win-output-debug-string)
 - **Sever** Added some documented in not-standard way functions and procedures

# 1.0.3
 - **Server** fixed some formatter behaviour
 - **Debugger** better completition

# 1.0.2
  - **Debugger** Added workareas
  - **Server** first version of formatter
  - **Client** added code style configurator

# 1.0.1
 - **server** fixed table name reader [#73](https://github.com/APerricone/harbourCodeExtension/issues/73)
 - **server** better go to declarection [#74](https://github.com/APerricone/harbourCodeExtension/issues/74)

# 1.0.0
 - **server** fixed crash [#70](https://github.com/APerricone/harbourCodeExtension/issues/70)

# 0.9.16
 - **server** fixed crash on space before -> [#69](https://github.com/APerricone/harbourCodeExtension/issues/69)

# 0.9.15
 - **server** fixed freeze looking for references last word of the file
 - **server** even better performance on long splitted line [#68](https://github.com/APerricone/harbourCodeExtension/issues/68) (the sample file come from 1.7sec to 0.17 on my PC)

# 0.9.14
 - **server** better performance on long splitted line [#68](https://github.com/APerricone/harbourCodeExtension/issues/68)
 - **server** first support for [semantic token](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)
 - **server** first support for "[find all references](https://code.visualstudio.com/api/language-extensions/programmatic-language-features#find-all-references-to-a-symbol)"
 - **validation** hightlight of unused symbol
 - **syntax** added shared keyword [#64](https://github.com/APerricone/harbourCodeExtension/issues/64)

# 0.9.13
 - **debugger** better stability

# 0.9.12
 - **debugger** better stability
 - **task** better stability
 - **task** correct management of batch option

# 0.9.11
 - **server** fixes case of unfound parent [#57](https://github.com/APerricone/harbourCodeExtension/issues/57)
 - **syntax** fixes [memvar aliasing syntax highlighting #58](https://github.com/APerricone/harbourCodeExtension/issues/58),
    [Multiline "inline" class methods syntax highlighting #59](https://github.com/APerricone/harbourCodeExtension/issues/59),
    [Try catch syntax highlighting #60](https://github.com/APerricone/harbourCodeExtension/issues/60) by [Edgard Lorraine Messias](https://github.com/edgardmessias)
 - **debugger** better step out and step next support
 - **server** better code folding see [#56](https://github.com/APerricone/harbourCodeExtension/issues/56)
 - **task** added temporary variable solver waiting for [VSCode #81007](https://github.com/microsoft/vscode/issues/81007)

 Many thanks to [Seth Hovestol](https://github.com/Hovestar) for bug reporting

# 0.9.10
 - **debugger** added process list on attach, attach by process Id
 - **task** added Harbour and HBMK2 tasks, BETA
 - **server** added completition and go to definition on #pragma include [#45](https://github.com/APerricone/harbourCodeExtension/issues/45)
 - **syntax** better operator and keyworld list
 - **debugger** better filename uppercase/lowercase check using external library
 - **general** updated used libraries

# 0.9.9
 - **server** fixed error message "cannot read property" [#43](https://github.com/APerricone/harbourCodeExtension/issues/43)
 - **server** restored define "go to definition"
 - **validation** trying to solve problem of wrong file name

# 0.9.8
 - fix crash

# 0.9.7
 - missing files

# 0.9.6
 - **server** [better outline and breadcump](https://github.com/APerricone/harbourCodeExtension/raw/master/images/0_9_6.png)
 - **debugger** fixed compilation with xHarbour, see #38
 - **server** better group nearest support
 - **syntax** fixed classdata syntax highlight
 - **server** better define support
 - **server** better "case" folding
 - **decorator** use of editorBracketMatch colors

# 0.9.5
 - **debugger** resolved breakpoint invalid on far source, fix ([#35](https://github.com/APerricone/harbourCodeExtension/issues/35))
 - **debugger** resolved file not found on relative path, fix ([#36](https://github.com/APerricone/harbourCodeExtension/issues/36))

# 0.9.4
 - **server** added Folder provider
 - **decorator** use of server
 - **server** better performance, stability + some fixes ([#32](https://github.com/APerricone/harbourCodeExtension/issues/32))
 - **syntax** minor fixes
 - **server** Added harbourDoc support
 - **client** Added auto harbourDoc generation on **/&ast; $DOC$**

# 0.9.3
 - **server** fixed wordBasedSuggestions for methods and fields
 - **debugger** added ATTACH support
 - **debugger** better stack format
 - **debugger** better management of eval error

# 0.9.2
 - **server** speed-up completition
 - **server** use of editor.wordBasedSuggestions setting
 - **syntax** Fixed multiline string on screen (aka TEXT/ENDTEXT)

# 0.9.1
 - **server** Fix error pressing CTRL on empty space [#28](https://github.com/APerricone/harbourCodeExtension/issues/28)
 - **syntax** Fixed multiline string on screen (aka TEXT/ENDTEXT)

# 0.9.0
 - **server** add hover for defines
 - **syntax** a lot of fixes by [Edgard Lorraine Messias](https://github.com/edgardmessias)
 - **server** added information about class during completition

# 0.8.12
 - **debugger** Added options for error management
 - **server** Fix some crash
 - **syntax** use of [Edgard Lorraine Messias](https://github.com/edgardmessias) syntax
 - **server** Fixed deletion of wrong fields

# 0.8.10 - 0.8.11
  - restored files

# 0.8.9
 - **server** Fix some crash

# 0.8.8
 - **server** New incude file management
 - **server** Added word based suggestions [#16](https://github.com/APerricone/harbourCodeExtension/issues/16)
 - **server** Added keyword suggestions
 - **debugger** Added support for multiline string
 - **debugger** Added terminalType option
 - **debugger** Added handshake
 - **server** Added define on complettion and definition
 - **server** Added public and data in go to workspace symbol
 - **debugger** fix statics in some conditions

# 0.8.7
 - **server** Added check if C file is a compiled prg [#12](https://github.com/APerricone/harbourCodeExtension/issues/12)
 - **server** Removed unused code to avoid performance issues
 - **validation** correct working dir

# 0.8.6
 - **server** added workspaceDepth to fix [#11](https://github.com/APerricone/harbourCodeExtension/issues/11)
 - **server** changed behaviour of search inside symbols, to match VSCode behaviour.
 - **server** fix name of member all lowercase
 - **server** better field management on completition
 - **server** better word match
 - **server** better database management
 - **validation** Better support for relative include path

## 0.8.5
  - **decorator**  restored correct behaviour
  - **server** use of DocumentSymbol
  - **server** removed current word from completition
  - **debugger** fixed crash on expression with colon

## 0.8.4
  - **Server** fixed crash on completition

## 0.8.3
 - **Server** added completition and goto definition on include
 - **Server** fixed crash on completition on beginning of file
 - **Server** removed duplicated completitionItem
 - **Server** fixed static management on completition
 - **Server** fixed link show on onDefinition for files

## 0.8.2
 - **Code** added some snippets
 - **Icon** changed icon
 - **Server** fix crash in case of file outside a workspace

## 0.8.1
 - **server** Added missing file

## 0.8.0
 - **syntax hightlight**: [management of command/translate directive](https://github.com/APerricone/harbourCodeExtension/raw/master/images/command.png)
 - **syntax hightlight**: added abbreviations for local, public, private, etc
 - **server** Added field management
 - **server** Added completition support
 - **server** on workspace symbol you can search a object method adding colon.

## 0.7.9
 - **Server**: [Added multi workspace support](https://github.com/APerricone/harbourCodeExtension/issues/9)
 - **Debugger**: Added completition support (beta)
 - **Server**: better support on no-workspace environment.
 - **Server**: Fixed gotoDefinition for long names
 - **Debugger**: fixed management of access/assign class data.

## 0.7.8
 - **Server**: show comment before function declaration as help
 - **Debugger**: [Added support for copy expression, copy value and add to watch](https://github.com/APerricone/harbourCodeExtension/wiki/Debugger#copy-expression).
 - **Debugger**: Changed view of date and time value on xHarbour to use a valid xHarbour format.

## 0.7.7
 - **Debugger**: Added beta xHarbour support
 - **Debugger**: Fixed case when the module name contains colon
 - **Debugger**: Fixed Log message without carriage return
 - **syntax hightlight**: simplified datetime regex
 - **syntax hightlight**: better 'for' support
 - **syntax hightlight**: added keywords

## 0.7.6
 - **syntax hightlight**: fix for datetime constant
 - **syntax hightlight**: allow min #pragma and macro for inline multiline string
 - **validation**: added validation of opened file
 - **syntax hightlight**: added __streaminclude syntax and fix __stream syntax
 - **decorator**: removed harbour decorator in not-harbour files.

## 0.7.5
 - Added **localization**: English, Italian and Spanish (thanks to José Luis Sánchez for review)

## 0.7.4
 - **Debugger**: added sourcePaths in debugger, to allow to specify more than one directory with code.

## 0.7.3
 - **Fix**: Get debugger code on linux and mac

## 0.7.2
 - **Syntax**: fixed text/endtext

## 0.7.1
 - **Debugger**: Better support for conditional breakpoint and hit count breakoint
 - **Syntax**: Added TEXT/ENDTEXT

## 0.7.0
 - **Debugger**: [beta] added interception of error
 - **Debugger**: Better support for statics.

## 0.6.9
 - **Debugger**: fixed crash adding/removing breakpoints when the program running
 - **Debugger**: fixed freeze starting debug program without debugger
 - **Validator**: fixed "invalid filename" error in validation

## 0.6.8
 - **Added command**: "Harbour: Get debugger code"
 - **Debugger**: fixed startOnEntry = false
 - **Debugger**: Added support for conditional breakpoint, hit count breakoint and LogPoint


## 0.6.7
 - added setting to disable the decorator
 - better decorator code

## 0.6.6
 - enabled **decorator** (marks correspondent if, else, endif, for, next ect ect), BETA.
 - **Fix**ed stall on signature request

## 0.6.5
 - **Server**: parse c file searching harbour function
 - **Fix**: crash on signature for static proc/func

## 0.6.4
 - **Fix**: arguments counting when lone bracket are presents inside string

## 0.6.3
 - **Fix**ed debugger

## 0.6.2
 - **Fix**ed server

## 0.6.1
 -  **Fix**ed arguments counting when commas are presents inside string or inside curly or squared brackets
 - Added message when unable to start the executable on **debug**ging

## 0.6.0
 - Added signature for 342 standard procedure
 - Manage of special case of New
 - Fixed debugger.js on new node/code versions
 - Better validator support for executables

## 0.5.11
- Fixed debugger expression managing
- Added problem matcher for harbour

## 0.5.10
- Fixed crash on server in particular case

## 0.5.9
- Fixed signature help on method and on multiline declaration
- Added looking on sub folder for workspace symbol

## 0.5.8
- Added support for Signature help

## 0.5.7
- Fixed public and private hash and array watch (Thanks to Lailton Fernando Mariano for found the bug)
- Added support for non string hash keys
- removed "Globals" and "Externals" scope until they are not supported.

**need recompile the library from test\dbg_lib.prg**

## 0.5.6
- minor fixes on syntax

## 0.5.5
- added support for multiline text using #pragma

## 0.5.4
- added debugger initial configuration to allow creation of launch.json with harbour
- minor fixes on tmlanguage.

## 0.5.3
- **validation**: added harbour.extraOptions to send extra options to harbour compiler.

## 0.5.2
- **debugger**: better support for object expression, need recompile the library from test\dbg_lib.prg

## 0.5.1
- minimal optimization on debugger

## 0.5.0
- restored version counter

## 0.4.7
- fixed debugger

## 0.4.6
- removed decorator (i don't like if)
- fixed square brace preceded by an upper case character (it is not string)

## 0.4.5
- added data and parameter kind of symbols provider
- added "do case" in decorator

## 0.4.4
- Show matches on 'if-else-endif', 'for-exit-loop-next' (in test)
- Added "go to definition" that works only on current workspace.

## 0.4.3
 - fixed some windows issues

## 0.4.1
 - send symbol kind in the correct way to have icons

## 0.4.0
 - added Language server
 - Added workspace symbol provider

## 0.3.5
- fixed crashes in debugger (need recompile the library too)

## 0.3.4
- fixed double callstack with new VSCode

## 0.3.3
- Fixed expression evaluation
- better validation message when the error contains a regEx character

## 0.3.2
- removed refused debug prints

## 0.3.1
- Added missing method on debugger... still not working
- better validation message when the correct line is inside the message
- recognization of method procedure and method function

## 0.3.0
- New Debug library, it is totally rewritten without C code, it allows new features like:
	- pause support
	- add/remove breakpoint during running
	- step out
	- error catch
	- other bugfixes
- validation only on problem if it is only a word

## 0.2.3
- fix validation when diagnostic is in another file.
- fix typo on debugger

## 0.2.1
- minor fixes

## 0.2.0
- first version of symbol provider.

## 0.1.5
- Removed server code and use of harbour executable to provide diagnostic informations.

## 0.1.0
- semi complete debugging support (see [README](README.md#DEBUG) to know how integrate.)

## 0.0.9
- first version of debugger

## 0.0.3
- better syntax support

## 0.0.2
- custom icon creation

## 0.0.1
- Initial release
- first version of harbour syntax
