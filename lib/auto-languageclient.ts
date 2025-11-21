import * as cp from "child_process"
import * as ls from "./languageclient"
import * as rpc from "vscode-jsonrpc"
import * as rpcNode from "vscode-jsonrpc/node"
import * as path from "path"
import * as atomIde from "atom-ide"
import * as linter from "atom/linter"
import safeGet from 'just-safe-get'
import Convert from "./convert.js"
import ApplyEditAdapter from "./adapters/apply-edit-adapter"
import AutocompleteAdapter, { grammarScopeToAutoCompleteSelector } from "./adapters/autocomplete-adapter"
import * as CallHierarchyAdapter from "./adapters/call-hierarchy-adapter"
import CodeActionAdapter from "./adapters/code-action-adapter"
import CodeFormatAdapter, { CodeFormatType } from "./adapters/code-format-adapter"
import CodeHighlightAdapter from "./adapters/code-highlight-adapter"
import CommandExecutionAdapter from "./adapters/command-execution-adapter"
import DatatipAdapter from "./adapters/datatip-adapter"
import DefinitionAdapter from "./adapters/definition-adapter"
import { atomIdeDiagnosticsToLSDiagnostics } from './adapters/diagnostic-adapter'
import DocumentSyncAdapter from "./adapters/document-sync-adapter"
import FindReferencesAdapter from "./adapters/find-references-adapter"
import HoverAdapter, { HoverInformation, HoverProvider } from "./adapters/hover-adapter"
import IntentionsListAdapter from "./adapters/intentions-list-adapter"
import LinterPushV2Adapter from "./adapters/linter-push-v2-adapter"
import LoggingConsoleAdapter from "./adapters/logging-console-adapter"
import NotificationsAdapter from "./adapters/notifications-adapter"
import OutlineViewAdapter from "./adapters/outline-view-adapter"
import RenameAdapter from "./adapters/rename-adapter"
import SignatureHelpAdapter, { SignatureAdapter, SignatureProvider } from "./adapters/signature-help-adapter"
import SymbolAdapter from "./adapters/symbol-adapter"
import WorkDoneProgressAdapter from "./adapters/work-done-progress-adapter"
import * as sa from "./adapters/symbol-adapter"
import * as ShowDocumentAdapter from "./adapters/show-document-adapter"
import * as Utils from "./utils"
import { Socket } from "net"
import {
  CodeActionKind,
  Diagnostic,
  ExecuteCommandParams,
  FailureHandlingKind,
  LanguageClientConnection,
  MarkupKind,
  PrepareSupportDefaultBehavior,
  ResourceOperationKind,
  ShowMessageRequestParams,
  SignatureHelp,
  SignatureHelpContext,
  SymbolKind
} from "./languageclient"
import { ConsoleLogger, FilteredLogger, Logger } from "./logger"
import {
  LanguageServerProcess,
  ServerManager,
  ActiveServer,
  normalizePath,
  considerAdditionalPath,
} from "./server-manager.js"
import { Disposable, CompositeDisposable, Point, Range, TextEditor } from "atom"
import * as ac from "atom/autocomplete-plus"
import { basename } from "path"
import type * as codeActions from "./adapters/code-action-adapter"
import type * as intentions from "./adapters/intentions-list-adapter"
import type * as symbol from "./adapters/symbol-adapter"
import type * as refactor from "./adapters/rename-adapter"
import WorkspaceFileOperationsAdapter, { TreeViewV2Service } from "./adapters/workspace-file-operations-adapter"

export {
  ActiveServer,
  LanguageClientConnection,
  LanguageServerProcess
}

export type ConnectionType = "stdio" | "socket" | "ipc"
export interface ServerAdapters {
  linterPushV2: LinterPushV2Adapter
  loggingConsole: LoggingConsoleAdapter
  signatureAdapter?: SignatureAdapter,
  signatureHelpAdapter?: SignatureHelpAdapter
}

let KNOWN_SYMBOL_KINDS: SymbolKind[] = []
for (let i = 1; i < 27; i++) {
  KNOWN_SYMBOL_KINDS.push(i as SymbolKind)
}

/**
 * Public: AutoLanguageClient provides a simple way to have all the supported
 * Atom-IDE services wired up entirely for you by just subclassing it and
 * implementing at least
 *
 * - `startServerProcess`
 * - `getGrammarScopes`
 * - `getLanguageName`
 * - `getServerName`
 * - `getPackageName`
 */
export default class AutoLanguageClient {
  private _disposable!: CompositeDisposable
  private _serverManager!: ServerManager
  private _intentionsManager?: IntentionsListAdapter
  private _documentSyncAdapter?: DocumentSyncAdapter
  private _consoleDelegate?: atomIde.ConsoleService
  private _linterDelegate?: linter.IndieDelegate
  private _signatureHelpRegistry?: atomIde.SignatureHelpRegistry
  private _lastAutocompleteRequest?: ac.SuggestionsRequestedEvent
  private _isDeactivating: boolean = false
  private _serverAdapters = new WeakMap<ActiveServer, ServerAdapters>()

  /** Available if consumeBusySignal is setup */
  protected busySignalService?: atomIde.BusySignalService

  /** Available if consumeTreeViewV2 is setup */
  protected treeViewService?: TreeViewV2Service

  protected processStdErr: string = ""
  protected logger!: Logger
  protected name!: string
  protected socket!: Socket

  // Shared adapters that can take the RPC connection as required
  protected autoComplete?: AutocompleteAdapter
  protected callHierarchy?: typeof CallHierarchyAdapter
  protected datatip?: DatatipAdapter
  protected hover?: HoverAdapter
  protected definitions?: DefinitionAdapter
  protected findReferences?: FindReferencesAdapter
  protected outlineView?: OutlineViewAdapter
  protected symbolProvider?: SymbolAdapter

  // -------------------------------------------------------------------------
  // You must implement these so we know how to deal with your language and
  // server.
  // -------------------------------------------------------------------------

  /** Return an array of the grammar scopes you handle, e.g. [ 'source.js' ] */
  protected getGrammarScopes(): string[] {
    throw Error("Must implement getGrammarScopes when extending AutoLanguageClient")
  }

  /** Return the name of the language you support, e.g. 'JavaScript' */
  protected getLanguageName(): string {
    throw Error("Must implement getLanguageName when extending AutoLanguageClient")
  }

  /** Return the name of your server, e.g. 'Eclipse JDT' */
  protected getServerName(): string {
    throw Error("Must implement getServerName when extending AutoLanguageClient")
  }

  /** Return the name of your package, e.g. 'ide-typescript' */
  protected getPackageName(): string {
    throw Error("Must implement getPackageName when extending AutoLanguageClient")
  }

  /** Start your server process */
  protected startServerProcess(_projectPath: string): LanguageServerProcess | Promise<LanguageServerProcess> {
    throw Error("Must override startServerProcess to start language server process when extending AutoLanguageClient")
  }

  // -------------------------------------------------------------------------
  // You might want to override these for different behavior.
  // -------------------------------------------------------------------------

  /**
   * (Optional) Determine whether we should start a server for a given editor
   * if we don't have one yet.
   */
  protected shouldStartForEditor(editor: TextEditor): boolean {
    return this.getGrammarScopes().includes(editor?.getGrammar().scopeName)
  }

