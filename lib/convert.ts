import type * as atomIde from "atom-ide-base"
import * as ls from "./languageclient"
import { Point, FilesystemChange, Range, TextEditor } from "atom"

// eslint-disable-next-line import/no-deprecated
import { diagnosticTypeToLSSeverity, atomIdeDiagnosticToLSDiagnostic } from "./adapters/diagnostic-adapter"

/**
 * Public: Class that contains a number of helper methods for general conversions between the language server protocol
 * and Atom/Atom packages.
 */
export default class Convert {
  /**
   * Public: Convert a path to a URI.
   *
   * @param filePath A file path to convert to a URI.
   * @returns The URI corresponding to the path — e.g., `file:///a/b/c.txt`.
   */
  public static pathToUri(filePath: string): string {
    if (new URL(filePath, "file://").protocol !== "file:") {
      return filePath
    }
    let newPath = filePath.replace(/\\/g, "/")
    if (newPath[0] !== "/") {
      newPath = `/${newPath}`
    }
    return encodeURI(`file://${newPath}`).replace(/[#?]/g, encodeURIComponent)
  }

  /**
   * Public: Convert a URI to a path.
   *
   * @param uri A URI to convert to a file path.
   * @returns A file path corresponding to the URI. e.g. /a/b/c.txt If the URI
   *   does not begin with `file:` then it is returned as-is to allow Atom to
   *   deal with http/https sources in the future.
   */
  public static uriToPath(uri: string): string {
    const url = new URL(uri, "file://")
    if (url.protocol !== "file:" || url.pathname == null) {
      return uri
    }

    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === "win32") {
      // Deal with Windows drive names
      if (filePath[0] === "/") {
        filePath = filePath.substring(1)
      }
      return filePath.replace(/\//g, "\\")
    }
    return filePath
  }

  /**
   * Public: Convert an Atom {@link Point} to a language server
   * {@link Position}.
   *
   * @param point An Atom {@link Point} to convert from.
   * @returns The {@link Position} representation of the Atom
   *   {@link PointObject}.
   */
  public static pointToPosition(point: Point): ls.Position {
    return { line: point.row, character: point.column }
  }

  /**
   * Public: Convert a language server {@link Position} into an Atom
   * {@link PointObject}.
   *
   * @param position A language server {@link Position} to convert from.
   * @returns The Atom {@link PointObject} representation of the given
   *   {@link Position}.
   */
  public static positionToPoint(position: ls.Position): Point {
    return new Point(position.line, position.character)
  }

  /**
   * Public: Convert a language server {@link Range} into an Atom {@link Range}.
   *
   * @param range A language server {@link Range} to convert from.
   * @returns The Atom {@link Range} representation of the given language
   *   server {@link Range}.
   */
  public static lsRangeToAtomRange(range: ls.Range): Range {
    return new Range(Convert.positionToPoint(range.start), Convert.positionToPoint(range.end))
  }

  /**
   * Public: Convert an Atom {@link Range} into an language server
   * {@link Range}.
   *
   * @param range An Atom {@link Range} to convert from.
   * @returns The language server {@link Range} representation of the given
   *   Atom {@link Range}.
   */
  public static atomRangeToLSRange(range: Range): ls.Range {
    return {
      start: Convert.pointToPosition(range.start),
      end: Convert.pointToPosition(range.end),
    }
  }

  /**
   * Public: Create a {@link TextDocumentIdentifier} from an Atom
   * {@link TextEditor}.
   *
   * @param editor A {@link TextEditor} that will be used to form the `uri`
   *   property.
   * @returns A {@link TextDocumentIdentifier} that has a `uri` property with
   *   the URI for the given editor's path.
   */
  public static editorToTextDocumentIdentifier(editor: TextEditor): ls.TextDocumentIdentifier {
    return { uri: Convert.pathToUri(editor.getPath() || "") }
  }

  /**
   * Public: Create a {@link TextDocumentPositionParams} from a
   * {@link TextEditor} and optional {@link Point}.
   *
   * @param editor A {@link TextEditor} that will be used to form the uri property.
   * @param point An optional {@link Point} that will supply the position property. If not specified the current cursor
   *   position will be used.
   * @returns A {@link TextDocumentPositionParams} that has a `textDocument`
   *   property with the editor's {@link TextDocumentIdentifier} and a
   *   `position` property with the supplied point (or current cursor position
   *   when not specified).
   */
  public static editorToTextDocumentPositionParams(editor: TextEditor, point?: Point): ls.TextDocumentPositionParams {
    return {
      textDocument: Convert.editorToTextDocumentIdentifier(editor),
      position: Convert.pointToPosition(point != null ? point : editor.getCursorBufferPosition()),
    }
  }

  /**
   * Public: Create a string of scopes for the Atom text editor using the
   * `data-grammar` selector from an array of `grammarScope` strings.
   *
   * @param grammarScopes An array of grammar scope strings to convert from.
   * @returns A single comma-separated list of CSS selectors targetting the
   *   grammars of Atom text editors — e.g., `['c', 'cpp']` =>
   *   `'atom-text-editor[data-grammar='c'], atom-text-editor[data-grammar='cpp']`
   */
  public static grammarScopesToTextEditorScopes(grammarScopes: string[]): string {
    return grammarScopes
      .map((g) => `atom-text-editor[data-grammar="${Convert.encodeHTMLAttribute(g.replace(/\./g, " "))}"]`)
      .join(", ")
  }

  /**
   * Public: Encode a string so that it can be safely used within a HTML
   * attribute - i.e., replacing all quoted values with their HTML entity
   * encoded versions. (For example, `Hello"` becomes `Hello&quot;`.)
   *
   * @param s A string to be encoded.
   * @returns A string that is HTML attribute encoded by replacing `&`, `<`,
   *   `>`, `"`, and `'` with their HTML-entity named equivalents.
   */
  public static encodeHTMLAttribute(s: string): string {
    const attributeMap: { [key: string]: string } = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    }
    return s.replace(/["&'<>]/g, (c) => attributeMap[c])
  }

  /**
   * Public: Convert an Atom File Event as received from
   * `atom.project.onDidChangeFiles` into an array of Language Server Protocol
   * {@link FileEvent} objects. Normally this will be a 1-to-1 but renames will
   * be represented by a deletion and a subsequent creation as LSP does not
   * know about renames.
   *
   * @param fileEvent An {a@link tom$ProjectFileEvent} to be converted.
   * @returns An array of LSP {@link ls.FileEvent} objects with equivalent
   *   conversions to the `fileEvent` parameter.
   */
  public static atomFileEventToLSFileEvents(fileEvent: FilesystemChange): ls.FileEvent[] {
    switch (fileEvent.action) {
      case "created":
        return [{ uri: Convert.pathToUri(fileEvent.path), type: ls.FileChangeType.Created }]
      case "modified":
        return [{ uri: Convert.pathToUri(fileEvent.path), type: ls.FileChangeType.Changed }]
      case "deleted":
        return [{ uri: Convert.pathToUri(fileEvent.path), type: ls.FileChangeType.Deleted }]
      case "renamed": {
        const results: Array<{ uri: string; type: ls.FileChangeType }> = []
        if (fileEvent.oldPath) {
          results.push({ uri: Convert.pathToUri(fileEvent.oldPath), type: ls.FileChangeType.Deleted })
        }
        if (fileEvent.path) {
          results.push({ uri: Convert.pathToUri(fileEvent.path), type: ls.FileChangeType.Created })
        }
        return results
      }
      default:
        return []
    }
  }

  /** @deprecated Use Linter V2 service */
  public static atomIdeDiagnosticToLSDiagnostic(diagnostic: atomIde.Diagnostic): ls.Diagnostic {
    // eslint-disable-next-line import/no-deprecated
    return atomIdeDiagnosticToLSDiagnostic(diagnostic)
  }

  /** @deprecated Use Linter V2 service */
  public static diagnosticTypeToLSSeverity(type: atomIde.DiagnosticType): ls.DiagnosticSeverity {
    // eslint-disable-next-line import/no-deprecated
    return diagnosticTypeToLSSeverity(type)
  }

  /**
   * Public: Convert an array of language server protocol
   * {@link atomIde.TextEdit} objects to an equivalent array of Atom
   * {@link atomIde.TextEdit} objects.
   *
   * @param textEdits The language server protocol {@link atomIde.TextEdit}
   *   objects to convert.
   * @returns An array of Atom {@link atomIde.TextEdit} objects.
   */
  public static convertLsTextEdits(textEdits?: ls.TextEdit[] | null): atomIde.TextEdit[] {
    return (textEdits || []).map(Convert.convertLsTextEdit)
  }

  /**
   * Public: Convert a language server protocol {@link atomIde.TextEdit} object
   * to the Atom equivalent {@link atomIde.TextEdit}.
   *
   * @param textEdit The language server protocol {@link atomIde.TextEdit}
   *   object to convert.
   * @returns An Atom {@link atomIde.TextEdit} object.
   */
  public static convertLsTextEdit(textEdit: ls.TextEdit): atomIde.TextEdit {
    // TODO: support annotations
    return {
      oldRange: Convert.lsRangeToAtomRange(textEdit.range),
      newText: textEdit.newText,
    }
  }

  public static convertLsInsertReplaceEdit(textEdit: ls.InsertReplaceEdit, shouldReplace: boolean = false) {
    let oldRange = shouldReplace ? textEdit.replace : textEdit.insert
    return {
      oldRange: Convert.lsRangeToAtomRange(oldRange),
      newText: textEdit.newText
    }
  }
}
