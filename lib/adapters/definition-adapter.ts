import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import * as Utils from "../utils"
import { LanguageClientConnection, Location, LocationLink, ServerCapabilities } from "../languageclient"
import { Point, TextEditor, Range } from "atom"

/**
 * Public: Adapts the language server definition provider to the Atom IDE UI
 * Definitions package for 'Go To Definition' functionality.
 */
export default class DefinitionAdapter {
  /**
   * Public: Determine whether this adapter can be used to adapt a language
   * server based on the serverCapabilities matrix containing a
   * definitionProvider.
   *
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server to consider.
   * @returns A boolean indicating the adapter can adapt the server based on
   *   the given serverCapabilities.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return serverCapabilities.definitionProvider === true
  }

  /**
   * Public: Get the definitions for a symbol at a given {@link Point} within a
   * {@link TextEditor}, including optionally highlighting all other references
   * within the document if the langauge server also supports highlighting.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will provide definitions and highlights.
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server that will be used.
   * @param languageName The name of the programming language.
   * @param editor The Atom {@link TextEditor} containing the symbol and
   *   potential highlights.
   * @param point The Atom {@link Point} containing the position of the text
   *   that represents the symbol for which the definition and highlights should
   *   be provided.
   *
   * @returns A {@link Promise} that will resolve with a {@link
   *   DefinitionQueryResult}, or else with `null`.
   */
  public async getDefinition(
    connection: LanguageClientConnection,
    serverCapabilities: ServerCapabilities,
    languageName: string,
    editor: TextEditor,
    point: Point
  ): Promise<atomIde.DefinitionQueryResult | null> {
    const documentPositionParams = Convert.editorToTextDocumentPositionParams(editor, point)
    const definitionLocations = DefinitionAdapter.normalizeLocations(
      await connection.gotoDefinition(documentPositionParams)
    )
    if (definitionLocations == null || definitionLocations.length === 0) {
      return null
    }

    let queryRange
    if (serverCapabilities.documentHighlightProvider) {
      const highlights = await connection.documentHighlight(documentPositionParams)
      if (highlights != null && highlights.length > 0) {
        queryRange = highlights.map((h) => Convert.lsRangeToAtomRange(h.range))
      }
    }

    return {
      queryRange: queryRange || [Utils.getWordAtPosition(editor, point)],
      definitions: DefinitionAdapter.convertLocationsToDefinitions(definitionLocations, languageName),
    }
  }

  /**
   * Public: Normalize the locations so a single {@link Location} becomes an
   * array of just one. The language server protocol can return either, as the
   * protocol evolved between v1 and v2.
   *
   * @param locationResult Either a single {@link Location} object or an array
   *   of {@link Location}s.
   *
   * @returns An array of {@link Location}s or `null` if the locationResult was
   *   null.
   */
  public static normalizeLocations(
    locationResult: Location | Location[] | LocationLink[] | null
  ): Location[] | LocationLink[] | null {
    if (locationResult == null) {
      // TODO use ===
      return null
    }
    // TODO `d.targetRange.start` never becomes `null` according to the types
    if (isLocationLinkArray(locationResult)) {
      return locationResult.filter((d) => d.targetRange.start != null)
    }
    return (Array.isArray(locationResult) ? locationResult : [locationResult]).filter((d) => d.range.start != null)
  }

  /**
   * Public: Convert an array of {@link Location} objects into an Array of
   *  {@link Definition}s.
   *
   * @param locations An array of {@link Location} objects to be converted.
   * @param languageName The name of the language these objects are written in.
   *
   * @returns An array of {@link Definition}s that represented the converted
   *   {@link Location}s.
   */
  public static convertLocationsToDefinitions(
    locations: Location[] | LocationLink[],
    languageName: string
  ): atomIde.Definition[] {
    if (isLocationLinkArray(locations)) {
      return locations.map((d) => ({
        path: Convert.uriToPath(d.targetUri),
        position: Convert.positionToPoint(d.targetRange.start),
        range: Range.fromObject(Convert.lsRangeToAtomRange(d.targetRange)),
        language: languageName,
      }))
    }
    return locations.map((d) => ({
      path: Convert.uriToPath(d.uri),
      position: Convert.positionToPoint(d.range.start),
      range: Range.fromObject(Convert.lsRangeToAtomRange(d.range)),
      language: languageName,
    }))
  }
}

function isLocationLinkArray(value: any): value is LocationLink[] {
  return Array.isArray(value) && LocationLink.is(value[0])
}
