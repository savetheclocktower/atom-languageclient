import * as linter from "atom/linter"
import { CommandExecutionAdapter } from "../main"
import ApplyEditAdapter from "./apply-edit-adapter"
import Convert from "../convert"
import {
  CodeAction,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticRelatedInformation,
  LanguageClientConnection,
  PublishDiagnosticsParams,
  WorkspaceEdit
} from "../languageclient"
import {
  findAllTextEditorsForPath,
  findFirstTextEditorForPath
} from '../utils'
import { CompositeDisposable, TextEditor, Range } from "atom"
import IntentionsListAdapter from "../adapters/intentions-list-adapter"

import type * as atomIde from "atom-ide-base"
import * as ls from "../languageclient"
import type * as codeActions from "../adapters/code-action-adapter"

const SHOULD_LOAD_SOLUTIONS = false
const SHOULD_PRELOAD_SOLUTIONS_FOR_EACH_LINTER_MESSAGE = false

/** @deprecated Use Linter V2 service */
export type DiagnosticCode = number | string

export type LinterMessageSolution = linter.ReplacementSolution | linter.CallbackSolution

export type LinterDelegate = codeActions.CodeActionsDelegate & {
  shouldIgnoreMessage(diag: Diagnostic, editor: TextEditor | undefined, range: Range): boolean
  transformMessage(message: linter.Message, diag: Diagnostic, editor?: TextEditor): linter.Message | void
}

/**
 * Public: Listen to diagnostics messages from the language server and publish
 * them to the user by way of the Linter.
 *
 * Push (Indie) v2 API provided by the Base Linter package.
 */
export default class LinterPushV2Adapter {
  protected _diagnosticCodes: Map<string, Map<string, DiagnosticCode | null>> = new Map()

  /**
   * A map from file path calculated using the LS diagnostic URI to an array of
   * linter messages {@link linter.Message[]}.
   */
  protected _diagnosticMap: Map<string, linter.Message[]> = new Map()

  /**
   * A map from file path {@link linter.Message["location"]["file"]} to a Map
   * of all Message keys to Diagnostics.
   *
   * It has to be stored separately because a {@link Message} object cannot
   * hold all of the information that a {@link Diagnostic} provides, thus we
   * store the original Diagnostic object.
   */
  protected _lsDiagnosticMap: Map<
    linter.Message["location"]["file"],
    Map<linter.Message["key"], Diagnostic>
  > = new Map()

  protected _connection: LanguageClientConnection

  protected _subscriptions: CompositeDisposable = new CompositeDisposable()

  protected _indies: Set<linter.IndieDelegate> = new Set()
  protected _lastDiagnosticsParamsByEditor: WeakMap<TextEditor, PublishDiagnosticsParams>
  protected _editorsWithSaveCallbacks: WeakSet<TextEditor>

  protected _intentionsManager?: IntentionsListAdapter
  protected _delegate?: LinterDelegate

  /**
   * Public: Create a new {@link LinterPushV2Adapter} that will listen for
   * diagnostics via the supplied {@link LanguageClientConnection}.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will provide diagnostics.
   */
  constructor(
    connection: LanguageClientConnection,
    intentionsManager?: IntentionsListAdapter,
    delegate?: LinterDelegate
  ) {
    this._connection = connection
    this._delegate = delegate
    this._intentionsManager = intentionsManager
    this._lastDiagnosticsParamsByEditor = new WeakMap()
    this._editorsWithSaveCallbacks = new WeakSet()
    connection.onPublishDiagnostics(this.captureDiagnostics.bind(this))
  }

  async getCodeActions(
    editor: TextEditor,
    range: Range,
    diagnostics: ls.Diagnostic[]
  ): Promise<(ls.Command | ls.CodeAction)[] | null> {
    if (!this._delegate) return null
    let codeActions = await this._delegate.getCodeActions(
      editor, range, diagnostics
    )
    return codeActions
  }

  private _addOnSaveCallback(editor: TextEditor) {
    if (this._editorsWithSaveCallbacks.has(editor)) return

    let disposable = editor.onDidSave(() => {
      this.recaptureDiagnosticsForEditor(editor)
    })

    this._subscriptions.add(disposable)
    this._editorsWithSaveCallbacks.add(editor)
  }

