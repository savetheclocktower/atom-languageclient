import { Point, Range, TextEditor } from 'atom'
import * as linter from "atom/linter"
import Convert from "../convert"
import {
  CodeAction,
  Diagnostic,
  LanguageClientConnection
} from "../languageclient"
import { findAllTextEditorsForPath } from "../utils"
import {
  CodeActionsDelegate,
  convertCodeActionToIntentionListOption
} from "./code-action-adapter"

type MaybePromise<T> = T | Promise<T>

export type Intention = {
  priority: number,
  icon?: string,
  class?: string,
  title: string,
  selected: () => void
}

export type GetIntentionsOptions = {
  bufferPosition: Point,
  textEditor: TextEditor
}

export type IntentionsProviderInterface = {
  grammarScopes: string[],
  getIntentions: (
    options: GetIntentionsOptions,
    connection: LanguageClientConnection
  ) => MaybePromise<Intention[]>
}

export type MessageBundle = {
  message: linter.Message,
  code: string,
  path: string,
  callback: () => void
}

export type IntentionsDelegate = {
  getIgnoreIntentionsForLinterMessage(bundle: MessageBundle, editor: TextEditor): Intention[] | null,
} & CodeActionsDelegate

class RangeMap<T> extends Map<Range, T> {
  getResultsForPoint(point: Point): T[] {
    let ranges = this.keys()
    let results = []
    for (let range of ranges) {
      if (!range.containsPoint(point)) continue
      let value = this.get(range)
      if (!value) continue
      results.push(value)
    }
    return results
  }
}

class EditorIntentionsList {
  // Diagnostic objects could just go in the bundle with everything else, but
  // we choose to store them separately to simplify communication with the
  // language server.
  diagnosticByRange: RangeMap<Diagnostic>
  diagnosticByLinterMessage: Map<linter.Message, Diagnostic>
  linterMessageBundleByRange: RangeMap<MessageBundle>

  constructor() {
    this.linterMessageBundleByRange = new RangeMap<MessageBundle>()
    this.diagnosticByRange = new RangeMap<Diagnostic>()
    this.diagnosticByLinterMessage = new Map<linter.Message, Diagnostic>()
  }

  add(range: Range, bundle: MessageBundle, diag: Diagnostic) {
    this.linterMessageBundleByRange.set(range, bundle)
    this.diagnosticByLinterMessage.set(bundle.message, diag)
    this.diagnosticByRange.set(range, diag)
  }

  clear() {
    this.linterMessageBundleByRange.clear()
    this.diagnosticByLinterMessage.clear()
    this.diagnosticByRange.clear()
  }

  getLinterMessagesForBufferPosition(point: Point): MessageBundle[] {
    return this.linterMessageBundleByRange.getResultsForPoint(point)
  }

  getDiagnosticsForBufferPosition(point: Point): Diagnostic[] {
    return this.diagnosticByRange.getResultsForPoint(point)
  }
}

export default class IntentionsListAdapter implements IntentionsProviderInterface {
  grammarScopes: string[]
  delegate: IntentionsDelegate
  listsByEditor: WeakMap<TextEditor, EditorIntentionsList>

  constructor(
    delegate: IntentionsDelegate
  ) {
    this.grammarScopes = ['*']
    this.delegate = delegate
    this.listsByEditor = new WeakMap()
  }

  public async getIntentions(options: GetIntentionsOptions, connection: LanguageClientConnection): Promise<Intention[]> {
    let { bufferPosition, textEditor } = options
    let intentionsList = this.listsByEditor.get(textEditor)
    let range = new Range(bufferPosition, bufferPosition)
    let results = []
    let codeActionRange
    let diagnostics: Diagnostic[] = []

    if (intentionsList) {
      // We need to figure out the buffer range for which to ask the server for
      // possible code actions.
      //
      // It's probable, but not certain, that the server will do the right thing
      // if we just give it a zero-width range consisting of the cursor position.
      // But if we already know of relevant diagnostic messages, it's only
      // prudent to widen the range to include them.
      diagnostics = intentionsList.getDiagnosticsForBufferPosition(bufferPosition)
      codeActionRange = largestRangeForDiagnosticMessages(diagnostics)
    }

    if (!codeActionRange) {
      let selection = textEditor.getLastSelection()
      if (!selection.isEmpty()) {
        codeActionRange = selection.getBufferRange()
      } else {
        // Failing that, we'll just use the range that represents the cursor
        // position.
        codeActionRange = range
      }
    }

    // This is why we store the diagnostics separately; it lets us retrieve
    // them and turn them into code actions in a single batch.
    let actions = await this.delegate.getCodeActions(
      textEditor,
      codeActionRange,
      diagnostics
    ) ?? []

    let actionTitles = new Set()
    for (let action of actions) {
      if (!CodeAction.is(action)) continue
      // Don't allow more than one action with the same title. There's no way
      // for the user to tell them apart, even if they happen to do different
      // things.
      if (actionTitles.has(action.title)) continue
      let result = convertCodeActionToIntentionListOption(
        action,
        connection
      )
      if (!result) continue
      actionTitles.add(action.title)
      results.push(result)
    }

    // Even if the server sent no code actions for the given point, the client
    // may want to add its own intentions for ignoring the diagnostic
    // message(s) present at the given buffer position.
    if (intentionsList) {
      let bundles = intentionsList.getLinterMessagesForBufferPosition(bufferPosition)
      for (let bundle of bundles) {
        let ignoreIntentions = this.delegate.getIgnoreIntentionsForLinterMessage(bundle, textEditor)
        if (ignoreIntentions) results.push(...ignoreIntentions)
      }
    }

    return results
  }

  clearLinterIntentions(editor: TextEditor): void {
    this.listsByEditor.get(editor)?.clear()
  }

  findOrCreateEditorIntentionsList(editor: TextEditor): EditorIntentionsList {
    let intentionsList = this.listsByEditor.get(editor)
    if (!intentionsList) {
      intentionsList = new EditorIntentionsList()
      this.listsByEditor.set(editor, intentionsList)
    }
    return intentionsList
  }

  onLinterMessageAdded(path: string, message: linter.Message, code: string, diag: Diagnostic, callback: () => void): void {
    let { location: { position: range } } = message
    let bundle = { message, code, path, callback }

    let editors = findAllTextEditorsForPath(path)
    for (let editor of editors) {
      let intentionsList = this.findOrCreateEditorIntentionsList(editor)
      intentionsList.add(range, bundle, diag)
    }
  }
}

function largestRangeForDiagnosticMessages(diagnostics: Diagnostic[]): Range | null {
  let largestRange = null
  for (let diagnostic of diagnostics) {
    let range = Convert.lsRangeToAtomRange(diagnostic.range)
    if (!largestRange) {
      largestRange = range
    } else {
      largestRange = largestRange.union(range)
    }
  }
  return largestRange
}