  /**
   * (Optional) Return the parameters used to initialize a client - you may
   * want to extend capabilities.
   */
  protected getInitializeParams(projectPath: string, lsProcess: LanguageServerProcess): ls.InitializeParams {
    const rootUri = Convert.pathToUri(projectPath)
    return {
      processId: lsProcess.pid !== undefined ? lsProcess.pid : null,
      rootPath: projectPath,
      rootUri,
      locale: atom.config.get("atom-i18n.locale") || "en",
      workspaceFolders: [{ uri: rootUri, name: basename(projectPath) }],
      // The capabilities supported.
      //
      // TODO the capabilities set to false/undefined are TODO. See
      // {ls.ServerCapabilities} for a full list.
      capabilities: {
        workspace: {
          // If the server gives us `workspace/applyEdit` requests, we know how
          // to apply them to the workspace.
          applyEdit: true,
          workspaceEdit: {
            // We support changes to existing documents…
            documentChanges: true,
            // …and edits that involve creating, renaming, and deleting files…
            resourceOperations: [
              ResourceOperationKind.Create,
              ResourceOperationKind.Rename,
              ResourceOperationKind.Delete
            ],
            // …but, if failures happen in the middle of a `WorkspaceEdit`, we
            // can only roll back the document changes, not the resource
            // operations.
            failureHandling: FailureHandlingKind.TextOnlyTransactional,
            // As far as I know, there is nothing special about `TextEdit`s
            // that exempts them from the general guarantee that line endings
            // will be normalized (unless the user opts out of that behavior).
            normalizesLineEndings: true,
            // "Change annotations" means that we can, if the user wants, show
            // these edits provisionally and allow the user to confirm or
            // cancel them. We do not support this yet.
            changeAnnotationSupport: undefined
          },
          // "Workspace folders" means the ability to have more than one
          // project root. This is certainly possible in Pulsar (multiple
          // project roots), but we should still make sure this is handled
          // properly.
          //
          // We seem to handle multi-root projects by spawning a separate
          // instance of the server for each root. But if the server also
          // supports `workspaceFolders`, this is probably unnecessary, and we
          // could get away with just one server instance per project window.
          workspaceFolders: true,

          // Traditionally, the client was responsible for sending
          // configuration after connection, and for sending it again if any
          // configuration values change.
          //
          // This capability signals that the client can respond to
          // `workspace/configuration` requests initiated by the server and
          // respond with the appropriate configuration values. It's not
          // immediately clear how this is a _superior_ way for this to work,
          // but it's easy enough to support this _if_ the package author works
          // within the expected model of mapping package settings to language
          // server settings.
          //
          // If a package overrides `getRootConfigurationKey` and (if
          // necessary) `mapConfigurationObject`, it can indicate that it
          // supports this model of server-initiated config retrieval by
          // overriding `supportsWorkspaceConfiguration` to return `true`.
          // Failing that, it may choose to override
          // `getWorkspaceConfiguration` to use some other arbitrary means of
          // retrieving configuration, in which case it should still override
          // `supportsWorkspaceConfiguration` so that this capability is
          // reported properly.
          configuration: this.supportsWorkspaceConfiguration(),

          // We can tell the server when the local configuration changes.
          didChangeConfiguration: {
            dynamicRegistration: false,
          },
          // We can tell the server when watched files change.
          didChangeWatchedFiles: {
            dynamicRegistration: false,
          },
          symbol: {
            dynamicRegistration: false,
            symbolKind: {
              // Simply by specifying this property, we're signaling that we
              // can handle both known and unrecognized kinds of symbols.
              valueSet: KNOWN_SYMBOL_KINDS,
            },
            tagSupport: {
              // Simply by specifying this property, we're signaling that we
              // can handle any sort of "tag" placed on a symbol.
              valueSet: [],
            },
            // We don't (yet) support receiving partial workspace symbols
            // that then get resolved lazily.
            resolveSupport: undefined
          },
          // We signal that we can and will send `workspace/executeCommand`
          // requests to the server when available.
          executeCommand: {
            dynamicRegistration: false,
          },
          // We don't support semantic tokens, though I suppose we could if
          // there were a demonstrated need for it.
          semanticTokens: undefined,

          // "Code lenses", in VS Code parlance, are contextual metadata
          // sprinkled throughout your source file. In Pulsar they would be
          // implemented as block decorations, much like the conflict
          // resolution controls from the `github` package.
          //
          // TODO: We should add support for this; no reason not to, and the
          // user would have to opt into that presentation via a UI package
          // anyway (which does not yet exist).
          codeLens: undefined,

          // When the tree-view service supports it, we can keep the server
          // notified when files are created, renamed, or deleted via user
          // action in the tree view.
          fileOperations: {
            dynamicRegistration: false,

            // These fire before the operation…
            willCreate: !!this.treeViewService,
            willRename: !!this.treeViewService,
            willDelete: !!this.treeViewService,

            // …and these fire after it's done.
            didCreate: !!this.treeViewService,
            didRename: !!this.treeViewService,
            didDelete: !!this.treeViewService
          },

          // To support this would mean to add decorations to markers (probably
          // of the `overlay` type) so that we could render useful information
          // at the ends of certain lines of the source file. (Debugger views
          // are a good example of when this could be useful.)
          //
          // TODO: Might as well support this, though it will require a UI
          // package to be fully realized.
          inlineValue: {
            // This exists as a capability in both `workspace` and
            // `textDocument` because there exists a
            // `workspace/inlineValue/refresh` request that suggests the client
            // should invalidate and re-request _all_ inline values that are
            // currently shown.
            //
            // Since we don't support inline values at all yet, we don't
            // support this.
            refreshSupport: false
          },

          // "Inlay hints" involve contextual metadata injected mid-line —
          // e.g., the parameter names next to the arguments of a function.
          //
          // This is not easily supported in Pulsar — at least not with the
          // same presentation as in VS Code — because we don't have a
          // decoration style that can shift the horizontal position of text
          // already rendered on a line.
          //
          // If we could figure out a different way to present it — or wade
          // into the `text-buffer` code and add support for this sort of
          // decoration — we could support this.
          inlayHint: {
            // This exists as a capability in both `workspace` and
            // `textDocument` because there exists a
            // `workspace/inlayHint/refresh` request that suggests the client
            // should invalidate and re-request _all_ inlay hints that are
            // currently shown.
            //
            // Since we don't support inlay hints at all yet, we don't
            // support this.
            refreshSupport: false
          },
        },


        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            // We can notify the server before we save a document.
            willSave: true,
            // We can notify the server before we save a document _and_ wait
            // for the server to respond — just in case we need to make some
            // edits before the file is committed to disk.
            willSaveWaitUntil: true,
            // We can notify the server after we save a document.
            //
            // Amazingly, it's mandatory to support `textDocument/didOpen`,
            // `/didChange`, and `/didClose`; but it is not mandatory to
            // support `/didSave`. Still, it's easy to support.
            didSave: true,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              // We have the ability to insert autocompletion items as
              // snippets.
              //
              // TODO: Technically, we only support this if the `snippets`
              // package is active (or if there is a consumer present for the
              // `snippets` service.) If we wanted to be sticklers, we could
              // make this conditional.
              snippetSupport: true,
              // We don't support the idea that each completion item can have a
              // distinct set of characters that signal acceptance of the
              // suggestion.
              commitCharactersSupport: false,
              // Documentation for suggestions can be specified in either
              // Markdown or plain text.
              documentationFormat: [
                MarkupKind.Markdown,
                MarkupKind.PlainText
              ],
              deprecatedSupport: false,
              // We don't (yet?) support the ability to designate one
              // suggestion as "preselected." We could do this rather easily,
              // but it would violate an existing convention that suggestions
              // are ordered by provider rather than being interleaved.
              //
              // TODO: If we wanted to support this, we should do the
              // following in `autocomplete-plus`:
              //
              // * If multiple providers designate an item with a `preselect`
              //   property, the one with the highest inclusion priority wins;
              //   the others have that property ignored.
              // * If a provider designates a `preselect` property on an item
              //   and it wins, we can promote that entire provider to be first
              //   in the list even when its `suggestionPriority` would
              //   otherwise preclude it.
              // * Or, as an alternative: we could promote just the winning
              //   `preselect` item, even though that could detach it from the
              //   rest of the results from that provider.
              preselectSupport: false,
              tagSupport: {
                // Only known tag is “Deprecated”; clients must support unknown
                // tags at any rate.
                valueSet: [],
              },
              insertReplaceSupport: true,
              resolveSupport: {
                properties: ['documentation', 'detail'],
              },
              insertTextModeSupport: {
                valueSet: [ls.InsertTextMode.adjustIndentation],
              },
              // "Label details" involve strings of text to be displayed
              // slightly less prominently _immediately_ after the suggestion's
              // text — e.g., a method signature. We don't have that concept yet
              // in `autocomplete-plus`.
              labelDetailsSupport: false
            },
            completionItemKind: {
              // We opt into the ability to handle unrecognized completion item
              // "kinds," so we do not need to specify the whole list of
              // possible kinds here.
              valueSet: [],
            },
            // We support sending additional context information for
            // `textDocument/completion`.
            contextSupport: true,
          },
          hover: {
            dynamicRegistration: false,
            // Hover tooltips can render either Markdown or plain text.
            contentFormat: [
              MarkupKind.Markdown,
              MarkupKind.PlainText
            ]
          },
          signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: {
              // Signature help tooltips can render either Markdown or plain
              // text.
              documentationFormat: [
                MarkupKind.Markdown,
                MarkupKind.PlainText
              ],
              parameterInformation: {
                labelOffsetSupport: false
              },
              activeParameterSupport: false,
            },
            contextSupport: true
          },
          declaration: {
            dynamicRegistration: false,
            // TODO: I think this determines whether the client receives
            // `LocationLink`s? Not sure if it's worth it.
            linkSupport: false
          },
          definition: {
            dynamicRegistration: false,
            // TODO: I think this determines whether the client receives
            // `LocationLink`s? Not sure if it's worth it.
            linkSupport: false
          },
          typeDefinition: {
            dynamicRegistration: false,
            // TODO: I think this determines whether the client receives
            // `LocationLink`s? Not sure if it's worth it.
            linkSupport: false
          },
          implementation: {
            dynamicRegistration: false,
            // TODO: I think this determines whether the client receives
            // `LocationLink`s? Not sure if it's worth it.
            linkSupport: false
          },
          // Whether we understand and will send `textDocument/references`
          // requests.
          references: {
            dynamicRegistration: false,
          },
          // Document highlight is subtly different from
          // `textDocument/references`. One difference that's clear in the
          // spec: `textDocument/documentHighlight` can distinguish between
          // reads from variables, writes to variables, and other sorts of
          // references within the text.
          //
          // There's nothing to support or not support other than indicating
          // that we _might_ send such requests. But I don't think any packages
          // use this feature.
          documentHighlight: {
            dynamicRegistration: false,
          },
          //
          documentSymbol: {
            dynamicRegistration: false,
            symbolKind: {
              // Simply by specifying this property, we're signaling that we
              // can handle both known and unrecognized kinds of symbols.
              valueSet: KNOWN_SYMBOL_KINDS,
            },
            tagSupport: {
              // Simply by specifying this property, we're signaling that we
              // can handle any sort of "tag" on a symbol.
              valueSet: [],
            },
            // We support the concept of hierarchical document symbols. We can
            // show them as such in outline-view packages, plus `symbols-view`
            // knows how to navigate a hierarchy and flatten the symbols into
            // a list.
            hierarchicalDocumentSymbolSupport: true,
            // We can render an extra "label" in the UI next to each symbol.
            labelSupport: true,
          },
          // We may send the server `textDocument/formatting` requests.
          formatting: {
            dynamicRegistration: false,
          },
          // We may send the server `textDocument/rangeFormatting` requests.
          rangeFormatting: {
            dynamicRegistration: false,
          },
          // We may send the server `textDocument/onTypeFormatting` requests.
          onTypeFormatting: {
            dynamicRegistration: false,
          },
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  CodeActionKind.Empty,
                  CodeActionKind.QuickFix,
                  CodeActionKind.Refactor,
                  CodeActionKind.RefactorExtract,
                  CodeActionKind.RefactorInline,
                  CodeActionKind.RefactorRewrite,
                  CodeActionKind.Source,
                  CodeActionKind.SourceOrganizeImports,
                  CodeActionKind.SourceFixAll
                ],
              },
            },
            isPreferredSupport: false,
            disabledSupport: false,
            dataSupport: false,
            resolveSupport: {
              properties: []
            },
            honorsChangeAnnotations: false
          },
          codeLens: {
            dynamicRegistration: false,
          },
          documentLink: {
            dynamicRegistration: false,
            tooltipSupport: false
          },
          colorProvider: {
            dynamicRegistration: false,
          },
          // We may send the server `textDocument/rename` requests.
          rename: {
            dynamicRegistration: false,
            // We support the concept of pre-announcing the cursor position for
            // where a user has tried to perform a rename. This allows the
            // server to nudge us into a range that can validly be renamed — or
            // to return `false`, signaling that there is nothing that can
            // validly be renamed anywhere near the selection.
            prepareSupport: true,
            // In lieu of explicit guidance from the server, our behavior is
            // (roughly) to use our understanding of what can validly be an
            // identifier in the editor's current grammar.
            //
            // This isn't _quite_ what we do, though; we end up just selecting
            // whatever constitutes a word. So if the cursor is somewhere in
            // `$foo`, we might only use the range for `foo`. This should be
            // fixed, though I'm not immediately sure how. (Probably a
            // scope-specific setting per grammar; something similar might
            // already exist.)
            prepareSupportDefaultBehavior: PrepareSupportDefaultBehavior.Identifier,
            // For us to support this, we'd have to have a way to provisionally
            // show the range of edits that would be made by a rename request,
            // and allow the user to confirm or cancel. That doesn't exist yet.
            honorsChangeAnnotations: false
          },
          // Not exactly clear on what a "moniker" is, but it sounds like it's
          // a way for a given symbol to be identified even across different
          // "indexes" — which I take to mean different ways of keeping track
          // of symbols, whether within one language server or across more than
          // one.
          //
          // Monikers indicate their "uniqueness" in such a way that could
          // allow different servers to agree that a symbol is equivalent, even
          // across different file types. (For instance, a moniker can indicate
          // that it is "globally" unique — as would be, perhaps, a URL or a
          // GUID.)
          //
          // I don't know of a way this could be useful to us yet, but it
          // exists if we ever need it.
          moniker: {
            dynamicRegistration: false,
          },

          // Don't know of a package that supports any `typeHierarchy/*`
          // requests, but such requests exist.
          typeHierarchy: {
            dynamicRegistration: false,
          },
          // To support this would mean to add decorations to markers (probably
          // of the `overlay` type) so that we could render useful information
          // at the ends of certain lines of the source file. (Debugger views
          // are a good example of when this could be useful.)
          //
          // This exists as a capability in both `workspace` and `textDocument`
          // because there exists a `workspace/inlayHint/refresh` request that
          // suggests the client should invalidate and re-request _all_ inline
          // hints that are currently shown.
          //
          // TODO: Might as well support this, though it will require a UI
          // package to be fully realized.
          inlineValue: {
            dynamicRegistration: false,
          },
          inlayHint: {
            dynamicRegistration: false,
          },
          // Capabilities related to server-sent diagnostics (linting).
          publishDiagnostics: {
            // Sometimes a diagnostic is related to another diagnostic. (For
            // example, if a variable is defined twice, both locations get a
            // diagnostic message, and they might as well be linked.)
            //
            // I don't think `steelbrain/linter` has specific support for this
            // yet, but there's no reason to exclude it from the metadata we
            // receive.
            relatedInformation: true,
            tagSupport: {
              // BLOCKED: on steelbrain/linter supporting ways of denoting
              // useless code and deprecated symbols.
              //
              // We don't do anything special with these, so it's easy for us
              // to assert that we can handle any tag we receive.
              valueSet: [],
            },
            // A language server might know the "version" of the buffer for
            // which a diagnostic message is known to be valid. We don't do
            // anything in `steelbrain/linter` to validate that this version
            // matches the "version" of the buffer that we're currently on, so
            // we can't claim to support this.
            versionSupport: false,
            // We support the display of a URL that can explain a given error.
            // (For instance, a linter might send a `codeDescription` property
            // with a URL that explains the specific linting rule that was
            // violated.)
            codeDescriptionSupport: true,
            // The language server can send arbitrary data with a `Diagnostic`
            // that should be sent along with a subsequent `codeAction/resolve`
            // request.
            dataSupport: true,
          },
          callHierarchy: {
            dynamicRegistration: false,
          },
          // We don't yet support any folding range features.
          //
          // Identification of folds in a document is a core feature in the
          // editor and can't easily be implemented by a package. If we did
          // implement this, it would probably be through definition of a
          // service that could be consumed by the core application logic and
          // would allow packages to define arbitrary styles of folding.
          //
          // In this model, TextMate and Tree-sitter would offer their folding
          // styles as provider packages, and there would probably be another
          // package for a very naive style of folding that operated entirely
          // on indentation level. The user could rank their preferred sources
          // of folding so that we knew which one to pick if several were
          // available.
          //
          // If that were to happen, any IDE package would be able to act as a
          // folding provider if it were supported by the underlying language
          // server. But that's a long way away.
          foldingRange: undefined,

          // This is broadly similar to our **Editor: Select Larger Syntax
          // Node** and **Editor: Select Smaller Syntax Node** commands. We get
          // that for free from Tree-sitter.
          //
          // Much like with folding ranges (as described above), if we wanted
          // to expose this as another potential source of semantic
          // highlighting ranges, we'd want to turn it into a service and have
          // Tree-sitter be one among potentially many providers of this
          // information.
          //
          // This is probably not worth the effort unless (a) it offered
          // different, and better, results than Tree-sitter gave us; or (b)
          // there's any chance of a widely-used grammar continuing to exist
          // that has practically no chance of being converted to Tree-sitter.
          // Both seem unlikely.
          selectionRange: undefined,

          // The `textDocument/linkedEditingRange` request could be used to
          // identify other ranges of a buffer that would benefit from an edit
          // that the user wants to make to a certain range of the buffer.
          //
          // This feels a lot like a rename request, but is more lightweight
          // and perhaps a better fit for, e.g., renaming both the opening and
          // closing tag in an HTML document.
          //
          // But `pulsar-refactor` doesn't use this, nor does any other package
          // I'm aware of. Still, it's client-initiated, so there's no harm in
          // declaring theoretical support for it.
          linkedEditingRange: {
            dynamicRegistration: false
          },

          // We don't support semantic tokens, though I suppose we could if
          // there were a demonstrated need for it.
          semanticTokens: undefined,
        },
        general: {
          // When a request is stale — e.g., the client asked the server to do
          // some work, but in the meantime a buffer was changed and the work
          // is no longer useful — what happens?
          staleRequestSupport: {
            // We do not currently have the ability to explicitly cancel such
            // requests.
            cancel: false,
            // For anything to appear in this list, we'd have to promise that,
            // if we got a response from a language server with a
            // `ContentModified` error for that kind of request, we'd
            // automatically retry the request.
            //
            // Since we can't currently make that promise for any kind of
            // request, the list is empty.
            retryOnContentModified: []
          },
          // We use JavaScript-style regular expressions in all contexts.
          regularExpressions: {
            engine: 'ECMAScript',
            version: 'ES2020'
          },
          // We do not implement any Markdown generation or parsing ourselves,
          // so this metadata would be Pulsar's (or the individual UI
          // package's) to provide.
          //
          // Any UI package that needs to support Markdown can choose whichever
          // Markdown parser they want — and it's likely to vary across
          // packages, making it hard to specify authoritative data here.
          //
          // Atom IDE "solved" this by exposing a Markdown service and using it
          // across all its IDE packages. If enough of these UI packages became
          // bundled packages (instead of community packages), then perhaps it
          // would be safe to do something similar, and then we could report
          // the metadata from the bundled Markdown service. But a lot of "if"s
          // are at play here.
          //
          // Of the metadata that could be specified here, perhaps the most
          // useful to the server would be a whitelist of HTML tags that are
          // allowed when we render Markdown. But it's not clear to me from
          // reading the LSP spec whether this means (a) the tags that are
          // allowed to be present in _generated_ Markdown, or (b) the tags
          // that are allowed to be written literally when writing Markdown
          // (since all HTML is valid Markdown, at least in principle).
          markdown: undefined,
        },
        window: {
          // If this service exists, we can handle `workDoneProgress` messages.
          // Without it, we have no easy way to signal that progress is
          // happening toward a background task.
          //
          // We have a desire to expand beyond what `busy-signal` can represent
          // and offer a more useful indeterminate-progress UI, but that's in
          // the "pipe dream" stage at this point.
          workDoneProgress: !!this.busySignalService,
          showMessage: {
            messageActionItem: {
              // A `window/showMessageRequest` request is initiated by the
              // server. If `additionalPropertiesSupport` is `true`, the server
              // may include additional properties in such a request, and we
              // promise to give that data back to the server if the user
              // chooses any of the actions offered in the message.
              //
              // TODO: I cannot imagine this would be difficult for us to
              // support, so we should do it.
              additionalPropertiesSupport: false
            }
          },
          showDocument: {
            // If the server says, "hey, can you open `abc://xyz`?" we can
            // indeed pass that URI to `atom.workspace.open`. This would almost
            // always be a `file://`-scheme URI and would be interpreted by
            // Pulsar as a request to open a document in an editor, but it
            // could technically be any other sort of URI. If Pulsar has an
            // opener for such a URI, that behavior would be triggered instead.
            support: true
          },
        },
        experimental: {},
      },
    }
  }

  /** (Optional) Early wire-up of listeners before initialize method is sent */
  protected preInitialization(_connection: LanguageClientConnection): void { }

  /** (Optional) Late wire-up of listeners after initialize method has been sent */
  protected postInitialization(_server: ActiveServer): void { }

  /** (Optional) Determine whether to use ipc, stdio or socket to connect to the server */
  protected getConnectionType(): ConnectionType {
    return this.socket != null ? "socket" : "stdio"
  }

  /** (Optional) Return the name of your root configuration key */
  protected getRootConfigurationKey(): string {
    return ""
  }

  /** (Optional) Transform the configuration object before it is sent to the server */
  protected mapConfigurationObject(configuration: any): any {
    return configuration
  }

  /**
   * (Optional) Determines the `languageId` string used for `textDocument/didOpen` notification. The default is to use
   * the grammar name.
   *
   * You can override this like this:
   *
   * class MyLanguageClient extends AutoLanguageClient {
   *   getLanguageIdFromEditor(editor: TextEditor) {
   *     if (editor.getGrammar().scopeName === "source.myLanguage") {
   *       return "myCustomLanguageId"
   *     }
   *     return super.getLanguageIdFromEditor(editor)
   *   }
   * }
   *
   * @param editor A {TextEditor} which is opened.
   * @returns A {string} of `languageId` used for `textDocument/didOpen`
   *   notification.
   */
  protected getLanguageIdFromEditor(editor: TextEditor): string {
    return Utils.getLanguageIdFromEditor(editor) ?? ''
  }

  /**
   * Override this to give a list of code action kinds for your language server.
   *
   * Some code actions are not returned by the server unless they're asked for
   * by name. You may want to refrain from requesting these actions in certain
   * circumstances; for instance, if diagnostics are present, you might decide
   * you want only the code actions that are relevant to those diagnostics.
   *
   * @param _editor A text editor.
   * @param _range An Atom {@link Range}.
   * @param _diagnostics A collection of language server {@link Diagnostic}
   *   objects.
   *
   * @returns An array of kinds to be used in a code action context.
   */
  getKindsForCodeActionRequest(
    _editor: TextEditor,
    _range: Range,
    _diagnostics: ls.Diagnostic[]
  ): string[] {
    return []
  }

  // Helper methods that are useful for implementors
  // ---------------------------------------------------------------------------

  /** Gets a LanguageClientConnection for a given TextEditor */
  protected async getConnectionForEditor(editor: TextEditor): Promise<LanguageClientConnection | null> {
    const server = await this._serverManager.getServer(editor)
    return server ? server.connection : null
  }

  /** Gets an ActiveServer for a given TextEditor */
  protected async getServerForEditor(editor: TextEditor): Promise<ActiveServer | null> {
    return await this._serverManager.getServer(editor)
  }

  /** Restart all active language servers for this language client in the workspace */
  protected async restartAllServers(): Promise<void> {
    await this._serverManager.restartAllServers()
  }

  // Default implementation of the rest of the AutoLanguageClient
  // ---------------------------------------------------------------------------

  /**
   * Activate does very little for perf reasons - hooks in via ServerManager
   * for later 'activation'
   */
  public activate(): void {
    this._disposable = new CompositeDisposable()
    this.name = `${this.getLanguageName()} (${this.getServerName()})`
    this.logger = this.getLogger()
    this._serverManager = new ServerManager(
      (p) => this.startServer(p),
      this.logger,
      (e) => this.shouldStartForEditor(e),
      (filepath) => this.filterChangeWatchedFiles(filepath),
      this.reportBusyWhile,
      this.getServerName(),
      (textEditor: TextEditor) => this.determineProjectPath(textEditor),
      this.shutdownGracefully
    )
    this._serverManager.startListening()
    process.on("exit", () => this.exitCleanup.bind(this))
  }

  private exitCleanup(): void {
    this._serverManager.terminate()
  }

  /** Deactivate disposes the resources we're using */
  public async deactivate(): Promise<any> {
    this._isDeactivating = true
    this._disposable.dispose()
    this._serverManager.stopListening()
    await this._serverManager.stopAllServers()
  }

  /**
   * Spawn a general language server.
   *
   * Use this inside the `startServerProcess` override if the language server
   * is a general executable, or if it requires a specific version of Node that
   * may be incompatible with Atom’s version.
   *
   * Also see the `spawnChildNode` method.
   *
   * If the name is provided as the first argument, it checks
   * `bin/platform-arch/exeName` by default, and if doesn't exists uses the exe
   * on PATH. For example on Windows x64, by passing `serve-d`,
   * `bin/win32-x64/exeName.exe` is spawned by default.
   *
   * @param exe The `name` or `path` of the executable
   * @param args Args passed to spawn the exe. Defaults to `[]`.
   * @param options: Child process spawn options. Defaults to `{}`.
   * @param rootPath The path of the folder of the exe file. Defaults to
   *   `join("bin", `${process.platform}-${process.arch} `)`.
   * @param exeExtention The extention of the exe file. Defaults to
   *   `process.platform === "win32" ? ".exe" : ""`
   */
  protected spawn(
    exe: string,
    args: string[] = [],
    options: cp.SpawnOptions = {},
    rootPath = Utils.rootPathDefault,
    exeExtention = Utils.exeExtentionDefault
  ): LanguageServerProcess {
    this.logger.debug(`starting "${exe} ${args.join(" ")}"`)
    return cp.spawn(Utils.getExePath(exe, rootPath, exeExtention), args, options)
  }

  /**
   * Spawn a language server using Atom's `node` process.
   *
   * Use this inside the `startServerProcess` override if the language server
   * is a JavaScript file and is compatible with Atom’s version of Node.
   *
   * Also see the `spawn` method.
   */
  protected spawnChildNode(args: string[], options: cp.SpawnOptions = {}): LanguageServerProcess {
    this.logger.debug(`starting child Node "${args.join(" ")}"`)
    options.env = options.env || Object.create(process.env)
    if (options.env) {
      options.env.ELECTRON_RUN_AS_NODE = "1"
      options.env.ELECTRON_NO_ATTACH_CONSOLE = "1"
    }
    return cp.spawn(process.execPath, args, options)
  }

  /**
   * LSP logging is only set for warnings & errors by default unless you turn
   * on the `core.debugLSP` setting.
   */
  protected getLogger(): Logger {
    const filter = atom.config.get("core.debugLSP")
      ? FilteredLogger.DeveloperLevelFilter
      : FilteredLogger.UserLevelFilter
    return new FilteredLogger(new ConsoleLogger(this.name), filter)
  }

  /**
   * Starts the server by starting the process, then initializing the language
   * server and starting adapters.
   */
  private async startServer(projectPath: string): Promise<ActiveServer> {
    const lsProcess = await this.reportBusyWhile(
      `Starting ${this.getServerName()} for ${path.basename(projectPath)}`,
      // eslint-disable-next-line require-await
      async () => this.startServerProcess(projectPath)
    )
    this.captureServerErrors(lsProcess, projectPath)

    const connection = new LanguageClientConnection(
      this.createRpcConnection(lsProcess), this.logger)

    this.preInitialization(connection)

    const initializeParams = this.getInitializeParams(projectPath, lsProcess)
    const initialization = connection.initialize(initializeParams)
    this.reportBusyWhile(
      `${this.getServerName()} initializing for ${path.basename(projectPath)}`,
      () => initialization
    )

    const initializeResponse = await initialization

    const newServer = {
      projectPath,
      process: lsProcess,
      connection,
      capabilities: initializeResponse.capabilities,
      disposable: new CompositeDisposable(),
      additionalPaths: new Set<string>(),
    }
    this.postInitialization(newServer)

    if (this.supportsWorkspaceConfiguration()) {
      connection.onWorkspaceConfiguration(this.getWorkspaceConfiguration.bind(this))
    }

    connection.initialized()

    connection.on("close", () => {
      if (this._isDeactivating) return

      this._serverManager.stopServer(newServer)
      if (!this._serverManager.hasServerReachedRestartLimit(newServer)) {
        this.logger.debug(
          `Restarting language server for project '${newServer.projectPath}'`
        )
        this._serverManager.startServer(projectPath)
      } else {
        this.logger.warn(
          `Language server has exceeded auto-restart limit for project '${newServer.projectPath}'`
        )
        atom.notifications.addError(
          `The ${this.name} language server has exited because it exceeded the restart limit for project '${newServer.projectPath}'.`
        )
      }
    })

    const configurationKey = this.getRootConfigurationKey()
    if (configurationKey) {
      newServer.disposable.add(
        atom.config.observe(configurationKey, (config) => {
          const mappedConfig = this.mapConfigurationObject(config || {})
          if (!mappedConfig) return
          connection.didChangeConfiguration({ settings: mappedConfig })
        })
      )
    }

    this.startExclusiveAdapters(newServer)
    return newServer
  }

  private captureServerErrors(lsProcess: LanguageServerProcess, projectPath: string): void {
    lsProcess.on("error", (err) => this.onSpawnError(err))
    lsProcess.on("close", (code, signal) => this.onSpawnClose(code, signal))
    lsProcess.on("disconnect", () => this.onSpawnDisconnect())
    lsProcess.on("exit", (code, signal) => this.onSpawnExit(code, signal))
    lsProcess.stderr?.setEncoding("utf8")
    lsProcess.stderr?.on("data", (chunk: Buffer) => this.onSpawnStdErrData(chunk, projectPath))
  }

  /**
   * The function called whenever the spawned server `error`s. Extend (call
   * super.onSpawnError) or override this if you need custom error handling.
   */
  protected onSpawnError(err: Error): void {
    atom.notifications.addError(
      `${this.getServerName()} language server for ${this.getLanguageName()} unable to start`,
      {
        dismissable: true,
        description: err.toString(),
      }
    )
  }

  /**
   * The function called whenever the spawned server `close`s. Extend (call
   * super.onSpawnClose) or override this if you need custom close handling.
   */
  protected onSpawnClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (code !== 0 && signal === null) {
      atom.notifications.addError(
        `${this.getServerName()} language server for ${this.getLanguageName()} was closed with code: ${code}.`
      )
    }
  }

  /**
   * The function called whenever the spawned server `disconnect`s. Extend
   * (call super.onSpawnDisconnect) or override this if you need custom
   * disconnect handling.
   */
  protected onSpawnDisconnect(): void {
    this.logger.debug(`${this.getServerName()} language server for ${this.getLanguageName()} got disconnected.`)
  }

  /**
   * The function called whenever the spawned server `exit`s. Extend (call
   * super.onSpawnExit) or override this if you need custom exit handling.
   */
  protected onSpawnExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.logger.debug(`exit: code ${code} signal ${signal}`)
  }

  /**
   * Whether this language client supports the `workspace/configuration`
   * request sent from server to client. This contrasts with the
   * `workspace/didChangeConfiguration` method, which is sent from server to
   * client.
   *
   * This method returns `false` by default. Override it to return true if you
   * have also overridden {@link getRootConfigurationKey} and can assert that
   * the return value of {@link mapConfigurationObject} accurately describes
   * your configuration. If these conditions are met, this package can handle
   * such requests automatically.
   *
   * If you prefer, you may use some other method of handling such lookups
   * from the server by overriding {@link getWorkspaceConfiguration}; in that
   * case, you should still override this method as well to return `true`.
   */
  protected supportsWorkspaceConfiguration() {
    return false
  }

  /**
   * Called when a server wants to look up certain settings on the client.
   *
   * The default implementation assumes that you have mapped your package's
   * configuration (or a subset thereof) to the language server's configuration
   * via {@link getRootConfigurationKey} and {@link mapConfigurationObject}. If
   * this is not accurate, you can override this method and implement your own
   * logic for retrieving settings.
   *
   * Either way, we only report this capability to the server if you opt into
   * it by overriding {@link supportsWorkspaceConfiguration} to return `true`.
   */
  protected async getWorkspaceConfiguration(params: ls.ConfigurationParams): Promise<ls.LSPAny[]> {
    let key = this.getRootConfigurationKey()
    if (key === '') {
      throw new Error('Server did not implement getRootConfigurationKey')
    }
    let rawSettings = atom.config.get(key)
    let mappedSettings = this.mapConfigurationObject(rawSettings)

    // For now we're ignoring any `scopeUri` property present for each
    // configuration item, at least until there's a use case for paying
    // attention to it.
    return params.items.map(({ section }) => {
      return section ? safeGet(mappedSettings, section) : mappedSettings
    })
  }

  /**
   * (Optional) Finds the project path. If there is custom logic for finding
   * projects, override this method.
   */
  protected determineProjectPath(textEditor: TextEditor): string | null {
    const filePath = textEditor.getPath()
    // TODO can filePath be null
    if (filePath === null || filePath === undefined) {
      return null
    }
    const projectPath = this._serverManager
      .getNormalizedProjectPaths()
      .find((d) => filePath.startsWith(d))

    if (projectPath !== undefined) return projectPath

    const serverWithClaim = this._serverManager
      .getActiveServers()
      .find((server) => server.additionalPaths?.has(path.dirname(filePath)))

    if (serverWithClaim !== undefined) {
      return normalizePath(serverWithClaim.projectPath)
    }

    return null
  }

  /**
   * The function called whenever the spawned server returns `data` in
   * `stderr`. Extend (call super.onSpawnStdErrData) or override this if you
   * need custom stderr data handling.
   */
  protected onSpawnStdErrData(chunk: Buffer, projectPath: string): void {
    const errorString = chunk.toString()
    this.handleServerStderr(errorString, projectPath)

    // Keep the last 5 lines for packages to use in messages
    this.processStdErr = (this.processStdErr + errorString)
      .split("\n").slice(-5).join("\n")
  }

  /** Creates the RPC connection which can be ipc, socket or stdio */
  private createRpcConnection(lsProcess: LanguageServerProcess): rpc.MessageConnection {
    let reader: rpc.MessageReader
    let writer: rpc.MessageWriter

    const connectionType = this.getConnectionType()
    switch (connectionType) {
      case "ipc":
        reader = new rpcNode.IPCMessageReader(lsProcess as cp.ChildProcess)
        writer = new rpcNode.IPCMessageWriter(lsProcess as cp.ChildProcess)
        break
      case "socket":
        reader = new rpcNode.SocketMessageReader(this.socket)
        writer = new rpcNode.SocketMessageWriter(this.socket)
        break
      case "stdio":
        if (lsProcess.stdin !== null && lsProcess.stdout !== null) {
          reader = new rpcNode.StreamMessageReader(lsProcess.stdout)
          writer = new rpcNode.StreamMessageWriter(lsProcess.stdin)
        } else {
          this.logger.error(
            `The language server process for ${this.getLanguageName()} does not have a valid stdin and stdout.`
          )
          return Utils.assertUnreachable("stdio" as never)
        }
        break
      default:
        return Utils.assertUnreachable(connectionType)
    }

    return rpc.createMessageConnection(reader, writer, {
      log: (..._args: any[]) => { },
      warn: (..._args: any[]) => { },
      info: (..._args: any[]) => { },
      error: (...args: any[]) => {
        this.logger.error(args)
      },
    })
  }

  // TODO: This should probably be renamed to `shouldIgnoreLinterMessage` or
  // something similar.
  /**
   * A callback for allowing a package to ignore a linter message according to
   * arbitrary criteria.
   *
   * @returns Whether a given linter message should be ignored.
   */
  shouldIgnoreMessage(_diag: Diagnostic, _editor: TextEditor | undefined, _range: Range): boolean {
    return false
  }

  // TODO: This should probably be renamed to `transformLinterMessage` or
  // something similar.
  /**
   * A callback to allow a package to transform a linter message according to
   * arbitrary criteria.
   *
   * @returns Either undefined or a message object. If undefined, will keep the
   *   original message object; this allows a package to decline to modify the
   *   message or to modify it in-place instead of copying it. If an object is
   *   returned, it must abide by the linter message contract.
   */
  transformMessage(message: linter.Message, _diag: Diagnostic, _editor?: TextEditor): linter.Message | void {
    return message
  }

  /**
   * A callback to allow a package to add intentions to the list that
   * accompanies a diagnostic message.
   *
   * The intentions returned by this callback, if any, will be added to the
   * list of actions provided by the language server.
   *
   * @returns Either `null` or a list of `Intention`s.
   */
  getIntentionsForLinterMessage(
    _bundle: intentions.MessageBundle,
    _editor: TextEditor
  ): intentions.Intention[] | null {
    return null
  }

  /**
   * Whether this server should show a specific message that the server has
   * sent via the `window/showMessage` method. Overriding this method allows
   * specific packages to opt out of the display of certain messages.
   */
  protected shouldShowMessage(_params: ShowMessageRequestParams, _name: string, _projectPath: string) {
    return true
  }

  /**
   * Whether this server should show a specific message that the server has
   * sent via the `window/showMessageRequest` method. Overriding this method
   * allows specific packages to opt out of the display of certain messages.
   */
  protected shouldShowMessageRequest(_params: ShowMessageRequestParams, _name: string, _projectPath: string) {
    return true
  }

  /** Start adapters that are not shared between servers. */
  private startExclusiveAdapters(server: ActiveServer): void {
    if (this.busySignalService) {
      WorkDoneProgressAdapter.attach(server.connection, this.busySignalService)
    }
    NotificationsAdapter.attach(server.connection, this.name, server.projectPath, {
      shouldShowMessage: (p, name, projectPath) => {
        return this.shouldShowMessage(p, name, projectPath)
      },
      shouldShowMessageRequest: (p, name, projectPath) => {
        return this.shouldShowMessageRequest(p, name, projectPath)
      }
    })

    if (DocumentSyncAdapter.canAdapt(server.capabilities)) {
      this._documentSyncAdapter = new DocumentSyncAdapter(
        server.connection,
        (editor) => this.shouldSyncForEditor(editor, server.projectPath),
        server.capabilities.textDocumentSync,
        this.reportBusyWhile,
        (editor) => this.getLanguageIdFromEditor(editor)
      )
      server.disposable.add(this._documentSyncAdapter)
    }

    ApplyEditAdapter.attach(server.connection, this._documentSyncAdapter)

    if (WorkspaceFileOperationsAdapter.canAdapt(server.capabilities) && this.treeViewService) {
      const workspaceFileOperationsAdapter = new WorkspaceFileOperationsAdapter(
        server.connection,
        this.treeViewService,
        server.capabilities?.workspace?.fileOperations
      )
    }

    this._intentionsManager = this.findOrCreateIntentionsManager()

    const linterPushV2 = new LinterPushV2Adapter(
      server.connection,
      this._intentionsManager,
      {
        ...this.getCodeActionsDelegate(),
        shouldIgnoreMessage: (...args) => {
          return this.shouldIgnoreMessage(...args)
        },
        transformMessage: (...args) => {
          return this.transformMessage(...args)
        }
      }
    )

    if (this._linterDelegate != null) {
      linterPushV2.attach(this._linterDelegate)
    }
    server.disposable.add(linterPushV2)

    const loggingConsole = new LoggingConsoleAdapter(server.connection)
    if (this._consoleDelegate != null) {
      loggingConsole.attach(this._consoleDelegate({ id: this.name, name: this.getLanguageName() }))
    }
    server.disposable.add(loggingConsole)

    let signatureHelpAdapter: SignatureHelpAdapter | undefined
    if (SignatureHelpAdapter.canAdapt(server.capabilities)) {
      signatureHelpAdapter = new SignatureHelpAdapter(server, this.getGrammarScopes())
      if (this._signatureHelpRegistry != null) {
        signatureHelpAdapter.attach(this._signatureHelpRegistry)
      }
      server.disposable.add(signatureHelpAdapter)
    }

    let signatureAdapter: SignatureAdapter | undefined
    if (SignatureAdapter.canAdapt(server.capabilities)) {
      signatureAdapter = new SignatureAdapter(server)
      server.disposable.add(signatureAdapter)
    }

    this._serverAdapters.set(server, {
      linterPushV2,
      loggingConsole,
      signatureHelpAdapter,
      signatureAdapter
    })

    ShowDocumentAdapter.attach(server.connection)

    server.connection.onWorkspaceFolders(() => this._serverManager.getWorkspaceFolders())
  }

  public shouldSyncForEditor(editor: TextEditor, projectPath: string): boolean {
    return this.isFileInProject(editor, projectPath) && this.shouldStartForEditor(editor)
  }

  protected isFileInProject(editor: TextEditor, projectPath: string): boolean {
    return (editor.getPath() || "").startsWith(projectPath)
  }

  // Autocomplete+ via LS completion---------------------------------------

  /**
   * A method to override to return an array of grammar scopes that should not
   * be used for autocompletion.
   *
   * Usually this is used for disabling autocomplete inside comments.
   *
   * @example If the grammar scopes are ['.source.js'],
   * `getAutocompleteDisabledScopes` may return ['.source.js .comment'].
   */
  protected getAutocompleteDisabledScopes(): Array<string> {
    return []
  }

  /**
   * Returns the `inclusionPriority` that should be reported by the service object.
   *
   * Override if you want to make the inclusion priority configurable by the
   * user.
   */
  protected getInclusionPriorityForAutocomplete(): number {
    return 1
  }

  /**
   * Returns the `suggestionPriority` that should be reported by the service
   * object.
   *
   * Override if you want to make the suggestion priority configurable by the
   * user.
   */
  protected getSuggestionPriorityForAutocomplete(): number {
    return 2
  }

  public provideAutocomplete(): ac.AutocompleteProvider {
    return {
      selector: this.getGrammarScopes()
        .map((g) => grammarScopeToAutoCompleteSelector(g))
        .join(", "),
      disableForSelector: this.getAutocompleteDisabledScopes()
        .map((g) => grammarScopeToAutoCompleteSelector(g))
        .join(", "),
      inclusionPriority: this.getInclusionPriorityForAutocomplete(),
      suggestionPriority: this.getSuggestionPriorityForAutocomplete(),
      excludeLowerPriority: false,
      filterSuggestions: true,
      getSuggestions: this.getSuggestions.bind(this),
      onDidInsertSuggestion: (event) => {
        AutocompleteAdapter.applyAdditionalTextEdits(event)
        this.onDidInsertSuggestion(event)
      },
      getSuggestionDetailsOnSelect: this.getSuggestionDetailsOnSelect.bind(this)
    }
  }

  protected async getSuggestions(request: ac.SuggestionsRequestedEvent): Promise<ac.AnySuggestion[]> {
    const server = await this._serverManager.getServer(request.editor)
    if (server == null || !AutocompleteAdapter.canAdapt(server.capabilities)) {
      return []
    }

    this.autoComplete = this.autoComplete || new AutocompleteAdapter(this.logger)
    this._lastAutocompleteRequest = request
    return this.autoComplete.getSuggestions(
      server,
      request,
      this.onDidConvertAutocomplete,
      atom.config.get("autocomplete-plus.minimumWordLength")
    )
  }

  protected async getSuggestionDetailsOnSelect(suggestion: ac.AnySuggestion): Promise<ac.AnySuggestion | null> {
    const request = this._lastAutocompleteRequest
    if (request == null) {
      return null
    }
    const server = await this._serverManager.getServer(request.editor)
    if (server == null || !AutocompleteAdapter.canResolve(server.capabilities) || this.autoComplete == null) {
      return null
    }

    return this.autoComplete.completeSuggestion(server, suggestion, request, this.onDidConvertAutocomplete)
  }

  /**
   * Invoked when a {@link ls.CompletionItem} is converted into a {@link
   * ac.AnySuggestion} (translating LSP types to `autocomplete-plus` types).
   *
   * You may use this as an opportunity to customize the suggestion further or
   * change some of its metadata.
   *
   * @returns Nothing; you should modify the suggestion through direct
   *   mutation.
   */
  protected onDidConvertAutocomplete(
    _completionItem: ls.CompletionItem,
    _suggestion: ac.AnySuggestion,
    _request: ac.SuggestionsRequestedEvent
  ): void { }

  /**
   * Invoked when a suggestion is inserted into the document after being chosen
   * by the user.
   *
   * You may use this method as an opportunity to perform any further action at
   * the time of suggestion insertion.
   */
  protected onDidInsertSuggestion(_arg: ac.SuggestionInsertedEvent): void { }

  // Definitions via LS documentHighlight and gotoDefinition------------
  public provideDefinitions(): atomIde.DefinitionProvider {
    return {
      name: this.name,
      priority: 20,
      grammarScopes: this.getGrammarScopes(),
      wordRegExp: null, // TODO pass RegExp
      getDefinition: this.getDefinition.bind(this),
    }
  }

  protected async getDefinition(editor: TextEditor, point: Point): Promise<atomIde.DefinitionQueryResult | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !DefinitionAdapter.canAdapt(server.capabilities)) {
      return null
    }

    this.definitions = this.definitions || new DefinitionAdapter()
    const query = await this.definitions.getDefinition(
      server.connection,
      server.capabilities,
      this.getLanguageName(),
      editor,
      point
    )

    if (query !== null && server.additionalPaths !== undefined) {
      // populate additionalPaths based on definitions
      // Indicates that the language server can support LSP functionality for
      // out-of-project files indicated by `textDocument/definition` responses.
      for (const def of query.definitions) {
        considerAdditionalPath(server as ActiveServer & { additionalPaths: Set<string> }, path.dirname(def.path))
      }
    }

    return query
  }

  // Outline View via LS documentSymbol---------------------------------

  /**
   * Returns the priority that shoud be reported by the
   * {@link atomIde.OutlineProvider}.
   *
   * A package could override this value if its author wanted to make
   * the outline provider priority configurable by the user.
   */
  getPriorityForOutline(): number {
    return 1
  }

  public provideOutlines(): atomIde.OutlineProvider {
    return {
      name: this.name,
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForOutline(),
      getOutline: this.getOutline.bind(this)
    }
  }

  protected async getOutline(editor: TextEditor): Promise<atomIde.Outline | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !OutlineViewAdapter.canAdapt(server.capabilities)) {
      return null
    }

    this.outlineView = this.outlineView || new OutlineViewAdapter()
    return this.outlineView.getOutline(server.connection, editor)
  }

  // Intentions (menu) -------------------------------------------------------

  protected findOrCreateIntentionsManager(): IntentionsListAdapter {
    if (this._intentionsManager) return this._intentionsManager

    // The intentions delegate manages some tasks that intentions would care
    // about. Intentions can act as an interface both to code actions
    // (non-urgent code changes) and diagnostic message code changes (which
    // could solve problems).
    this._intentionsManager = new IntentionsListAdapter({
      getCodeActions: this.getRawCodeActions.bind(this),
      filterCodeActions: this.filterCodeActions.bind(this),
      getIntentionsForLinterMessage: this.getIntentionsForLinterMessage.bind(this)
    })
    return this._intentionsManager
  }

  public provideIntentionsList(): intentions.IntentionsProviderInterface | null {
    let manager = this.findOrCreateIntentionsManager()
    if (!manager) return null
    return {
      grammarScopes: this.getGrammarScopes(),
      getIntentions: async (options: intentions.GetIntentionsOptions) => {
        let { textEditor } = options
        const server = await this._serverManager.getServer(textEditor)
        if (!server) return []
        return manager.getIntentions(options, server.connection)
      }
    }
  }

  /**
   * A callback for allowing a package to control whether a symbol is shown in
   * a list. Override this method to apply arbitrary criteria for ignoring
   * certain symbols.
   *
   * Will be consulted no matter what sort of `symbols-view` command is run; if
   * you want to filter the symbol list only for certain kinds of actions,
   * consult the `meta` argument to know what sort of action is being invoked.
   *
   * @returns A boolean indicating whether a symbol should be shown in a list
   *   of symbols.
   */
  protected shouldIgnoreSymbol(_symbol: symbol.SymbolEntry, _editor: TextEditor, _meta: symbol.SymbolMeta): boolean {
    return false
  }

  /**
   * Override to implement custom logic about when a symbol provider can
   * fulfill a request. For instance, can return false if a setting is
   * disabled, or if the editor is unsaved.
   *
   * If this method returns `false`, the consuming package will not attempt to
   * act as a provider for a single symbol request. But if it returns `true`,
   * we may still decline to act as a symbol provider for other reasons
   * (incompatible grammar, lack of language server, et cetera).
   *
   * @returns Whether the language server should try to provide symbols for a
   *   given request.
   */
  protected canProvideSymbols(_meta: sa.SymbolMeta) {
    return true
  }

  /**
   * Override to define a minimum query length for project-wide symbol search.
   *
   * Has no effect on other kinds of symbol search.
   *
   * @returns A number representing minimum query length before asking the
   *   language server to suggest project-wide symbols.
   */
  protected minimumQueryLengthForSymbolSearch(_meta: sa.SymbolMeta) {
    return 3
  }

  // Symbol View (file/project/reference) via LS documentSymbol/workspaceSymbol/goToDefinition
  public provideSymbols(): sa.SymbolProvider {
    this.symbolProvider ??= new SymbolAdapter(undefined, {
      shouldIgnoreSymbol: (symbol, editor, meta) => {
        return this.shouldIgnoreSymbol(symbol, editor, meta)
      }
    })

    let adapter = this.symbolProvider
    return {
      name: this.getServerName(),
      packageName: this.getPackageName(),
      isExclusive: adapter.isExclusive,

      canProvideSymbols: async (meta: sa.SymbolMeta): Promise<boolean | number> => {
        let override = this.canProvideSymbols(meta)
        if (!override) return false

        let server = await this._serverManager.getServer(meta.editor)
        if (!server) return false

        // For “list symbols in this file” and “go to this declaration,” we
        // want to consider only language servers that match the grammar of the
        // current file. For “open a project-wide symbol search palette,” the
        // grammar of the current file is irrelevant, and we should allow this
        // provider to opt in if it's active.
        if (meta.type !== 'project') {
          let scopes = this.getGrammarScopes()
          let baseScope = meta.editor.getGrammar()?.scopeName
          if (!scopes.includes(baseScope)) return false
        }

        return adapter.canProvideSymbols(server, meta)
      },

      getSymbols: async (meta: sa.SymbolMeta, listController: sa.ListController): Promise<sa.SymbolResponse> => {
        let query = meta.query ?? ''
        let minLength = this.minimumQueryLengthForSymbolSearch(meta) ?? 1
        if (meta.type === 'project' && query.length < minLength) {
          let noun = minLength === 1 ? 'character' : 'characters'
          listController.set({
            loadingMessage: null,
            emptyMessage: `Query must be at least ${minLength} ${noun} long.`
          })
          return []
        } else {
          listController.set({ emptyMessage: `No results.` })
        }
        let server = await this._serverManager.getServer(meta.editor)
        if (!server) return []

        return adapter.getSymbols(server, meta)
      }
    }
  }

  // Call Hierarchy View via LS callHierarchy---------------------------------
  public provideCallHierarchy(): atomIde.CallHierarchyProvider {
    return {
      name: this.name,
      grammarScopes: this.getGrammarScopes(),
      priority: 1,
      getIncomingCallHierarchy: this.getIncomingCallHierarchy.bind(this),
      getOutgoingCallHierarchy: this.getOutgoingCallHierarchy.bind(this),
    }
  }

  protected async getIncomingCallHierarchy(
    editor: TextEditor,
    point: Point
  ): Promise<atomIde.CallHierarchy<"incoming"> | null> {
    const server = await this._serverManager.getServer(editor)
    if (server === null || !CallHierarchyAdapter.canAdapt(server.capabilities)) {
      return null
    }
    this.callHierarchy = this.callHierarchy ?? CallHierarchyAdapter
    return this.callHierarchy.getCallHierarchy(server.connection, editor, point, "incoming")
  }

  protected async getOutgoingCallHierarchy(
    editor: TextEditor,
    point: Point
  ): Promise<atomIde.CallHierarchy<"outgoing"> | null> {
    const server = await this._serverManager.getServer(editor)
    if (server === null || !CallHierarchyAdapter.canAdapt(server.capabilities)) {
      return null
    }
    this.callHierarchy = this.callHierarchy ?? CallHierarchyAdapter
    return this.callHierarchy.getCallHierarchy(server.connection, editor, point, "outgoing")
  }

  // Linter push v2 API via LS publishDiagnostics ------------------------------
  public consumeLinterV2(
    registerIndie: (params: { name: string }) => linter.IndieDelegate
  ): void {
    this.logger.log('consumeLinterV2', registerIndie)
    this._linterDelegate = registerIndie({ name: this.name })
    if (this._linterDelegate == null) { return }

    for (const server of this._serverManager.getActiveServers()) {
      const linterPushV2 = this.getServerAdapter(server, "linterPushV2")
      if (linterPushV2 != null) {
        linterPushV2.attach(this._linterDelegate)
      }
    }
  }

  public async executeCommand(
    editor: TextEditor,
    params: ExecuteCommandParams
  ): Promise<any | void> {
    const server = await this._serverManager.getServer(editor)
    if (!server) return
    return await CommandExecutionAdapter.executeCommandWithParams(
      server.connection,
      params
    )
  }

  // Find References via LS findReferences------------------------------
  public provideFindReferences(): atomIde.FindReferencesProvider {
    return {
      isEditorSupported: (editor: TextEditor) => this.getGrammarScopes().includes(editor?.getGrammar().scopeName),
      findReferences: this.getReferences.bind(this),
    }
  }

  protected async getReferences(editor: TextEditor, point: Point): Promise<atomIde.FindReferencesReturn | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !FindReferencesAdapter.canAdapt(server.capabilities)) {
      return null
    }

    this.findReferences = this.findReferences || new FindReferencesAdapter()
    return this.findReferences.getReferences(server.connection, editor, point, server.projectPath)
  }

  // Datatip via LS textDocument/hover----------------------------------
  public consumeDatatip(service: atomIde.DatatipService): void {
    this._disposable.add(
      service.addProvider({
        providerName: this.name,
        priority: this.getPriorityForHover(),
        grammarScopes: this.getGrammarScopes(),
        validForScope: (scopeName: string) => {
          return this.getGrammarScopes().includes(scopeName)
        },
        datatip: this.getDatatip.bind(this),
      })
    )
  }

  protected async getDatatip(editor: TextEditor, point: Point): Promise<atomIde.Datatip | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !DatatipAdapter.canAdapt(server.capabilities)) {
      return null
    }

    this.datatip = this.datatip || new DatatipAdapter()
    return this.datatip.getDatatip(server.connection, editor, point)
  }

  // Hover (simple Datatip alternative) via LS textdocument/hover

  /**
   * The priority value to use for hover providers. Override this method to
   * customize the priority.
   */
  protected getPriorityForHover(): number {
    return 1
  }

  public provideHover(): HoverProvider {
    return {
      name: this.name,
      packageName: this.getPackageName(),
      priority: this.getPriorityForHover(),
      grammarScopes: this.getGrammarScopes(),
      validForScope: (scopeName: string) => {
        return this.getGrammarScopes().includes(scopeName)
      },
      hover: this.getHover.bind(this)
    }
  }

  protected async getHover(editor: TextEditor, point: Point): Promise<HoverInformation | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !HoverAdapter.canAdapt(server.capabilities)) {
      return null
    }
    this.hover ??= new HoverAdapter()
    return this.hover.getHover(server.connection, editor, point)
  }

  // Console via LS logging---------------------------------------------
  public consumeConsole(createConsole: atomIde.ConsoleService): Disposable {
    this._consoleDelegate = createConsole

    for (const server of this._serverManager.getActiveServers()) {
      const loggingConsole = this.getServerAdapter(server, "loggingConsole")
      if (loggingConsole) {
        loggingConsole.attach(this._consoleDelegate({ id: this.name, name: this.getLanguageName() }))
      }
    }

    // No way of detaching from client connections today
    return new Disposable(() => { })
  }

  // Code Format via LS formatDocument & formatDocumentRange------------
  public provideCodeFormat(): atomIde.RangeCodeFormatProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForCodeFormat('range'),
      formatCode: this.getCodeFormat.bind(this),
    }
  }

  /**
   * The priority value to use for code format providers. Override this
   * method to customize the priority.
   *
   * Receives a `type` argument that distinguishes between types of code
   * format requests.
   */
  protected getPriorityForCodeFormat(_type: CodeFormatType): number {
    return 1
  }

  protected async getCodeFormat(editor: TextEditor, range: Range): Promise<atomIde.TextEdit[]> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !CodeFormatAdapter.canAdapt(server.capabilities)) {
      return []
    }

    return CodeFormatAdapter.format(server.connection, server.capabilities, editor, range)
  }

  public provideRangeCodeFormat(): atomIde.RangeCodeFormatProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForCodeFormat('range'),
      formatCode: this.getRangeCodeFormat.bind(this),
    }
  }

  protected async getRangeCodeFormat(editor: TextEditor, range: Range): Promise<atomIde.TextEdit[]> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !server.capabilities.documentRangeFormattingProvider) {
      return []
    }

    return CodeFormatAdapter.formatRange(server.connection, editor, range)
  }

  public provideFileCodeFormat(): atomIde.FileCodeFormatProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForCodeFormat('file'),
      formatEntireFile: this.getFileCodeFormat.bind(this),
    }
  }

  public provideOnSaveCodeFormat(): atomIde.OnSaveCodeFormatProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForCodeFormat('onSave'),
      formatOnSave: this.getFileCodeFormat.bind(this),
    }
  }

  protected async getFileCodeFormat(editor: TextEditor): Promise<atomIde.TextEdit[]> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !server.capabilities.documentFormattingProvider) {
      return []
    }

    return CodeFormatAdapter.formatDocument(server.connection, editor, this._documentSyncAdapter)
  }

  public provideOnTypeCodeFormat(): atomIde.OnTypeCodeFormatProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForCodeFormat('onType'),
      formatAtPosition: this.getOnTypeCodeFormat.bind(this),
    }
  }

  protected async getOnTypeCodeFormat(
    editor: TextEditor,
    point: Point,
    character: string
  ): Promise<atomIde.TextEdit[]> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !server.capabilities.documentOnTypeFormattingProvider) {
      return []
    }

    return CodeFormatAdapter.formatOnType(server.connection, editor, point, character)
  }

  public provideCodeHighlight(): atomIde.CodeHighlightProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: 1,
      highlight: (editor, position) => {
        return this.getCodeHighlight(editor, position)
      },
    }
  }

  protected async getCodeHighlight(editor: TextEditor, position: Point): Promise<Range[] | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !CodeHighlightAdapter.canAdapt(server.capabilities)) {
      return null
    }

    return CodeHighlightAdapter.highlight(server.connection, server.capabilities, editor, position)
  }

  public provideCodeActions(): atomIde.CodeActionProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: 1,
      getCodeActions: (editor, range, diagnostics) => {
        let ideDiagnostics = atomIdeDiagnosticsToLSDiagnostics(diagnostics)
        return this.getCodeActions(editor, range, ideDiagnostics)
      }
    }
  }

  protected getCodeActionsDelegate(): codeActions.CodeActionsDelegate {
    return {
      getCodeActions: this.getRawCodeActions.bind(this),
      filterCodeActions: this.filterCodeActions.bind(this)
    }
  }

  protected async getRawCodeActions(
    editor: TextEditor,
    range: Range,
    diagnostics: ls.Diagnostic[]
  ): Promise<(ls.Command | ls.CodeAction)[] | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !CodeActionAdapter.canAdapt(server.capabilities)) {
      return null
    }

    let kinds = this.getKindsForCodeActionRequest(editor, range, diagnostics)
    return CodeActionAdapter.getLsCodeActions(
      server.connection,
      server.capabilities,
      this.getServerAdapter(server, "linterPushV2"),
      editor,
      range,
      diagnostics,
      this.filterCodeActions.bind(this),
      kinds
    )
  }

  public async getCodeActions(
    editor: TextEditor,
    range: Range,
    diagnostics: ls.Diagnostic[]
  ): Promise<atomIde.CodeAction[] | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !CodeActionAdapter.canAdapt(server.capabilities)) {
      return null
    }

    let kinds = this.getKindsForCodeActionRequest(editor, range, diagnostics)
    return CodeActionAdapter.getCodeActions(
      server.connection,
      server.capabilities,
      this.getServerAdapter(server, "linterPushV2"),
      editor,
      range,
      diagnostics,
      this.filterCodeActions.bind(this),
      this.onApplyCodeActions.bind(this),
      kinds
    )
  }

  /** Optionally filter code action before they're displayed. */
  public filterCodeActions(actions: (ls.Command | ls.CodeAction)[] | null): (ls.Command | ls.CodeAction)[] | null {
    return actions
  }

  /**
   * Optionally handle a code action before default handling. Return `false` to
   * prevent default handling, or `true` to continue with default handling.
   */
  protected onApplyCodeActions(_action: ls.Command | ls.CodeAction): Promise<boolean> {
    return Promise.resolve(true)
  }

  /**
   * Override this method to return a custom priority for the `refactor`
   * service.
   *
   * For instance, you may choose to make refactor provider priority
   * configurable by the user so they can more easily choose a winner in cases
   * of conflict.
   */
  protected getPriorityForRefactor() {
    return 1
  }

  public provideRefactor(): atomIde.RefactorProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForRefactor(),
      rename: this.getRename.bind(this)
    }
  }

  public provideRefactorWithPrepare(): refactor.EnhancedRefactorProvider {
    return {
      grammarScopes: this.getGrammarScopes(),
      priority: this.getPriorityForRefactor(),
      rename: this.getRename.bind(this),
      prepareRename: this.getPrepareRename.bind(this)
    }
  }

  protected async getRename(
    editor: TextEditor,
    position: Point,
    newName: string
  ): Promise<Map<string, atomIde.TextEdit[]> | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !RenameAdapter.canAdapt(server.capabilities)) {
      return null
    }

    return RenameAdapter.getRename(server.connection, editor, position, newName)
  }

  /**
   * Ask the language server to prepare for a rename. May tell us the
   * {@link Range} that could validly be renamed at the given cursor position,
   * or else whether it's valid to rename anything at that cursor position.
   */
  protected async getPrepareRename(
    editor: TextEditor,
    position: Point
  ): Promise<Range | boolean | null> {
    const server = await this._serverManager.getServer(editor)
    if (server == null || !RenameAdapter.canAdaptPrepare(server.capabilities)) {
      return null
    }

    return RenameAdapter.getPrepareRename(server.connection, editor, position)
  }

  // Signature Help via LS textDocument/signatureHelp -------------------------


  // SERVICE: signature-help (Atom IDE)

  /**
   * The priority value to use for signature help providers. Override this
   * method to customize the priority.
   */
  protected getPriorityForSignatureHelp(): number {
    return 1
  }

  public consumeSignatureHelp(registry: atomIde.SignatureHelpRegistry): Disposable {
    this._signatureHelpRegistry = registry
    for (const server of this._serverManager.getActiveServers()) {
      const signatureHelpAdapter = this.getServerAdapter(server, "signatureHelpAdapter")
      if (signatureHelpAdapter != null) {
        signatureHelpAdapter.attach(registry)
      }
    }
    return new Disposable(() => {
      this._signatureHelpRegistry = undefined
    })
  }

  // SERVICE: signature (simpler alternative)

  /**
   * Provide the `signature` service.
   *
   * This method is purposefully async; the consumer receives a `Promise` that
   * will resolve to either a traditional provider-style object or `null`.
   */
  public async provideSignature(): Promise<SignatureProvider | null> {
    // This is tricky because the service wants to know some information up
    // front that we cannot provide until we talk to the server:
    // `triggerCharacters` and `retriggerCharacters`. This information is
    // contained in the server's capabilites object and is not something we
    // want to retrieve dynamically if it can be avoided.
    //
    // Atom IDE “solved” this problem with the `signature-help` service by
    // inverting the provider/consumer relationship: the provider pretended to
    // be the consumer, and vice-versa, so that the provider could imperatively
    // provide itself to the consumer when it was ready to.
    //
    // In situations with multiple project roots, this could get confusing,
    // because it results in several different “consumers” adding themselves to
    // their “provider.” And `atom-ide-signature-help` never understood this —
    // it simply picked the provider with the highest priority. There was no
    // mechanism in the service contract to allow it to pick the correct
    // provider for an editor's path.
    //
    // We'd like to solve this another way that isn't quite so disorienting, so
    // our `signature` service works as follows:
    //
    // * The provider gives a promise that will resolve to a
    //   `SignatureProvider` (or `null`). The consumer awaits the promise, then
    //   decides what to do with it.
    // * This allows us to resolve as soon as we have a single server instance
    //   and can inspect its capabilities to discover `triggerCharacters` and
    //   `retriggerCharacters`.
    // * We make the opinionated (but well-founded) decision to treat those
    //   initial capabilities as authoritative for any future servers as well,
    //   at least as far as signature help trigger characters are concerned.
    //   It is _highly_ unlikely for such data to vary based on the root folder
    //   of a language server instance.
    // * The bulk of the work is done in the `getSignature` function — and,
    //   crucially, that function will find the correct server instance for its
    //   path, then use the correct `SignatureAdapter` to look up its signature
    //   help.
    let signatureAdapter = await this.waitForFirstSignatureAdapter()
    if (!signatureAdapter) return null

    return {
      name: this.name,
      packageName: this.getPackageName(),
      priority: this.getPriorityForSignatureHelp(),
      grammarScopes: this.getGrammarScopes(),
      triggerCharacters: signatureAdapter.triggerCharacters,
      retriggerCharacters: signatureAdapter.retriggerCharacters,
      getSignature: this.getSignature.bind(this)
    }
  }

  protected async getSignature(
    editor: TextEditor,
    point: Point,
    context?: SignatureHelpContext
  ): Promise<SignatureHelp | null> {
    let server = await this._serverManager.getServer(editor)
    if (!server) return null

    let adapter = this.getServerAdapter(server, 'signatureAdapter')
    if (!adapter) return null

    return adapter.getSignature(editor, point, context)
  }

  async waitForFirstSignatureAdapter(): Promise<SignatureAdapter | null> {
    // We might have one already…
    for (let server of this._serverManager.getActiveServers()) {
      let signatureAdapter = this.getServerAdapter(server, 'signatureAdapter')
      if (signatureAdapter != null) {
        return Promise.resolve(signatureAdapter)
      }
    }
    // …but if not, we'll wait for one for five seconds.
    try {
      return await SignatureAdapter.waitForFirst()
    } catch (err) {
      return null
    }
  }


  public consumeBusySignal(service: atomIde.BusySignalService): Disposable {
    this.busySignalService = service
    return new Disposable(() => delete this.busySignalService)
  }

  public consumeTreeViewV2(service: TreeViewV2Service) {
    this.treeViewService = service
    return new Disposable(() => delete this.treeViewService)
  }

  /**
   * `didChangeWatchedFiles` message filtering, override for custom logic.
   *
   * @param {String} _filePath Path of a file that has changed in the project path
   * @returns `false` => message will not be sent to the language server
   */
  protected filterChangeWatchedFiles(_filePath: string): boolean {
    return true
  }

  /**
   * If this is set to `true` (the default value), the servers will shut down
   * gracefully. If it is set to `false`, the servers will be killed without
   * awaiting shutdown response.
   */
  protected shutdownGracefully: boolean = true

  /**
   * Called on language server stderr output.
   *
   * @param stderr A chunk of stderr from a language server instance
   */
  protected handleServerStderr(stderr: string, _projectPath: string): void {
    stderr
      .split("\n")
      .filter((l) => l)
      .forEach((line) => this.logger.warn(`stderr ${line}`))
  }

  private getServerAdapter<T extends keyof ServerAdapters>(
    server: ActiveServer,
    adapter: T
  ): ServerAdapters[T] | undefined {
    const adapters = this._serverAdapters.get(server)
    return adapters && adapters[adapter]
  }

  protected reportBusyWhile: Utils.ReportBusyWhile = (title, f) => {
    if (this.busySignalService) {
      return this.busySignalService.reportBusyWhile(title, f)
    } else {
      return this.reportBusyWhileDefault(title, f)
    }
  }

  protected reportBusyWhileDefault: Utils.ReportBusyWhile = async (title, f) => {
    this.logger.info(`[Started] ${title}`)
    let res
    try {
      res = await f()
    } finally {
      this.logger.info(`[Finished] ${title}`)
    }
    return res
  }
}
