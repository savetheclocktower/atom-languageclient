import type { Point, Range, TextEditor } from 'atom'
import Convert from '../convert'
import * as Utils from '../utils'
import { Hover, LanguageClientConnection, MarkedString, MarkupContent, ServerCapabilities } from '../languageclient'

// Like LSP’s `MarkupContent`, but abstracts away the difference between it and
// the deprecated `MarkedString` type.
type HoverMarkupContent = {
  kind: 'markdown' | 'plaintext',
  value: string
}

// The Datatip interface allows for both `MarkedStringDatatip` _and_
// `ReactComponentDatatip`… and the latter is too much. Not even part of LSP
// and I don't know of anyone that uses it.
//
// It also has a needless distinction between “Markdown” strings and “snippet”
// strings, whereas LSP envisions the former containing the latter and
// representing them as fenced code blocks. It tries a bad heuristic to match
// up fenced code blocks with grammars, but it's probably best to let the
// consumer pick the right grammar for a fenced code block like we do with
// `markdown-preview`.
//
// All of this is to say that we are keeping this one simple. The Hover service
// aims to remove all the YAGNI stuff from Datatip and fix the strange
// inversion-of-control thing where provider and consumer are flipped.
export type HoverInformation = {
  range?: Range,
  contents: HoverMarkupContent
}

export type HoverProvider = {
  name: string,
  packageName: string,
  priority: number,
  grammarScopes?: string[],
  validForScope?: (scopeName: string) => boolean,
  hover: (editor: TextEditor, point: Point) => Promise<HoverInformation | null>
}

/**
 * Public: Adapts the LSP "textDocument/hover" request to the Hover service — designed to be a simpler alternative to Atom IDE’s Datatip.
 */
export default class HoverAdapter {
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
  public static canAdapt(serverCapabilities: ServerCapabilities) {
    return Boolean(serverCapabilities.hoverProvider)
  }


  /**
   * Public: Get the Hover information for this {@link Point} in a {@link
   * TextEditor} by querying the language server.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that will be queried for the hover text.
   * @param editor The Atom {@link TextEditor} containing the text the hover
   *   information should relate to.
   * @param point The Atom {@link Point} containing the point within the text
   *   the hover information should relate to.
   *
   * @returns A {@link Promise} containing the {@link HoverInformation} to
   *   display or `null` if no Datatip is available.
   */
  public async getHover(
    connection: LanguageClientConnection,
    editor: TextEditor,
    point: Point
  ) {
    let documentPositionParams = Convert.editorToTextDocumentPositionParams(editor, point)

    let hover = await connection.hover(documentPositionParams)
    if (hover == null || HoverAdapter.isEmptyHover(hover)) {
      return null
    }

    let range = hover.range == null ?
      Utils.getWordAtPosition(editor, point) :
      Convert.lsRangeToAtomRange(hover.range)

    let markupContent: HoverMarkupContent
    if (Array.isArray(hover.contents) || isMarkedString(hover.contents)) {
      markupContent = convertMarkedStringToMarkupContent(hover.contents)
    } else {
      markupContent = hover.contents
    }

    return { range, contents: markupContent }
  }

  private static isEmptyHover(hover: Hover | null) {
    if (hover == null) return true
    if (hover.contents == null) return true
    if (typeof hover.contents === 'string' && hover.contents.length === 0) {
      return true
    }
    if (Array.isArray(hover.contents) && (hover.contents.length === 0 || hover.contents[0] === '')) {
      return true
    }
    return false
  }
}

function isMarkedString(x: MarkedString | MarkupContent): x is MarkedString {
  if (typeof x === 'string') return true
  return (('language' in x) && ('value' in x))
}

function convertMarkedStringToMarkupContentValue(markedString: MarkedString) {
  if (typeof markedString === 'string') return markedString

  let { language, value } = markedString
  return `\`\`\`${language}\n${value}\n\`\`\``
}

function convertMarkedStringToMarkupContent(markedString: MarkedString | MarkedString[]): HoverMarkupContent {
  let value: string
  if (Array.isArray(markedString)) {
    value = markedString.map(ms => convertMarkedStringToMarkupContentValue(ms)).join('\n\n')
  } else {
    value = convertMarkedStringToMarkupContentValue(markedString)
  }
  return { kind: 'markdown', value }
}