  addIntentionsForLinterMessage(path: string, message: linter.Message, code: string, diag: Diagnostic): void {
    if (!this._intentionsManager) return

    let recapture = () => { this.recaptureDiagnosticsForPath(path) }
    this._intentionsManager.onLinterMessageAdded(path, message, code, diag, recapture)
  }

  /**
   * Protected: Converts a diagnostic message to the format expected by the
   * linter service, or returns null if the message should be ignored.
   *
   * @param path The path to the file referenced by this message.
   * @param diag The diagnostic message.
   * @returns Either a linter message object or null.
   */
  protected transformOrIgnoreDiagnosticMessage(
    path: string,
    diag: Diagnostic,
  ): linter.Message | null {
    let range = Convert.lsRangeToAtomRange(diag.range)
    let editor = findFirstTextEditorForPath(path)

    if (this._delegate?.shouldIgnoreMessage(diag, editor ?? undefined, range)) {
      return null
    }

    let code = diag.code ? String(diag.code) : null

    let linterMessage = lsDiagnosticToV2Message(path, diag)

    if (diag.severity && editor && SHOULD_PRELOAD_SOLUTIONS_FOR_EACH_LINTER_MESSAGE) {
      // This behavior is disabled by default because it's a bit chatty. Given
      // only a diagnostic message, there is no way of knowing whether the
      // issue is fixable unless you ask the language server for code actions.
      // But that's a lot of work to do just to be able to put a “Fix” button
      // next to a particular message.
      //
      // If you were to ask for code actions in bulk for the whole range
      // covered by a group of diagnostic messages, you'd need the language
      // server to include enough information in the response for you to be
      // able to match up each returned code action with its original
      // diagnostic message. The server can optionally do so, but does not have
      // to.
      linterMessage.solutions = this.getCodeActions(editor, range, [diag]).then(
        (result) => {
          let solutions: LinterMessageSolution[]
          if (!result) {
            solutions = []
          } else {
            solutions = convertCodeActionsToLinterMessageSolutions(
              range, result, this._connection
            )
          }
          // This is a hack, but it works. In theory, `linter` allows for
          // `solutions` to be a promise, but the UI doesn't seem to like it.
          linterMessage.solutions = solutions
          return solutions
        }
      )
    }

    // Allow a client to transform a linter message. This can happen in place
    // by modifying properties (and returning `undefined`) or by making and
    // returning a new object, as long as it conforms to the contract.
    linterMessage = this._delegate?.transformMessage?.(linterMessage, diag, editor) ?? linterMessage

    if (code) {
      this.addIntentionsForLinterMessage(path, linterMessage, code, diag)
    }

    return linterMessage
  }

  /**
   * Dispose of this adapter, ensuring any resources are freed and events
   * unhooked.
   */
  public dispose(): void {
    this._subscriptions.dispose()
    this.detachAll()
  }

  /**
   * Public: Attach this {@link LinterPushV2Adapter} to a given
   * {@link V2IndieDelegate} registry.
   *
   * @param indie A {@link V2IndieDelegate} that wants to receive messages.
   */
  public attach(indie: linter.IndieDelegate): void {
    this._indies.add(indie)
    this._diagnosticMap.forEach((value, key) => indie.setMessages(key, value))
    indie.onDidDestroy(() => {
      this._indies.delete(indie)
    })
  }

  /**
   * Public: Remove all {@link V2IndieDelegate} registries attached to this
   * adapter and clear them.
   */
  public detachAll(): void {
    this._indies.forEach((i) => i.clearMessages())
    this._indies.clear()
  }

