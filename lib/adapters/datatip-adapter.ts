import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import * as Utils from "../utils"
import { Hover, LanguageClientConnection, MarkupContent, MarkedString, ServerCapabilities } from "../languageclient"
import { Grammar, Point, TextEditor } from "atom"

/**
 * Public: Adapts the language server protocol "textDocument/hover" to the Atom
 * IDE UI Datatip package.
 */
export default class DatatipAdapter {
  /**
   * Public: Determine whether this adapter can be used to adapt a language
   * server based on the serverCapabilities matrix containing a hoverProvider.
   *
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server to consider.
   *
   * @returns A boolean indicating adapter can adapt the server based on the
   *   given serverCapabilities.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return Boolean(serverCapabilities.hoverProvider)
  }

  /**
   * Public: Get the Datatip for this {@link Point} in a {@link TextEditor} by
   * querying the language server.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will be queried for the hover text/datatip.
   * @param editor The Atom {@link TextEditor} containing the text the Datatip
   *   should relate to.
   * @param point The Atom {@link Point} containing the point within the text
   *   the Datatip should relate to.
   *
   * @returns A {@link Promise} containing the {@link Datatip} to display or
   *   null if no Datatip is available.
   */
  public async getDatatip(
    connection: LanguageClientConnection,
    editor: TextEditor,
    point: Point
  ): Promise<atomIde.Datatip | null> {
    const documentPositionParams = Convert.editorToTextDocumentPositionParams(editor, point)

    const hover = await connection.hover(documentPositionParams)
    if (hover == null || DatatipAdapter.isEmptyHover(hover)) {
      return null
    }

    const range = hover.range == null ? Utils.getWordAtPosition(editor, point) : Convert.lsRangeToAtomRange(hover.range)

    const markedStrings = (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map((str) =>
      DatatipAdapter.convertMarkedString(editor, str)
    )

    return { range, markedStrings }
  }

  private static isEmptyHover(hover: Hover): boolean {
    return (
      hover.contents == null ||
      (typeof hover.contents === "string" && hover.contents.length === 0) ||
      (Array.isArray(hover.contents) && (hover.contents.length === 0 || hover.contents[0] === ""))
    )
  }

  private static convertMarkedString(
    editor: TextEditor,
    markedString: MarkedString | MarkupContent
  ): atomIde.MarkedString {
    if (typeof markedString === "string") {
      return { type: "markdown", value: markedString }
    }

    if ((markedString as MarkupContent).kind) {
      return {
        type: "markdown",
        value: markedString.value,
      }
    }

    let languageString = (markedString as { language: string }).language

    // Must check as <{language: string}> to disambiguate between
    // string and the more explicit object type because MarkedString
    // is a union of the two types
    if (languageString) {
      return {
        type: "snippet",
        grammar: grammarForLanguageString(languageString) ?? editor.getGrammar(),
        value: markedString.value,
      }
    }

    // Catch-all case
    return { type: "markdown", value: markedString.toString() }
  }
}

function grammarForLanguageString(languageString: string): Grammar | undefined {
  // @ts-ignore undocumented API
  let grammar = atom.grammars.treeSitterGrammarForLanguageString(languageString)
  if (grammar) return grammar
  return atom.grammars.grammarForScopeName(`source.${languageString}`)
}
