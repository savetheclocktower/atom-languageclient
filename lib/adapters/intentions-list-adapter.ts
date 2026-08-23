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
  /**
   * The original {@link Diagnostic} this message was converted from.
   *
   * A {@link linter.Message} cannot represent everything a diagnostic carries
   * — `code`, `codeDescription`, `data`, `relatedInformation` — so the
   * original is kept alongside it. This mirrors `shouldIgnoreLinterMessage`,
   * which is likewise handed the whole diagnostic to decide on.
   */
  diagnostic: Diagnostic,
  /**
   * The diagnostic's code, or `null` when the server did not supply one. LSP
   * treats `code` as optional, so a consumer that keys off it should expect to
   * be handed `null`.
   *
   * Retained as a convenience; it is derivable from
   * {@link MessageBundle.diagnostic}.
   */
  code: string | null,
  path: string,
  callback: () => void
}

export type IntentionsDelegate = {
  getIntentionsForLinterMessage(bundle: MessageBundle, editor: TextEditor): Intention[] | null,
} & CodeActionsDelegate

/**
 * A multimap keyed by buffer {@link Range}.
 *
 * Ranges are canonicalized by value, so two `Range`s that describe the same
 * actual range address the same entry. More than one value may be filed
 * against a single range — two rules flagging the same token is routine — so
 * {@link add} appends rather than replacing.
 *
 * This deliberately does not extend {@link Map}: `set` implies replacement,
 * which would discard all but the last value at a given range.
 */
class RangeIndex<T> {
  #entries: Map<string, { range: Range, values: T[] }> = new Map()

  #keyFor(range: Range): string {
    return range.toString()
  }

  add(range: Range, value: T): this {
    const key = this.#keyFor(range)
    let entry = this.#entries.get(key)
    if (!entry) {
      // Store a frozen copy, distinct from the `Range` we were handed, so that
      // a later mutation of the caller's range can't desynchronize the entry
      // from the key it's filed under.
      entry = { range: range.copy().freeze(), values: [] }
      this.#entries.set(key, entry)
    }
    entry.values.push(value)
    return this
  }

  get(range: Range): T[] {
    return this.#entries.get(this.#keyFor(range))?.values ?? []
  }

  has(range: Range): boolean {
    return this.#entries.has(this.#keyFor(range))
  }

  delete(range: Range): boolean {
    return this.#entries.delete(this.#keyFor(range))
  }

  clear(): void {
    this.#entries.clear()
  }

  getResultsForPoint(point: Point): T[] {
    const results: T[] = []
    for (const { range, values } of this.#entries.values()) {
      if (!range.containsPoint(point)) continue
      results.push(...values)
    }
    return results
  }
}

class EditorIntentionsList {
  // Diagnostics are indexed separately from the bundles — even though each
  // bundle also carries its own — because they're retrieved as a batch to be
  // sent back to the language server as code-action context.
  diagnosticByRange: RangeIndex<Diagnostic>
  linterMessageBundleByRange: RangeIndex<MessageBundle>

  constructor() {
    this.linterMessageBundleByRange = new RangeIndex<MessageBundle>()
    this.diagnosticByRange = new RangeIndex<Diagnostic>()
  }

  add(range: Range, bundle: MessageBundle, diag: Diagnostic) {
    this.linterMessageBundleByRange.add(range, bundle)
    this.diagnosticByRange.add(range, diag)
  }

  clear() {
    this.linterMessageBundleByRange.clear()
    this.diagnosticByRange.clear()
  }

  getLinterMessagesForBufferPosition(point: Point): MessageBundle[] {
    return this.linterMessageBundleByRange.getResultsForPoint(point)
  }

  getDiagnosticsForBufferPosition(point: Point): Diagnostic[] {
    return this.diagnosticByRange.getResultsForPoint(point)
  }
}

/**
 * An adapter to present a list of contextual options within a source code
 * file.
 *
 * This adapter aggregates the two different language-server features that
 * could offer you contextual actions at a certain point in the buffer: code
 * actions and diagnostic fixes.
 *
 * @param delegate A bundle of methods from other adapters that help this
 *   adapter to assemble a menu.
 */
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

  public async getIntentions(
    options: GetIntentionsOptions,
    connection: LanguageClientConnection
  ): Promise<Intention[]> {
    const { bufferPosition, textEditor } = options
    const intentionsList = this.listsByEditor.get(textEditor)
    const range = new Range(bufferPosition, bufferPosition)
    const results = []
    let codeActionRange
    let diagnostics: Diagnostic[] = []

    if (intentionsList) {
      // We need to figure out the buffer range for which to ask the server for
      // possible code actions.
      //
      // It's probable, but not certain, that the server will do the right
      // thing if we just give it a zero-width range consisting of the cursor
      // position. But if we already know of relevant diagnostic messages, it's
      // only prudent to widen the range to include them.
      diagnostics = intentionsList.getDiagnosticsForBufferPosition(bufferPosition)
      codeActionRange = largestRangeForDiagnosticMessages(diagnostics)
    }

    if (!codeActionRange) {
      const selection = textEditor.getLastSelection()
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
    const actions = await this.delegate.getCodeActions(
      textEditor,
      codeActionRange,
      diagnostics
    ) ?? []

    const actionTitles = new Set()
    for (const action of actions) {
      if (!CodeAction.is(action)) continue
      // Don't allow more than one action with the same title. There's no way
      // for the user to tell them apart, even if they happen to do different
      // things. The first one wins.
      if (actionTitles.has(action.title)) continue
      const result = convertCodeActionToIntentionListOption(action, connection)
      if (!result) continue
      actionTitles.add(action.title)
      results.push(result)
    }

    // Even if the server sent no code actions for the given point, the client
    // may want to add its own intentions at the given buffer position.
    if (intentionsList) {
      const bundles = intentionsList.getLinterMessagesForBufferPosition(bufferPosition)
      for (const bundle of bundles) {
        const extraIntentions = this.delegate.getIntentionsForLinterMessage(bundle, textEditor)
        if (extraIntentions) results.push(...extraIntentions)
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

  onLinterMessageAdded(path: string, message: linter.Message, code: string | null, diag: Diagnostic, callback: () => void): void {
    const { location: { position: range } } = message
    const bundle: MessageBundle = { message, diagnostic: diag, code, path, callback }

    const editors = findAllTextEditorsForPath(path)
    for (const editor of editors) {
      const intentionsList = this.findOrCreateEditorIntentionsList(editor)
      intentionsList.add(range, bundle, diag)
    }
  }
}

function largestRangeForDiagnosticMessages(diagnostics: Diagnostic[]): Range | null {
  let largestRange = null
  for (const diagnostic of diagnostics) {
    const range = Convert.lsRangeToAtomRange(diagnostic.range)
    if (!largestRange) {
      largestRange = range
    } else {
      largestRange = largestRange.union(range)
    }
  }
  return largestRange
}
