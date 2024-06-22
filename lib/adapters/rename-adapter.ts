import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import { Point, Range, TextEditor } from "atom"
import {
  LanguageClientConnection,
  RenameParams,
  PrepareRenameParams,
  ServerCapabilities,
  TextDocumentEdit,
  TextEdit,
} from "../languageclient"
import * as lsp from "vscode-languageserver-protocol"

// The “enhanced” refactor provider is one that allows the frontend package to
// take advantage of a “prepare” phase, if the server supports it.
export type EnhancedRefactorProvider = atomIde.RefactorProvider & {
  prepareRename?(editor: TextEditor, position: Point): Promise<Range | boolean | null>
}

export default class RenameAdapter {
  /**
   * Whether the server provides rename support.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return Boolean(serverCapabilities.renameProvider)
  }

  /**
   * Whether the server supports the `textDocument/prepareRename` request.
   */
  public static canAdaptPrepare(serverCapabilities: ServerCapabilities): boolean {
    let provider = serverCapabilities.renameProvider
    return typeof provider === 'object' && !!provider?.prepareProvider
  }

  /**
   * Attempt to execute a rename. The server may respond with a list of changes
   * which we can choose to apply to our project.
   *
   * @returns A set of edits to apply to various files, or else `null` if no
   *   edits should take place.
   */
  public static async getRename(
    connection: LanguageClientConnection,
    editor: TextEditor,
    point: Point,
    newName: string
  ): Promise<Map<atomIde.IdeUri, atomIde.TextEdit[]> | null> {
    const edit = await connection.rename(
      RenameAdapter.createRenameParams(editor, point, newName)
    )
    if (edit === null) { return null }

    if (edit.documentChanges) {
      return RenameAdapter.convertDocumentChanges(<TextDocumentEdit[]>edit.documentChanges)
    } else if (edit.changes) {
      return RenameAdapter.convertChanges(edit.changes)
    } else {
      return null
    }
  }

  /**
   * Begin a rename request. The server may respond with a range indicating
   * which token can be renamed from the given cursor position.
   *
   * @returns A promise that fulfills with either a boolean (indicating whether
   *   a rename can take place at this position), a range (indicating the range
   *   of the rename-able token), or `null` (indicating an error).
   */
  public static async getPrepareRename(
    connection: LanguageClientConnection,
    editor: TextEditor,
    point: Point
  ): Promise<Range | boolean | null> {
    const response = await connection.prepareRename(
      RenameAdapter.createRenameParams(editor, point, null)
    )

    if (response === null) { return null }

    if (typeof response === 'boolean') { return response }

    if ('defaultBehavior' in response) {
      return response.defaultBehavior
    }

    if (lsp.Range.is(response)) {
      return Convert.lsRangeToAtomRange(response)
    }
    if ('range' in response) {
      return Convert.lsRangeToAtomRange(response.range)
    }

    // TODO: This can return an error, so figure out a way to surface that
    // error. The `refactor` service might not allow for this.
    return null
  }

  public static createRenameParams(editor: TextEditor, point: Point, newName: null) : PrepareRenameParams
  public static createRenameParams(editor: TextEditor, point: Point, newName: string) : RenameParams
  public static createRenameParams(editor: TextEditor, point: Point, newName: string | null): RenameParams | PrepareRenameParams {
    let response = {
      textDocument: Convert.editorToTextDocumentIdentifier(editor),
      position: Convert.pointToPosition(point),
    }
    if (newName !== null) {
      (response as RenameParams).newName = newName
    }
    return response
  }

  /**
   * Converts a set of LSP `TextEdit`s to the format expected by Atom IDE.
   */
  public static convertChanges(changes: { [uri: string]: TextEdit[] }): Map<atomIde.IdeUri, atomIde.TextEdit[]> {
    const result = new Map()
    Object.keys(changes).forEach((uri) => {
      result.set(Convert.uriToPath(uri), Convert.convertLsTextEdits(changes[uri]))
    })
    return result
  }

  /**
   * Converts a set of LSP `TextDocumentEdit`s to the format expected by Atom
   * IDE.
   */
  public static convertDocumentChanges(documentChanges: TextDocumentEdit[]): Map<atomIde.IdeUri, atomIde.TextEdit[]> {
    const result = new Map()
    documentChanges.forEach((documentEdit) => {
      result.set(Convert.uriToPath(documentEdit.textDocument.uri), Convert.convertLsTextEdits(documentEdit.edits))
    })
    return result
  }
}
