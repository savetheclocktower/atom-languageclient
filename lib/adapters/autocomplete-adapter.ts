import Convert from "../convert"
import * as Utils from "../utils"
import { CancellationTokenSource } from "vscode-jsonrpc"
import { ActiveServer } from "../server-manager"
import { PulsarObjectArrayFilterer as ObjectArrayFilterer } from '../fuzzy-matcher'
import { NullLogger, Logger} from '../logger'
import {
  CompletionContext,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  CompletionParams,
  CompletionTriggerKind,
  InsertTextFormat,
  InsertReplaceEdit,
  LanguageClientConnection,
  Range,
  ServerCapabilities,
  TextEdit,
} from "../languageclient"
import ApplyEditAdapter from "./apply-edit-adapter"
import { Point, TextEditor } from "atom"
import * as ac from "atom/autocomplete-plus"
import { Suggestion, TextSuggestion, SnippetSuggestion, SuggestionBase } from "../types/autocomplete-extended"

/**
 * Defines the behavior of suggestion acceptance. Assume you have "cons|ole" in
 * the editor ( `|` is the cursor position) and the autocomplete suggestion is
 * `const`.
 *
 * - If `false` -> the edits are inserted : const|ole
 * - If `true`` -> the edits are replaced: const|
 */
type ShouldReplace = boolean

/**
 * Holds a list of suggestions generated from the CompletionItem[] list sent by
 * the server, as well as metadata about the context it was collected in.
 */
interface SuggestionCacheEntry {
  /** If `true`, the server will send a list of suggestions to replace this one. */
  isIncomplete: boolean
  /** The point left of the first character in the original prefix sent to the server. */
  triggerPoint: Point
  /** The point right of the last character in the original prefix sent to the server. */
  originalBufferPoint: Point
  /** The trigger string that caused the autocomplete (if any) */
  triggerChar: string
  suggestionMap: Map<Suggestion, PossiblyResolvedCompletionItem>
}

type CompletionItemAdjuster = (
  item: CompletionItem,
  suggestion: ac.AnySuggestion,
  request: ac.SuggestionsRequestedEvent
) => void

class PossiblyResolvedCompletionItem {
  // eslint-disable-next-line no-useless-constructor, no-empty-function
  constructor(public completionItem: CompletionItem, public isResolved: boolean) {}
}

/**
 * Public: Adapts the language server protocol "textDocument/completion" to the
 * Atom AutoComplete+ package.
 */
