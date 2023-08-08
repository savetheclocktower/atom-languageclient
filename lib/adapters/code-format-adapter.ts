import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import {
  LanguageClientConnection,
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
  DocumentOnTypeFormattingParams,
  FormattingOptions,
  ServerCapabilities,
} from "../languageclient"
import { TextEditor, Range, Point } from "atom"

/**
 * Public: Adapts the language server protocol "textDocument/completion" to the
 * Atom IDE UI Code-format package.
 */
export default class CodeFormatAdapter {
  /**
   * Public: Determine whether this adapter can be used to adapt a language
   * server based on the serverCapabilities matrix containing either a
   * documentFormattingProvider or a documentRangeFormattingProvider.
   *
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server to consider.
   *
   * @returns A boolean indicating whether the adapter can adapt the server
   *   based on the given serverCapabilities.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return (
      serverCapabilities.documentRangeFormattingProvider === true ||
      serverCapabilities.documentFormattingProvider === true
    )
  }

  /**
   * Public: Format text in the editor using the given language server
   * connection and an optional range. If the server does not support range
   * formatting then range will be ignored and the entire document formatted.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will format the text.
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server that will be used.
   * @param editor The Atom {@link TextEditor} containing the text that will be
   *   formatted.
   * @param range The optional Atom {@link Range} containing the subset of the
   *   text to be formatted.
   *
   * @returns An array of {@link TextEdit} objects.
   */
  public static format(
    connection: LanguageClientConnection,
    serverCapabilities: ServerCapabilities,
    editor: TextEditor,
    range: Range
  ): Promise<atomIde.TextEdit[]> {
    if (serverCapabilities.documentRangeFormattingProvider) {
      return CodeFormatAdapter.formatRange(connection, editor, range)
    }

    if (serverCapabilities.documentFormattingProvider) {
      return CodeFormatAdapter.formatDocument(connection, editor)
    }

    throw new Error("Can not format document, language server does not support it")
  }

  /**
   * Public: Format the entire document of an Atom {@link TextEditor} by using a given language server.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will format the text.
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   *
   * @returns A {@link Promise} of an array of {@link TextEdit} objects that
   *   can be applied to the editor to format the document.
   */
  public static async formatDocument(
    connection: LanguageClientConnection,
    editor: TextEditor
  ): Promise<atomIde.TextEdit[]> {
    const edits = await connection.documentFormatting(CodeFormatAdapter.createDocumentFormattingParams(editor))
    return Convert.convertLsTextEdits(edits)
  }

  /**
   * Public: Create {@link DocumentFormattingParams} to be sent to the language
   * server when requesting an entire document is formatted.
   *
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   *
   * @returns A {@link DocumentFormattingParams} containing the identity of the
   *   text document as well as options to be used in formatting the document
   *   such as tab size and tabs vs spaces.
   */
  public static createDocumentFormattingParams(editor: TextEditor): DocumentFormattingParams {
    return {
      textDocument: Convert.editorToTextDocumentIdentifier(editor),
      options: CodeFormatAdapter.getFormatOptions(editor),
    }
  }

  /**
   * Public: Format a range within an Atom {@link TextEditor} by using a given language server.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will format the text.
   * @param range The Atom {@link Range} containing the range of text that
   *   should be formatted.
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   *
   * @returns A {@link Promise} of an array of {@link TextEdit} objects that
   *   can be applied to the Atom TextEditor to format the document.
   */
  public static async formatRange(
    connection: LanguageClientConnection,
    editor: TextEditor,
    range: Range
  ): Promise<atomIde.TextEdit[]> {
    const edits = await connection.documentRangeFormatting(
      CodeFormatAdapter.createDocumentRangeFormattingParams(editor, range)
    )
    return Convert.convertLsTextEdits(edits)
  }

  /**
   * Public: Create {@link DocumentRangeFormattingParams} to be sent to the
   * language server when requesting an entire document is formatted.
   *
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   * @param range The Atom {@link Range} containing the range of text that
   *   should be formatted.
   *
   * @returns A {@link DocumentRangeFormattingParams} containing the identity
   * of the text document, the range of the text to be formatted as well as
   * the options to be used in formatting the document such as tab size and
   * tabs vs spaces.
   */
  public static createDocumentRangeFormattingParams(editor: TextEditor, range: Range): DocumentRangeFormattingParams {
    return {
      textDocument: Convert.editorToTextDocumentIdentifier(editor),
      range: Convert.atomRangeToLSRange(range),
      options: CodeFormatAdapter.getFormatOptions(editor),
    }
  }

  /**
   * Public: Format on type within an Atom {@link TextEditor} by using a given language server.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will format the text.
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   * @param point The {@link Point} at which the document to be formatted.
   * @param character A character that triggered formatting request.
   *
   * @returns A {@link Promise} of an array of {@link TextEdit} objects that
   *   can be applied to the editor to format the document.
   */
  public static async formatOnType(
    connection: LanguageClientConnection,
    editor: TextEditor,
    point: Point,
    character: string
  ): Promise<atomIde.TextEdit[]> {
    const edits = await connection.documentOnTypeFormatting(
      CodeFormatAdapter.createDocumentOnTypeFormattingParams(editor, point, character)
    )
    return Convert.convertLsTextEdits(edits)
  }

  /**
   * Public: Create {@link DocumentOnTypeFormattingParams} to be sent to the
   * language server when requesting an entire document is formatted.
   *
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   * @param point The {@link Point} at which the document to be formatted.
   * @param character A character that triggered formatting request.
   *
   * @returns A {@link DocumentOnTypeFormattingParams} containing the identity
   *   of the text document, the position of the text to be formatted, the
   *   character that triggered formatting request as well as the options to be
   *   used in formatting the document such as tab size and tabs vs spaces.
   */
  public static createDocumentOnTypeFormattingParams(
    editor: TextEditor,
    point: Point,
    character: string
  ): DocumentOnTypeFormattingParams {
    return {
      textDocument: Convert.editorToTextDocumentIdentifier(editor),
      position: Convert.pointToPosition(point),
      ch: character,
      options: CodeFormatAdapter.getFormatOptions(editor),
    }
  }

  /**
   * Public: Create {@link DocumentRangeFormattingParams} to be sent to the language server when requesting an entire document
   * is formatted.
   *
   * @param editor The Atom {@link TextEditor} containing the document to be
   *   formatted.
   *
   * @returns The {@link FormattingOptions} to be used containing the keys:
   *
   *   - `tabSize` The number of spaces a tab represents.
   *   - `insertSpaces` true if spaces should be used, false for tab characters.
   */
  public static getFormatOptions(editor: TextEditor): FormattingOptions {
    return {
      tabSize: editor.getTabLength(),
      insertSpaces: editor.getSoftTabs(),
    }
  }
}