  /**
   * Public: Capture the diagnostics sent from a language server, convert them
   * to the Linter V2 format and forward them on to any attached {@link
   * V2IndieDelegate}s.
   *
   * @param params The {@link PublishDiagnosticsParams} received from the
   *   language server that should be captured and forwarded on to any attached
   *   {@link V2IndieDelegate}s.
   */
  public captureDiagnostics(params: PublishDiagnosticsParams): void {
    const path = Convert.uriToPath(params.uri)

    // We want to know about text editors that are open to this file because:
    //
    // (a) We want to consider scope-specific settings, hence need to get
    //     grammar information.
    // (b) We want to recapture diagnostics when the buffer is clean. This
    //     makes it possible for an IDE package to, say, ignore certain
    //     messages when the buffer is dirty but not when it’s clean.
    let textEditors = findAllTextEditorsForPath(path)

    for (let editor of textEditors) {
      this._lastDiagnosticsParamsByEditor.set(editor, params)
      this._addOnSaveCallback(editor)
      this._intentionsManager?.clearLinterIntentions(editor)
    }

    const codeMap = new Map<string, Diagnostic>()
    const diagnosticMap = new Map<string, linter.Message>()

    let messages: linter.Message[] = []

    let retainedDiagnostics: Diagnostic[] = []
    let codeActionRange: Range | null = null

    for (let diagnostic of params.diagnostics) {
      let linterMessage = this.transformOrIgnoreDiagnosticMessage(
        path, diagnostic
      )
      if (!linterMessage) continue
      let { location: { position: range } } = linterMessage
      if (codeActionRange === null) {
        codeActionRange = range
      } else {
        codeActionRange = codeActionRange.union(range)
      }
      retainedDiagnostics.push(diagnostic)
      diagnosticMap.set(getDiagnosticKey(diagnostic), linterMessage)
      codeMap.set(getMessageKey(linterMessage), diagnostic)
      messages.push(linterMessage)
    }

    if (SHOULD_LOAD_SOLUTIONS && codeActionRange) {
      // TODO: Find a language server to test against that returns related
      // diagnostic information with each code action. That's a requirement for
      // the batch loading of code actions to work.
      this.getCodeActions(
        textEditors[0], codeActionRange, retainedDiagnostics
      ).then(
        (results) => {
          if (!results) return

          for (let result of results) {
            if (!CodeAction.is(result)) continue
            if (!result.diagnostics) continue

            let linterMessages = result.diagnostics.map(
              diag => diagnosticMap.get(getDiagnosticKey(diag))
            ).filter((msg): msg is linter.Message => msg !== undefined)
            if (linterMessages.length === 0) continue

            let solution = convertCodeActionToLinterMessageSolution(
              linterMessages[0].location.position,
              result,
              this._connection
            )
            if (!solution) continue

            for (let message of linterMessages) {
              if (!message || message.solutions instanceof Promise) continue

              // This is a hack, but it works. In theory, `linter` allows for
              // `solutions` to be a promise, but the UI doesn't seem to like
              // it.
              message.solutions ??= []
              message.solutions.push(solution)
            }
          }
        }
      )
    }

    this._diagnosticMap.set(path, messages)
    this._lsDiagnosticMap.set(path, codeMap)
    this._indies.forEach((i) => i.setMessages(path, messages))
  }

  /**
   * Public: Reprocess the most recently received set of diagnostic messages
   * for a given path. This is useful after an action that has changed the
   * diagnostic visiblity settings (so that the new settings are applied
   * immediately), or as the result of a save.
   *
   * @param path The path to the file.
   */
  public recaptureDiagnosticsForPath(path: string): void {
    let editors = findAllTextEditorsForPath(path)
    for (let editor of editors) {
      this.recaptureDiagnosticsForEditor(editor)
    }
  }

  /**
   * Public: Reprocess the most recently received set of diagnostic messages
   * for a given editor. This is useful after an action that has changed the
   * diagnostic visiblity settings (so that the new settings are applied
   * immediately), or as the result of a save.
   *
   * @param editor The path to the editor.
   */
  public recaptureDiagnosticsForEditor(editor: TextEditor): void {
    let lastParams = this._lastDiagnosticsParamsByEditor.get(editor)
    if (!lastParams) return
    setImmediate(() => {
      if (!lastParams) return
      // Re-process the last set of diagnostic messages now that the file has
      // been saved. This is not guaranteed to happen on its own.
      this.captureDiagnostics(lastParams)
    })
  }

  /**
   * Public: Convert a single {@link Diagnostic} received from a language
   * server into a single {@link V2Message} expected by the Linter V2 API.
   *
   * @param path A string representing the path of the file the diagnostic
   *   belongs to.
   * @param diagnostic A Diagnostic object received from the language server.
   * @returns A V2Message equivalent to the Diagnostic object supplied by the
   *   language server.
   */
  public diagnosticToV2Message(path: string, diagnostic: Diagnostic): linter.Message {
    return {
      location: {
        file: path,
        position: Convert.lsRangeToAtomRange(diagnostic.range),
      },
      excerpt: diagnostic.message,
      linterName: diagnostic.source,
      severity: LinterPushV2Adapter.diagnosticSeverityToSeverity(diagnostic.severity || -1),
    }
  }