export default class AutocompleteAdapter {
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return Boolean(serverCapabilities.completionProvider)
  }

  public static canResolve(serverCapabilities: ServerCapabilities): boolean {
    return (
      serverCapabilities.completionProvider != null && Boolean(serverCapabilities.completionProvider.resolveProvider)
    )
  }

  private _suggestionCache: WeakMap<ActiveServer, SuggestionCacheEntry> = new WeakMap()
  private _cancellationTokens: WeakMap<LanguageClientConnection, CancellationTokenSource> = new WeakMap()

  public logger: Logger

  constructor(logger?: Logger) {
    this.logger = logger || new NullLogger()
  }

  /**
   * Public: Obtain suggestion list for AutoComplete+ by querying the language
   * server using the `textDocument/completion` request.
   *
   * @param server An {@link ActiveServer} pointing to the language server to
   *   query.
   * @param request The {@link atom$AutocompleteRequest} to satisfy.
   * @param onDidConvertCompletionItem An optional function that takes a
   *   {@link CompletionItem}, an {@link atom$AutocompleteSuggestion} and an
   *   {@link atom$AutocompleteRequest} allowing you to adjust converted items.
   * @param minimumWordLength The user's configured minimum word length.
   * @param shouldReplace The behavior of suggestion acceptance (see
   *   {@link ShouldReplace}).
   *
   * @returns A {@link Promise} of an array of
   *   {@link atom$AutocompleteSuggestion}s containing the AutoComplete+
   *   suggestions to display.
   */
  public async getSuggestions(
    server: ActiveServer,
    request: ac.SuggestionsRequestedEvent,
    apiVersion: number,
    onDidConvertCompletionItem?: CompletionItemAdjuster,
    minimumWordLength?: number,
    shouldReplace: ShouldReplace = false
  ): Promise<ac.AnySuggestion[]> {
    const triggerChars =
      server.capabilities.completionProvider != null
        ? server.capabilities.completionProvider.triggerCharacters || []
        : []

    // `triggerOnly` is `true` if we have just typed in a trigger character,
    // and is `false` if we have typed additional characters following a
    // trigger character.
    const [triggerChar, triggerOnly] = AutocompleteAdapter.getTriggerCharacter(request, triggerChars)

    if (!this.shouldTrigger(request, triggerChar, minimumWordLength || 0)) {
      return []
    }

    // Get the suggestions either from the cache or by calling the language server
    const suggestions = await this.getOrBuildSuggestions(
      server,
      request,
      triggerChar,
      triggerOnly,
      apiVersion,
      shouldReplace,
      onDidConvertCompletionItem
    )

    // We must update the replacement prefix as characters are added and
    // removed.
    const cache = this._suggestionCache.get(server)!
    const replacementPrefix = request.editor.getTextInBufferRange([
      [cache.triggerPoint.row, cache.triggerPoint.column + cache.triggerChar.length],
      request.bufferPosition,
    ])
    for (const suggestion of suggestions) {
      if (suggestion.customReplacementPrefix) {
        // Having this property means a custom range was provided.
        const len = replacementPrefix.length
        const preReplacementPrefix =
          suggestion.customReplacementPrefix +
          replacementPrefix.substring(len + cache.originalBufferPoint.column - request.bufferPosition.column, len)
        // We cannot replace text after the cursor with the current
        // autocomplete-plus API, so we will simply ignore it for now.
        suggestion.replacementPrefix = preReplacementPrefix
      } else {
        suggestion.replacementPrefix = replacementPrefix
      }
    }

    const filtered = !(request.prefix === "" || (triggerChar !== "" && triggerOnly))
    if (filtered) {
      // Filter the suggestions that have a `filterText` property.
      const validSuggestions = suggestions.filter((sgs) => (
        typeof sgs.filterText === "string"
      )) as Suggestion[] & { filterText: string }[]

      // TODO use `ObjectArrayFilterer.setCandidate` in `_suggestionCache` to
      // avoid creating `ObjectArrayFilterer` every time from scratch.
      const objFilterer = new ObjectArrayFilterer(validSuggestions, "filterText")
      // zadeh returns an array of the selected `Suggestion`s.
      return objFilterer.filter(request.prefix) as any as Suggestion[]
    } else {
      return suggestions
    }
  }

  private shouldTrigger(request: ac.SuggestionsRequestedEvent, triggerChar: string, minWordLength: number): boolean {
    return (
      request.activatedManually || triggerChar !== "" || minWordLength <= 0 || request.prefix.length >= minWordLength
    )
  }

  private async getOrBuildSuggestions(
    server: ActiveServer,
    request: ac.SuggestionsRequestedEvent,
    triggerChar: string,
    triggerOnly: boolean,
    apiVersion: number,
    shouldReplace: ShouldReplace,
    onDidConvertCompletionItem?: CompletionItemAdjuster
  ): Promise<Suggestion[]> {
    this.logger.log(`getOrBuildSuggestions:`, request)
    const cache = this._suggestionCache.get(server)

    const triggerColumn =
      triggerChar !== "" && triggerOnly
        ? request.bufferPosition.column - triggerChar.length
        : request.bufferPosition.column - request.prefix.length - triggerChar.length
    const triggerPoint = new Point(request.bufferPosition.row, triggerColumn)

    // Do we have complete cached suggestions that are still valid for this
    // request?
    if (
      cache &&
      !cache.isIncomplete &&
      cache.triggerChar === triggerChar &&
      cache.triggerPoint.isEqual(triggerPoint) &&
      cache.originalBufferPoint.isLessThanOrEqual(request.bufferPosition)
    ) {
      this.logger.log(
        'cache is valid!',
        !!cache,
        !cache.isIncomplete,
        cache.triggerChar,
        triggerChar,
        cache.triggerPoint,
        triggerPoint,
        cache.originalBufferPoint,
        request.bufferPosition
      )
      let result = Array.from(cache.suggestionMap.keys())
      this.logger.log('returning cached!', result)
      return result
    }

    // Our cached suggestions can't be used, so we'll obtain new ones from the
    // language server.
    this.logger.log('Getting completions…')
    let completions = await Utils.doWithCancellationToken(
      server.connection,
      this._cancellationTokens,
      (cancellationToken) =>
        server.connection.completion(
          AutocompleteAdapter.createCompletionParams(request, triggerChar, triggerOnly),
          cancellationToken
        )
    )

    // The spec guarantees all edits are on the same line, so we only need to
    // check the columns.
    const triggerColumns: [number, number] = [triggerPoint.column, request.bufferPosition.column]

    // Setup the cache for subsequent filtered results
    const isComplete = completions === null || Array.isArray(completions) || !completions.isIncomplete

    const suggestionMap = this.completionItemsToSuggestions(
      completions,
      request,
      apiVersion,
      triggerColumns,
      shouldReplace,
      onDidConvertCompletionItem
    )
    this._suggestionCache.set(server, {
      isIncomplete: !isComplete,
      triggerChar,
      triggerPoint,
      originalBufferPoint: request.bufferPosition,
      suggestionMap,
    })

    let result = Array.from(suggestionMap.keys())
    return result
  }

  /**
   * Public: Obtain a complete version of a suggestion with additional
   * information the language server can provide by way of the
   * `completionItem/resolve` request.
   *
   * @param server An {@link ActiveServer} pointing to the language server to
   *   query.
   * @param suggestion An {@link atom$AutocompleteSuggestion} suggestion that
   *   should be resolved.
   * @param request An object with the AutoComplete+ request to satisfy.
   * @param onDidConvertCompletionItem An optional function that takes a
   *   {@link CompletionItem}, an {@link atom$AutocompleteSuggestion} and an
   *   {@link atom$AutocompleteRequest} allowing you to adjust converted items.
   *
   * @returns A {@link Promise} of an {@link atom$AutocompleteSuggestion} with
   *   the resolved AutoComplete+ suggestion.
   */
  public async completeSuggestion(
    server: ActiveServer,
    suggestion: ac.AnySuggestion,
    request: ac.SuggestionsRequestedEvent,
    onDidConvertCompletionItem?: CompletionItemAdjuster
  ): Promise<ac.AnySuggestion> {
    const cache = this._suggestionCache.get(server)
    if (cache) {
      const possiblyResolvedCompletionItem = cache.suggestionMap.get(suggestion)
      if (possiblyResolvedCompletionItem != null && !possiblyResolvedCompletionItem.isResolved) {
        const resolvedCompletionItem = await server.connection.completionItemResolve(
          possiblyResolvedCompletionItem.completionItem
        )
        if (resolvedCompletionItem != null) {
          AutocompleteAdapter.resolveSuggestion(resolvedCompletionItem, suggestion, request, onDidConvertCompletionItem)
          possiblyResolvedCompletionItem.isResolved = true
        }
      }
    }
    return suggestion
  }

  public static resolveSuggestion(
    resolvedCompletionItem: CompletionItem,
    suggestion: ac.AnySuggestion,
    request: ac.SuggestionsRequestedEvent,
    onDidConvertCompletionItem?: CompletionItemAdjuster
  ): void {
    // only the `documentation` and `detail` properties may change when resolving
    AutocompleteAdapter.applyDetailsToSuggestion(resolvedCompletionItem, suggestion)
    if (onDidConvertCompletionItem != null) {
      onDidConvertCompletionItem(resolvedCompletionItem, suggestion as ac.AnySuggestion, request)
    }
  }

  /**
   * Public: Get the trigger character that caused the autocomplete (if any).
   * This is required because AutoComplete-plus does not have trigger
   * characters. Although the terminology is 'character' we treat them as
   * variable length strings as this will almost certainly change in the future
   * to support '->', etc.
   *
   * @param request An array of {@link atom$AutocompleteSuggestion}s to locate
   *   the prefix, editor, bufferPosition etc.
   * @param triggerChars The array of strings that can be trigger characters.
   *
   * @returns A [string, boolean] tuple where the string is the matching
   * trigger character (or an empty string if one was not matched), and the
   * boolean is true if the trigger character is in request.prefix, and false
   * if it is in the word before request.prefix. The boolean return value has
   * no meaning if the string return value is an empty string.
   */
  public static getTriggerCharacter(request: ac.SuggestionsRequestedEvent, triggerChars: string[]): [string, boolean] {
    // autocomplete-plus considers text after a symbol to be a new trigger. So
    // we should look backward from the current cursor position to see if one
    // is there and thus simulate it.
    const buffer = request.editor.getBuffer()
    const cursor = request.bufferPosition
    const prefixStartColumn = cursor.column - request.prefix.length
    for (const triggerChar of triggerChars) {
      if (request.prefix.endsWith(triggerChar)) {
        return [triggerChar, true]
      }
      if (prefixStartColumn >= triggerChar.length) {
        // Far enough along a line to fit the trigger char
        const start = new Point(cursor.row, prefixStartColumn - triggerChar.length)
        const possibleTrigger = buffer.getTextInRange([start, [cursor.row, prefixStartColumn]])
        if (possibleTrigger === triggerChar) {
          // The text before our trigger is a trigger char!
          return [triggerChar, false]
        }
      }
    }

    // There was no explicit trigger char
    return ["", false]
  }

  /**
   * Public: Create {@link TextDocumentPositionParams} to be sent to the
   * language server based on the editor and position from the
   * AutoCompleteRequest.
   *
   * @param request The {@link atom$AutocompleteRequest} to obtain the editor
   *   from.
   * @param triggerPoint The {@link atom$Point} where the trigger started.
   *
   * @returns A string containing the prefix including the trigger character.
   */
  public static getPrefixWithTrigger(request: ac.SuggestionsRequestedEvent, triggerPoint: Point): string {
    return request.editor.getBuffer().getTextInRange([[triggerPoint.row, triggerPoint.column], request.bufferPosition])
  }

  /**
   * Public: Create {@link CompletionParams} to be sent to the language server
   * based on the editor and position from the AutoComplete request, etc.
   *
   * @param request The {@link atom$AutocompleteRequest} containing the
   *   request details.
   * @param triggerCharacter The string containing the trigger character (empty
   *   if none).
   * @param triggerOnly A boolean representing whether this completion is
   *   triggered right after a trigger character.
   *
   * @returns A {@link CompletionParams} with the keys:
   *
   *   - `textDocument` the language server protocol textDocument
   *     identification.
   *   - `position` the position within the text document to display the
   *     completion request for.
   *   - `context` containing the trigger character and kind.
   */
  public static createCompletionParams(
    request: ac.SuggestionsRequestedEvent,
    triggerCharacter: string,
    triggerOnly: boolean
  ): CompletionParams {
    return {
      textDocument: Convert.editorToTextDocumentIdentifier(request.editor),
      position: Convert.pointToPosition(request.bufferPosition),
      context: AutocompleteAdapter.createCompletionContext(triggerCharacter, triggerOnly),
    }
  }

  /**
   * Public: Create {@link CompletionContext} to be sent to the language server
   * based on the trigger character.
   *
   * @param triggerCharacter The string containing the trigger character, or
   *   '' if none.
   * @param triggerOnly A boolean representing whether this completion is
   *   triggered right after a trigger character.
   *
   * @returns A {@link CompletionContext} that specifies the triggerKind and
   *   the triggerCharacter if there is one.
   */
  public static createCompletionContext(triggerCharacter: string, triggerOnly: boolean): CompletionContext {
    if (triggerCharacter === "") {
      return { triggerKind: CompletionTriggerKind.Invoked }
    } else {
      return triggerOnly
        ? { triggerKind: CompletionTriggerKind.TriggerCharacter, triggerCharacter }
        : { triggerKind: CompletionTriggerKind.TriggerForIncompleteCompletions, triggerCharacter }
    }
  }

  /**
   * Public: Convert a language server protocol CompletionItem array or CompletionList to an array of ordered
   * AutoComplete+ suggestions.
   *
   * @param completionItems An array of {@link CompletionItem} objects or a
   *   {@link CompletionList} containing completion items to be converted.
   * @param request The {@link atom$AutocompleteRequest} to satisfy.
   * @param apiVersion The version of the `autocomplete.provider` service we're
   *   using.
   * @param shouldReplace The behavior of suggestion acceptance (see
   *   {@link ShouldReplace}).
   * @param onDidConvertCompletionItem A function that takes a
   *   {@link CompletionItem}, an {@link atom$AutocompleteSuggestion} and an
   *   {@link atom$AutocompleteRequest} allowing you to adjust converted items.
   *
   * @returns A {@link Map} of AutoComplete+ suggestions ordered by the
   *   CompletionItems sortText.
   */
  public completionItemsToSuggestions(
    completionItems: CompletionItem[] | CompletionList | null,
    request: ac.SuggestionsRequestedEvent,
    apiVersion: number,
    triggerColumns: [number, number],
    shouldReplace: ShouldReplace,
    onDidConvertCompletionItem?: CompletionItemAdjuster
  ): Map<Suggestion, PossiblyResolvedCompletionItem> {
    const completionsArray = Array.isArray(completionItems)
      ? completionItems
      : (completionItems && completionItems.items) || []
    return new Map(
      completionsArray
        .sort((a, b) => (a.sortText || a.label).localeCompare(b.sortText || b.label))
        .map<[Suggestion, PossiblyResolvedCompletionItem]>((s) => [
          AutocompleteAdapter.completionItemToSuggestion(
            s,
            {} as Suggestion,
            request,
            apiVersion,
            triggerColumns,
            shouldReplace,
            onDidConvertCompletionItem
          ),
          new PossiblyResolvedCompletionItem(s, false),
        ])
    )
  }

  /**
   * Public: Convert a language server protocol CompletionItem to an
   * AutoComplete+ suggestion.
   *
   * @param item An {@link CompletionItem} containing a completion item to be
   *   converted.
   * @param suggestion A {@link atom$AutocompleteSuggestion} to have the
   *   conversion applied to.
   * @param request The {@link atom$AutocompleteRequest} to satisfy.
   * @param apiVersion The version of the `autocomplete.provider` service we're
   *   using.
   * @param shouldReplace The behavior of suggestion acceptance (see
   *   {@link ShouldReplace}).
   * @param onDidConvertCompletionItem A function that takes a
   *   {@link CompletionItem}, an {@link atom$AutocompleteSuggestion} and an
   *   {@link atom$AutocompleteRequest} allowing you to adjust converted items.
   *
   * @returns The {@link atom$AutocompleteSuggestion} passed in as a suggestion
   *   with the conversion applied.
   */
  public static completionItemToSuggestion(
    item: CompletionItem,
    suggestion: Suggestion,
    request: ac.SuggestionsRequestedEvent,
    apiVersion: number,
    triggerColumns: [number, number],
    shouldReplace: ShouldReplace,
    onDidConvertCompletionItem?: CompletionItemAdjuster
  ): Suggestion {
    AutocompleteAdapter.applyCompletionItemToSuggestion(item, suggestion as TextSuggestion, apiVersion, shouldReplace)

    if (apiVersion < 5.1) {
      // If we're using `autocomplete.provider` v5.1.0 or above, it should
      // already be using the `textEdit` property to apply a suggestion. This
      // is therefore redundant and will be unused.
      AutocompleteAdapter.applyTextEditToSuggestion(
        item.textEdit,
        request.editor,
        apiVersion,
        triggerColumns,
        request.bufferPosition,
        suggestion as TextSuggestion,
        shouldReplace
      )
    }

    AutocompleteAdapter.applySnippetToSuggestion(item, suggestion as SnippetSuggestion)
    if (onDidConvertCompletionItem != null) {
      onDidConvertCompletionItem(item, suggestion as ac.AnySuggestion, request)
    }

    return suggestion
  }

  /**
   * Public: Convert the primary parts of a language server protocol
   * CompletionItem to an AutoComplete+ suggestion.
   *
   * @param item An {@link CompletionItem} containing the completion items to
   *   be merged into.
   * @param suggestion The {@link Suggestion} to merge the conversion into.
   *
   * @returns The {@link Suggestion} with details added from the
   *   {@link CompletionItem}.
   */
  public static applyCompletionItemToSuggestion(
    item: CompletionItem,
    suggestion: TextSuggestion,
    apiVersion: number,
    shouldReplace: boolean = false
  ): void {
    suggestion.text = item.insertText || item.label
    suggestion.filterText = item.label // item.filterText || item.label
    suggestion.displayText = item.label
    suggestion.type = AutocompleteAdapter.completionKindToSuggestionType(item.kind)
    AutocompleteAdapter.applyDetailsToSuggestion(item, suggestion)

    // We can add some properties that are more precise and conform better to
    // LSP conventions. We originally thought we could attach this data even
    // under older versions of `autocomplete.provider`; but we need to know
    // whether `autocomplete-plus` will apply additional text edits or whether
    // we have to do it ourselves.
    if (apiVersion >= 5.1) {
      // Version 5.1.0 of `autocomplete.provider` added the ability to apply an
      // arbitrary `TextEdit` instead of throwing a bunch of heuristics at it.
      if (item.textEdit && TextEdit.is(item.textEdit)) {
        suggestion.textEdit = Convert.convertLsTextEdit(item.textEdit)
      } else if (item.textEdit && InsertReplaceEdit.is(item.textEdit)) {
        suggestion.textEdit = Convert.convertLsInsertReplaceEdit(item.textEdit, shouldReplace)
      }

      // Version 5.1.0 of `autocomplete.provider` also added the ability to apply
      // additional `TextEdit`s upon suggestion insertion.
      if (item.additionalTextEdits) {
        suggestion.additionalTextEdits = Convert.convertLsTextEdits(item.additionalTextEdits)
      }
    }

    // Attach the original completion item. This is not part of the service
    // contract, but it's useful for debugging and for further processing of
    // suggestions by IDE packages.
    suggestion.completionItem = item
  }

  public static applyDetailsToSuggestion(item: CompletionItem, suggestion: Suggestion): void {
    suggestion.rightLabel = item.detail

    // Older format, can't know what it is so assign to both and hope for best
    if (typeof item.documentation === "string") {
      suggestion.descriptionMarkdown = item.documentation
      suggestion.description = item.documentation
    }

    if (item.documentation != null && typeof item.documentation === "object") {
      // Newer format specifies the kind of documentation, assign appropriately
      if (item.documentation.kind === "markdown") {
        suggestion.descriptionMarkdown = item.documentation.value
      } else {
        suggestion.description = item.documentation.value
      }
    }
  }

  /**
   * Public: Applies the textEdit part of a language server protocol
   * {@link CompletionItem} to an autocomplete-plus {@link Suggestion} via the
   * `replacementPrefix` and `text` properties.
   *
   * @param textEdit A {@link TextEdit} from a CompletionItem to apply.
   * @param editor An Atom {@link TextEditor} used to obtain the necessary
   *   text replacement.
   * @param _apiVersion The version of the `autocomplete.provider` service we're
   *   using.
   * @param suggestion An {@link atom$AutocompleteSuggestion} to set the
   *   replacementPrefix and text properties of.
   *
   * @param shouldReplace The behavior of suggestion acceptance (see
   *   {@link ShouldReplace}).
   */
  public static applyTextEditToSuggestion(
    textEdit: TextEdit | InsertReplaceEdit | undefined,
    editor: TextEditor,
    _apiVersion: number,
    _triggerColumns: [number, number],
    originalBufferPosition: Point,
    suggestion: TextSuggestion,
    shouldReplace: ShouldReplace
  ): void {
    if (!textEdit) return

    let range: Range
    if ("range" in textEdit) {
      range = textEdit.range
    } else if (shouldReplace) {
      range = textEdit.replace
    } else {
      range = textEdit.insert
    }

    const atomRange = Convert.lsRangeToAtomRange(range)
    suggestion.customReplacementPrefix = editor.getTextInBufferRange([atomRange.start, originalBufferPosition])

    // TODO: Needed to fix TypeScript completions. This line seems flat-out
    // wrong in all contexts, but maybe it's failing only for TypeScript's
    // language server and not others.

    // suggestion.text = textEdit.newText
  }

  /**
   * Handle additional text edits after a suggestion insert, e.g.
   * `additionalTextEdits`.
   *
   * `additionalTextEdits` are An optional array of additional text edits that
   * are applied when selecting this completion. Edits must not overlap
   * (including the same insert position) with the main edit nor with
   * themselves.
   *
   * Additional text edits should be used to change text unrelated to the
   * current cursor position (for example adding an import statement at the top
   * of the file if the completion item will insert an unqualified type).
   */
  public static applyAdditionalTextEdits(event: ac.SuggestionInsertedEvent): void {
    const suggestion = event.suggestion as SuggestionBase
    const additionalEdits = suggestion.completionItem?.additionalTextEdits
    const buffer = event.editor.getBuffer()

    ApplyEditAdapter.applyEdits(event.editor, Convert.convertLsTextEdits(additionalEdits))
    buffer.groupLastChanges()
  }

  public static handlePostInsertionTasks(event: ac.SuggestionInsertedEvent, apiVersion: number) {
    if (apiVersion < 5.1) {
      // With version 5.1 of the `autocomplete.provider` service,
      // `autocomplete-plus` can handle `additionalTextEdits` itself. But
      // before that version, we must take care of it on our own.
      this.applyAdditionalTextEdits(event)
    }
  }

  /**
   * Public: Adds a snippet to the suggestion if the CompletionItem contains
   * snippet-formatted text.
   *
   * @param item A {@link CompletionItem} containing the completion items to be
   *   merged into.
   * @param suggestion The {@link atom$AutocompleteSuggestion} to merge the
   *   conversion into.
   */
  public static applySnippetToSuggestion(item: CompletionItem, suggestion: SnippetSuggestion): void {
    if (item.insertTextFormat === InsertTextFormat.Snippet) {
      suggestion.snippet = item.textEdit != null ? item.textEdit.newText : item.insertText || item.label
    }
  }

  /**
   * Public: Obtain the textual suggestion type required by AutoComplete+ that
   * most closely maps to the numeric completion kind supplies by the language
   * server.
   *
   * @param kind A number that represents the suggestion kind to be converted.
   *
   * @returns A string containing the AutoComplete+ suggestion type equivalent
   *   to the given completion kind.
   */
  public static completionKindToSuggestionType(kind: number | undefined): string {
    switch (kind) {
      case CompletionItemKind.Constant:
        return "constant"
      case CompletionItemKind.Method:
        return "method"
      case CompletionItemKind.Function:
      case CompletionItemKind.Constructor:
        return "function"
      case CompletionItemKind.Field:
      case CompletionItemKind.Property:
        return "property"
      case CompletionItemKind.Variable:
        return "variable"
      case CompletionItemKind.Class:
        return "class"
      case CompletionItemKind.Struct:
      case CompletionItemKind.TypeParameter:
        return "type"
      case CompletionItemKind.Operator:
        return "selector"
      case CompletionItemKind.Interface:
        return "mixin"
      case CompletionItemKind.Module:
        return "module"
      case CompletionItemKind.Unit:
        return "builtin"
      case CompletionItemKind.Enum:
      case CompletionItemKind.EnumMember:
        return "enum"
      case CompletionItemKind.Keyword:
        return "keyword"
      case CompletionItemKind.Snippet:
        return "snippet"
      case CompletionItemKind.File:
      case CompletionItemKind.Folder:
        return "import"
      case CompletionItemKind.Reference:
        return "require"
      default:
        return "value"
    }
  }
}

/**
 * Normalizes the given grammar scope for the AutoComplete package so it always
 * starts with `.`. Based on
 * https://github.com/atom/autocomplete-plus/wiki/Autocomplete-Providers
 *
 * @param grammarScope Such as 'source.python' or '.source.python'.
 *
 * @returns The normalized grammarScope such as `.source.python`.
 */
export function grammarScopeToAutoCompleteSelector(grammarScope: string): string {
  return grammarScope.includes(".") && grammarScope[0] !== "." ? `.${grammarScope}` : grammarScope
}
