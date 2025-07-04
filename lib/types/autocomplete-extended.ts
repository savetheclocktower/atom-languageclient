// Autocomplete extention (the properties added by atom-languageclient)
// See this PR: https://github.com/DefinitelyTyped/DefinitelyTyped/pull/51284

import * as ac from "atom/autocomplete-plus"
import { Range } from 'atom'
import * as atomIde from 'atom-ide-base'
import { CompletionItem } from "../languageclient"
import * as ls from "../languageclient"

/**
 * A direct translation of an {@link ls.TextEdit} — using an Atom-style {@link
 * Range} instead of a language-server–style {@link ls.Range}.
 */
type PlainTextEdit = {
  range: Range,
  newText: string
}

/** Adds LSP-specific properties to the Atom `SuggestionBase` type. */
export interface SuggestionBase extends ac.SuggestionBase {
  /**
   * A string that is used when filtering and sorting a set of completion items
   * with a prefix present. When `falsy` the
   * [displayText](#ac.SuggestionBase.displayText) is used. When no prefix, the
   * `sortText` property is used.
   */
  filterText?: string

  /**
   * String representing the replacement prefix from the suggestion's custom
   * start point to the original buffer position the suggestion was gathered
   * from.
   */
  customReplacementPrefix?: string

  /**
   * A {@link atomIde.TextEdit} in the style of Atom-IDE — or the more direct
   * adaptation of the language server’s own {@link ls.TextEdit}.
   *
   * @since autocomplete.provider@5.1.0
   */
  textEdit?: atomIde.TextEdit | PlainTextEdit

  /**
   * Any further edits to make at insertion time. For instance, inserting a new
   * function from another file might also trigger the addition of an import
   * statement.
   *
   * @since autocomplete.provider@5.1.0
   */
  additionalTextEdits?: Array<atomIde.TextEdit | PlainTextEdit>

  /**
   * A list of ranges into which to insert the completion text. Each range in
   * this ist receives the same insertion text.
   *
   * @since autocomplete.provider@5.1.0
   */
  ranges?: Array<Range>

  /** Original {@link CompletionItem}, if available. */
  completionItem?: CompletionItem
}
export type TextSuggestion = SuggestionBase & ac.TextSuggestion
export type SnippetSuggestion = SuggestionBase & ac.SnippetSuggestion
export type Suggestion = TextSuggestion | SnippetSuggestion