  /**
   * Public: Get diagnostics for the given linter messages.
   *
   * @param linterMessages An array of linter {@link V2Message}s.
   * @returns An array of LS {@link Diagnostic[]}s.
   */
  public getLSDiagnosticsForMessages(linterMessages: linter.Message[]): Diagnostic[] {
    return (
      linterMessages
        .map(this.getLSDiagnosticForMessage)
        // filter out undefined
        .filter((diagnostic) => diagnostic !== undefined) as Diagnostic[]
    )
  }

  /**
   * Public: Get the {@link Diagnostic} that is associated with the given Base Linter
   * v2 {@link Message}.
   *
   * @param message The {@link Message} object to fetch the {@link Diagnostic}
   *   for.
   * @returns The associated {@link Diagnostic}.
   */
  public getLSDiagnosticForMessage(message: linter.Message): Diagnostic | undefined {
    return this._lsDiagnosticMap.get(message.location.file)?.get(getMessageKey(message))
  }

  /**
   * Public: Convert a diagnostic severity number obtained from the language
   * server into the textual equivalent for a Linter {@link V2Message}.
   *
   * @param severity A number representing the severity of the diagnostic.
   * @returns A string of 'error', 'warning' or 'info' depending on the
   *   severity.
   */
  public static diagnosticSeverityToSeverity(severity: number): "error" | "warning" | "info" {
    switch (severity) {
      case DiagnosticSeverity.Error:
        return "error"
      case DiagnosticSeverity.Warning:
        return "warning"
      case DiagnosticSeverity.Information:
      case DiagnosticSeverity.Hint:
      default:
        return "info"
    }
  }

  /**
   * Private: Get the recorded diagnostic code for a range/message. Diagnostic codes are tricky because there's no
   * suitable place in the Linter API for them. For now, we'll record the original code for each range/message
   * combination and retrieve it when needed (e.g. for passing back into code actions)
   */
  protected getDiagnosticCode(editor: TextEditor, range: Range, text: string): DiagnosticCode | null {
    const path = editor.getPath()
    if (path != null) {
      const diagnosticCodes = this._diagnosticCodes.get(path)
      if (diagnosticCodes != null) {
        return diagnosticCodes.get(getCodeKey(range, text)) || null
      }
    }
    return null
  }

  /**
   * Public: get diagnostics for the given linter messages
   *
   * @deprecated Use Linter V2 service
   * @param editor
   * @returns An array of LS {Diagnostic[]}
   */
  public getLSDiagnosticsForIdeDiagnostics(
    diagnostics: atomIde.Diagnostic[],
    editor: TextEditor
  ): ls.Diagnostic[] {
    return diagnostics.map((diagnostic) => this.getLSDiagnosticForIdeDiagnostic(diagnostic, editor))
  }

  /**
   * Public: Get the {Diagnostic} that is associated with the given {atomIde.Diagnostic}.
   *
   * @deprecated Use Linter V2 service
   * @param diagnostic The {atomIde.Diagnostic} object to fetch the {Diagnostic} for.
   * @param editor
   * @returns The associated {Diagnostic}.
   */
  public getLSDiagnosticForIdeDiagnostic(diagnostic: atomIde.Diagnostic, editor: TextEditor): ls.Diagnostic {
    // Retrieve the stored diagnostic code if it exists.
    // Until the Linter API provides a place to store the code,
    // there's no real way for the code actions API to give it back to us.
    const converted = atomIdeDiagnosticToLSDiagnostic(diagnostic)
    if (diagnostic.range != null && diagnostic.text != null) {
      const code = this.getDiagnosticCode(editor, diagnostic.range, diagnostic.text)
      if (code != null) {
        converted.code = code
      }
    }
    return converted
  }
}

