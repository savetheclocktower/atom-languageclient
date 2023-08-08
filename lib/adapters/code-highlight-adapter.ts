import assert = require("assert")
import Convert from "../convert"
import { Point, TextEditor, Range } from "atom"
import { LanguageClientConnection, ServerCapabilities } from "../languageclient"

export default class CodeHighlightAdapter {
  /** @returns A {Boolean} indicating this adapter can adapt the server based on the given serverCapabilities. */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return serverCapabilities.documentHighlightProvider === true
  }

  /**
   * Public: Creates highlight markers for a given editor position. Throws an
   * error if documentHighlightProvider is not a registered capability.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that provides highlights.
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server that will be used.
   * @param editor The Atom {@link TextEditor} containing the text to be
   *   highlighted.
   * @param position The Atom {@link Point} to fetch highlights for.
   *
   * @returns A {@link Promise} of an array of {@link Range}s to be turned into highlights.
   */
  public static async highlight(
    connection: LanguageClientConnection,
    serverCapabilities: ServerCapabilities,
    editor: TextEditor,
    position: Point
  ): Promise<Range[]> {
    assert(serverCapabilities.documentHighlightProvider, "Must have the documentHighlight capability")
    const highlights = await connection.documentHighlight(Convert.editorToTextDocumentPositionParams(editor, position))
    if (highlights === null) {
      return []
    }
    return highlights.map((highlight) => {
      return Convert.lsRangeToAtomRange(highlight.range)
    })
  }
}
