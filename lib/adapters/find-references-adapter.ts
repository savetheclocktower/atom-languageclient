import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import { Point, TextEditor } from "atom"
import { LanguageClientConnection, Location, ServerCapabilities, ReferenceParams } from "../languageclient"

/**
 * Public: Adapts the language server definition provider to the Atom IDE UI
 * Definitions package for 'Go To Definition' functionality.
 */
export default class FindReferencesAdapter {
  /**
   * Public: Determine whether this adapter can be used to adapt a language
   * server based on the serverCapabilities matrix containing a
   * referencesProvider.
   *
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server to consider.
   * @returns A boolean indicating adapter can adapt the server based on the
   *   given serverCapabilities.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return serverCapabilities.referencesProvider === true
  }

  /**
   * Public: Get the references for a specific symbol within the document as
   * represented by the {@link TextEditor} and {@link Point} within it via the
   * language server.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will be queried for the references.
   * @param editor The Atom {@link TextEditor} containing the text the
   *   references should relate to.
   * @param point The Atom {@link Point} containing the point within the text
   *   the references should relate to.
   *
   * @returns A {@link Promise} containing a {@link FindReferencesReturn} with
   *   all the references the language server could find.
   */
  public async getReferences(
    connection: LanguageClientConnection,
    editor: TextEditor,
    point: Point,
    projectRoot: string | null
  ): Promise<atomIde.FindReferencesReturn | null> {
    const locations = await connection.findReferences(FindReferencesAdapter.createReferenceParams(editor, point))
    if (locations == null) {
      return null
    }

    const references: atomIde.Reference[] = locations.map(FindReferencesAdapter.locationToReference)
    return {
      type: "data",
      baseUri: projectRoot || "",
      referencedSymbolName: FindReferencesAdapter.getReferencedSymbolName(editor, point, references),
      references,
    }
  }

  /**
   * Public: Create a {@link ReferenceParams} from a given {@link TextEditor}
   * for a specific {@link Point}.
   *
   * @param editor A {@link TextEditor} that represents the document.
   * @param point A {@link Point} within the document.
   * @returns A {@link ReferenceParams} built from the given parameters.
   */
  public static createReferenceParams(editor: TextEditor, point: Point): ReferenceParams {
    return {
      textDocument: Convert.editorToTextDocumentIdentifier(editor),
      position: Convert.pointToPosition(point),
      context: { includeDeclaration: true },
    }
  }

  /**
   * Public: Convert a {@link Location} into a {@link Reference}.
   *
   * @param location A {@link Location} to convert.
   *
   * @returns A {@link Reference} equivalent to the given {@link Location}.
   */
  public static locationToReference(location: Location): atomIde.Reference {
    return {
      uri: Convert.uriToPath(location.uri),
      name: null,
      range: Convert.lsRangeToAtomRange(location.range),
    }
  }

  /**
   * Public: Get a symbol name from a {@link TextEditor} for a specific
   * {@link Point} in the document.
   */
  public static getReferencedSymbolName(editor: TextEditor, point: Point, references: atomIde.Reference[]): string {
    if (references.length === 0) {
      return ""
    }
    const currentReference = references.find((r) => r.range.containsPoint(point)) || references[0]
    return editor.getBuffer().getTextInRange(currentReference.range)
  }
}