/** @deprecated Use Linter V2 service */
export function atomIdeDiagnosticToLSDiagnostic(diagnostic: atomIde.Diagnostic): ls.Diagnostic {
  // TODO: support diagnostic codes and codeDescriptions
  // TODO!: support data
  return {
    range: Convert.atomRangeToLSRange(diagnostic.range),
    severity: diagnosticTypeToLSSeverity(diagnostic.type),
    source: diagnostic.providerName,
    message: diagnostic.text || "",
  }
}

/** @deprecated Use Linter V2 service */
export function diagnosticTypeToLSSeverity(type: atomIde.DiagnosticType): ls.DiagnosticSeverity {
  switch (type) {
    case "Error":
      return ls.DiagnosticSeverity.Error
    case "Warning":
      return ls.DiagnosticSeverity.Warning
    case "Info":
      return ls.DiagnosticSeverity.Information
    default:
      throw Error(`Unexpected diagnostic type ${type}`)
  }
}

/**
 * Public: Convert a single {@link Diagnostic} received from a language server
 * into a single {@link Message} expected by the Linter V2 API.
 *
 * @param path A string representing the path of the file the diagnostic
 *   belongs to.
 * @param diagnostic A {@link Diagnostic} object received from the language
 *   server.
 * @returns A {@link Message} equivalent to the {@link Diagnostic} object
 *   supplied by the language server.
 */
function lsDiagnosticToV2Message(path: string, diagnostic: Diagnostic): linter.Message {
  return {
    location: {
      file: path,
      position: Convert.lsRangeToAtomRange(diagnostic.range),
    },
    reference: relatedInformationToReference(diagnostic.relatedInformation),
    url: diagnostic.codeDescription?.href,
    icon: iconForLSSeverity(diagnostic.severity ?? DiagnosticSeverity.Error),
    excerpt: diagnostic.message,
    linterName: diagnostic.source,
    severity: lsSeverityToV2MessageSeverity(diagnostic.severity ?? DiagnosticSeverity.Error),
    // BLOCKED: on steelbrain/linter#1722
    solutions: undefined,
  }
}

/**
 * Convert a severity level of an LSP {@link Diagnostic} to that of a Base
 * Linter v2 {@link Message}. Note: this conversion is lossy due to the v2
 * Message not being able to represent hints.
 *
 * @param severity A severity level of of an LSP Diagnostic to be converted.
 * @returns A severity level a Base Linter v2 Message.
 */
function lsSeverityToV2MessageSeverity(severity: DiagnosticSeverity): linter.Message["severity"] {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error"
    case DiagnosticSeverity.Warning:
      return "warning"
    case DiagnosticSeverity.Information:
    case DiagnosticSeverity.Hint:
      return "info"
    default:
      throw Error(`Unexpected diagnostic severity '${severity}'`)
  }
}

/**
 * Convert a diagnostic severity number obtained from the language server into
 * an Octicon icon.
 *
 * @param severity A number representing the severity of the diagnostic.
 * @returns An Octicon name.
 */
function iconForLSSeverity(severity: DiagnosticSeverity): string | undefined {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "stop"
    case DiagnosticSeverity.Warning:
      return "warning"
    case DiagnosticSeverity.Information:
      return "info"
    case DiagnosticSeverity.Hint:
      return "light-bulb"
    default:
      return undefined
  }
}

/**
 * Convert the related information from a diagnostic into a reference point for
 * a Linter {@link V2Message}.
 *
 * @param relatedInfo Several related information objects (only the first is
 *   used).
 * @returns A value that is suitable for using as {@link V2Message}.reference.
 */
function relatedInformationToReference(
  relatedInfo: DiagnosticRelatedInformation[] | undefined
): linter.Message["reference"] {
  if (relatedInfo === undefined || relatedInfo.length === 0) {
    return undefined
  }

  const location = relatedInfo[0].location
  return {
    file: Convert.uriToPath(location.uri),
    position: Convert.lsRangeToAtomRange(location.range).start,
  }
}

/**
 * Get a unique key for a Linter v2 Message.
 *
 * @param message A {@link Message} object.
 * @returns A unique key.
 */
function getMessageKey(message: linter.Message): string {
  if (typeof message.key !== "string") {
    updateMessageKey(message)
  }
  return message.key as string // updateMessageKey adds message.key string
}

/**
 * Get a unique key for an LSP Diagnostic message.
 *
 * @param diagnostic A {@link Diagnostic} object.
 * @returns A unique key.
 */
