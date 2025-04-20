import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import {
  LanguageClientConnection,
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
  DocumentOnTypeFormattingParams,
  FormattingOptions,
  ServerCapabilities,
  TextEdit
} from "../languageclient"
import { TextEditor, Range, Point } from "atom"
import DocumentSyncAdapter from "./document-sync-adapter"

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
      Boolean(serverCapabilities.documentRangeFormattingProvider) ||
        Boolean(serverCapabilities.documentFormattingProvider)
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
    range: Range,
    documentSyncAdapter?: DocumentSyncAdapter
  ): Promise<atomIde.TextEdit[]> {
    if (serverCapabilities.documentRangeFormattingProvider) {
      return CodeFormatAdapter.formatRange(connection, editor, range, documentSyncAdapter)
    }

    if (serverCapabilities.documentFormattingProvider) {
      return CodeFormatAdapter.formatDocument(connection, editor, documentSyncAdapter)
    }

    throw new Error("Cannot format document, language server does not support it")
  }

  /**
  * Public: Format the entire document of an Atom {@link TextEditor} by using
  * a given language server.
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
    editor: TextEditor,
    documentSyncAdapter?: DocumentSyncAdapter
  ): Promise<atomIde.TextEdit[]> {
    let params = CodeFormatAdapter.createDocumentFormattingParams(editor)
    let edits = await this.whileMaintainingDocumentVersion(
      editor,
      async () => await connection.documentFormatting(params),
      documentSyncAdapter
    )
    let result = Convert.convertLsTextEdits(edits)
    return result
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
    range: Range,
    documentSyncAdapter?: DocumentSyncAdapter
  ): Promise<atomIde.TextEdit[]> {
    let edits = await this.whileMaintainingDocumentVersion(
      editor,
      async () => {
        return await connection.documentRangeFormatting(
          CodeFormatAdapter.createDocumentRangeFormattingParams(editor, range)
        )
      },
      documentSyncAdapter
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

  /**
   * Private: Wraps an action that retrieves edits from a language server and
   * ensures that the document version didn't change during the request.
   *
   * The Atom IDE contract for code formatting does not enable the consumer to
   * detect whether the edits are still valid — i.e., whether they were meant
   * to be applied to the current “version” of the buffer or some version from
   * the past.
   *
   * Even the LSP spec doesn’t include version information in the returned data
   * for code formatting requests. (It includes such information in
   * `WorkspaceEdit`s, but this isn’t a `WorkspaceEdit`.)
   *
   * This is a problem for consumers. The `TextEdit` objects could give us
   * `oldText` properties as a sanity check, but they don’t. It’s risky to
   * apply edits if you’re not sure whether they’re stale.
   *
   * We are not guaranteed to have a {@link DocumentSyncAdapter}, but if we do
   * have one, we can mitigate this limitation by doing our own comparison. We
   * track and increment the buffer version number with each edit already, so
   * we can use that information to decide whether the edits we just received
   * from the language server are already invalid by the time we get them back.
   *
   * If so, we can decide what to do. Since this probably just means a race
   * between two would-be format-on-save strategies, we can decide to ask again
   * on the theory that the language server will give us different results. If
   * we’re out of retries, we’ll return `null`.
   *
   * A `null` response is pretty opaque, but it at least is distinguished from
   * the typical “no reformatting needed” response, which is an empty array. So
   * a consumer will at least be able to tell that this code formatting request
   * failed, though they won’t know why.
   *
   * In the event that we don’t have a {@link DocumentSyncAdapter}, it’ll be
   * because the language server itself isn’t capable of it, so we’ll fall back
   * to the riskier behavior.
   */
  private static async whileMaintainingDocumentVersion(
    editor: TextEditor,
    fn: () => Promise<TextEdit[] | null>,
    documentSyncAdapter?: DocumentSyncAdapter,
    retryCount: number = 1
  ): Promise<TextEdit[] | null> {
    if (!documentSyncAdapter) return await fn()

    let editorSyncAdapter = documentSyncAdapter.getEditorSyncAdapter(editor)
    let beforeVersion = editorSyncAdapter?.getVersion() ?? -1
    let edits = await fn()
    let afterVersion = editorSyncAdapter?.getVersion() ?? -1
    if (beforeVersion !== afterVersion) {
      if (retryCount <= 0) return null
      return await this.whileMaintainingDocumentVersion(
        editor,
        fn,
        documentSyncAdapter,
        retryCount - 1
      )
    }
    return edits
  }

}