function getDiagnosticKey(diagnostic: Diagnostic): string {
  let range = Convert.lsRangeToAtomRange(diagnostic.range)
  let { severity = '', code = '', message } = diagnostic
  return `${message}:${severity}:${code}:${range.toString()}`
}

/**
 * Construct an unique key for a Linter v2 Message and store it in
 * `Message.key`.
 *
 * @param message A {@link Message} object to serialize.
 * @returns A unique key.
 */
function updateMessageKey(message: linter.Message): void {
  // From https://github.com/steelbrain/linter/blob/fadd462914ef0a8ed5b73a489f662a9393bdbe9f/lib/helpers.ts#L50-L64
  const { reference, location } = message
  const nameStr = `$LINTER:${message.linterName}`
  const locationStr = `$LOCATION:${location.file}$${location.position.start.row}$${location.position.start.column}$${location.position.end.row}$${location.position.end.column}`
  const referenceStr = reference
    ? `$REFERENCE:${reference.file}$${
        reference.position ? `${reference.position.row}$${reference.position.column}` : ""
      }`
    : "$REFERENCE:null"
  const excerptStr = `$EXCERPT:${message.excerpt}`
  const severityStr = `$SEVERITY:${message.severity}`
  const iconStr = message.icon ? `$ICON:${message.icon}` : "$ICON:null"
  const urlStr = message.url ? `$URL:${message.url}` : "$URL:null"
  const descriptionStr =
    typeof message.description === "string" ? `$DESCRIPTION:${message.description}` : "$DESCRIPTION:null"
  message.key = `${nameStr}${locationStr}${referenceStr}${excerptStr}${severityStr}${iconStr}${urlStr}${descriptionStr}`
}

function convertCodeActionsToLinterMessageSolutions(
  range: Range,
  actions: (ls.Command | ls.CodeAction)[],
  connection: LanguageClientConnection
): LinterMessageSolution[] {
  let results: LinterMessageSolution[] = []

  for (let action of actions) {
    if (ls.Command.is(action)) continue
    let solution = convertCodeActionToLinterMessageSolution(
      range, action, connection)
    if (solution) results.push(solution)
  }

  return results
}

function convertCodeActionToLinterMessageSolution(
  range: Range,
  action: ls.CodeAction,
  connection: LanguageClientConnection
): LinterMessageSolution | null {
  switch (action.kind) {
    case 'quickfix':
      return quickfixActionToCallbackSolution(range, action)
    case 'refactor':
      return commandActionToCallbackSolution(range, action, connection)
    default:
      return null
  }
}

function commandActionToCallbackSolution(
  range: Range,
  action: ls.CodeAction,
  connection: LanguageClientConnection
): linter.CallbackSolution | null {
  let { command: outerCommand, title } = action
  if (!outerCommand) return null

  let { command, arguments: args } = outerCommand
  if (!command || !args) return null

  let callback = () => {
    CommandExecutionAdapter.executeCommand(connection, command, args)
  }

  return {
    title,
    position: range,
    apply: callback
  }
}

function callbackToApplyWorkspaceEdits(
  edits: ls.WorkspaceEdit[]
): linter.CallbackSolution['apply'] | null {
  let workspaceEdits: ls.WorkspaceEdit[] = []
  for (let arg of edits) {
    if (!WorkspaceEdit.is(arg)) continue
    workspaceEdits.push(arg)
  }

  return () => {
    for (let e of workspaceEdits) {
      ApplyEditAdapter.apply(e)
    }
  }
}

function quickfixActionToCallbackSolution(
  range: Range,
  action: ls.CodeAction
): linter.CallbackSolution | null {
  let { command, edit, title } = action

  // Quoth the spec: "If a code action provides a edit and a command, first the
  // edit is executed and then the command."
  let edits: ls.WorkspaceEdit[] = []
  if (edit) edits.push(edit)
  if (command) edits.push(...(command.arguments as ls.WorkspaceEdit[]))

  let callback = callbackToApplyWorkspaceEdits(edits)
  if (!callback) return null

  return {
    title,
    position: range,
    apply: callback
  }
}

function getCodeKey(range: Range, text: string): string {
  return ([] as any[]).concat(...range.serialize(), text).join(",")
}
