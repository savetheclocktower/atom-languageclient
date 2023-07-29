import { Point, TextEditor } from 'atom'
import { CancellationTokenSource } from 'vscode-jsonrpc'
import Convert from '../convert'
import {
  DocumentSymbol,
  LanguageClientConnection,
  Location,
  LocationLink,
  SymbolInformation,
  SymbolKind
} from '../languageclient'
import { Logger, NullLogger } from '../logger'
import { ServerManager } from '../server-manager.js'
import * as Utils from '../utils'

type MaybePromise<T> = Promise<T> | T

type SymbolFileAndDirectory = { file: string, directory: string }
type SymbolPath = { path: string; }

type ListControllerObjectParameter = {
  loadingMessage?: string | null,
  emptyMessage?: string | null,
  loadingBadge?: number | string | null,
  errorMessage?: string | null
}

type ControllableListProps = keyof ListControllerObjectParameter

export type ListController = {
  set: (props: ListControllerObjectParameter) => void,
  clear: (...props: ControllableListProps[]) => void
}

/**
 * Settings that control aspects of symbol retrieval and display.
 */
export type SymbolSettings = {
  /**
   * Tags (in string form) for symbols that the user wants to exclude from all
   * symbol lists. (Symbols of these types may still be targeted with a "go to
   * declaration" command.)
   */
  ignoredTags?: string[],

  /**
   * The minimum number of charcters the user must type on a project search
   * before this provider will return any results.
   */
  minimumQueryLength?: number
}

export type ServerPromise = ReturnType<ServerManager['getServer']>

export type SymbolEntry = {
  position: Point,
  name: string,
  range?: AtomRange
  tag?: string | null,
  context?: string | null
} & (Partial<SymbolFileAndDirectory | SymbolPath>)

export type SymbolMeta = {
  signal?: AbortSignal,
  editor: TextEditor,
  type: string,
  query?: string
}

export type SymbolProvider = {
  canProvideSymbols(meta: SymbolMeta): MaybePromise<boolean | number>,
  getSymbols(meta: SymbolMeta, listController: ListController): MaybePromise<SymbolResponse>,
  name: string,
  packageName: string,
  isExclusive?: boolean
}

export type SymbolResponse = SymbolEntry[]

type RawSymbolList = DocumentSymbol[] | SymbolInformation[] | Location[] | LocationLink[]

type AtomRange = ReturnType<TextEditor['getSelectedBufferRange']>

/**
 * Converts a symbol kind to a “tag” in `symbol.provider` parlance — a
 * human-friendly description of the kind.
 *
 * @param symbol A value in the {@link SymbolKind} enum.
 *
 * @returns A human-friendly string describing the kind.
 */
function symbolKindToTag(symbol: SymbolKind): string | null {
  switch (symbol) {
    case SymbolKind.Array:
      return "array"
    case SymbolKind.Boolean:
      return "boolean"
    case SymbolKind.Class:
      return "class"
    case SymbolKind.Constant:
      return "constant"
    case SymbolKind.Constructor:
      return "constructor"
    case SymbolKind.Enum:
      return "enum"
    case SymbolKind.Field:
      return "field"
    case SymbolKind.File:
      return "file"
    case SymbolKind.Function:
      return "function"
    case SymbolKind.Interface:
      return "interface"
    case SymbolKind.Method:
      return "method"
    case SymbolKind.Module:
      return "module"
    case SymbolKind.Namespace:
      return "namespace"
    case SymbolKind.Number:
      return "number"
    case SymbolKind.Package:
      return "package"
    case SymbolKind.Property:
      return "property"
    case SymbolKind.String:
      return "string"
    case SymbolKind.Variable:
      return "variable"
    case SymbolKind.Struct:
      return "class"
    case SymbolKind.EnumMember:
      return "constant"
    default:
      return null
  }
}

/**
 * Public: Provide symbols to the `symbols-view-redux` package.
 */
export default class SymbolAdapter {

  private _cancellationTokens: WeakMap<LanguageClientConnection, CancellationTokenSource> = new WeakMap()

  isExclusive: boolean
  logger: Logger

  /**
   * Public: Create a new {@link SymbolAdapter} to provide symbols to
   * `symbols-view-redux`.
   *
   * @param logger An instance of {@link Logger}.
   */
  constructor(logger?: Logger) {
    this.logger = logger || new NullLogger()
    this.isExclusive = true
  }

  /**
   * Reports to {@link AutoLanguageClient} whether it can supply symbols for the
   * given user request.
   *
   * @param server A language server instance.
   * @param meta Metadata about the symbol request from `symbols-view-redux`.
   *
   * @returns Whether this provider can supply symbols, in the form of either a
   *   boolean or a numerical score.
   */
  async canProvideSymbols(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta
  ): Promise<boolean> {
    if (server === null) return false

    if (meta.type === 'project') {
      let result = server.capabilities.workspaceSymbolProvider
      return !!result
    } else if (meta.type === 'file') {
      let result = server.capabilities.documentSymbolProvider
      return !!result
    } else if (meta.type === 'project-find') {
      let result = server.capabilities.referencesProvider
      return !!result
    }
    return false
  }

  /**
   * Protected: Supplies project symbols for a given user request.
   *
   * @param server A language server instance.
   * @param meta Metadata about the symbol request from `symbols-view-redux`.
   *
   * @returns The symbols to be shown by `symbols-view-redux`.
   */
  protected async getProjectSymbols(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta,
    settings: SymbolSettings
  ): Promise<SymbolEntry[]> {
    if (server === null) return []

    let editor: TextEditor = meta.editor
    let connection = server.connection

    let query = meta.query ??
      editor.getLastSelection()?.getText() ?? ''

    if (query === '' && meta.type === 'project-find') {
      query = editor.getWordUnderCursor()
    }

    const results = await Utils.doWithCancellationToken(
      connection,
      this._cancellationTokens,
      (cancellationToken) => {
        return connection.workspaceSymbol(
          { query },
          cancellationToken
        )
      }
    )

    if (results === null || results.length === 0) return []
    return this.createSymbols(results, settings)
  }

  /**
   * Protected: Supplies candidates to resolve a given reference for
   * `symbols-view-redux`.
   *
   * @param server A language server instance.
   * @param meta Metadata about the symbol request from `symbols-view-redux`.
   *
   * @returns The symbols to be shown by `symbols-view-redux`.
   */
  protected async getProjectReferences(server: Awaited<ServerPromise>, meta: SymbolMeta, settings: SymbolSettings): Promise<SymbolEntry[]> {
    if (server === null) return []

    let editor = meta.editor
    let connection = server.connection

    let query = editor.getLastSelection()?.getText() ||
      editor.getWordUnderCursor() || null

    if (query === null) return []

    let results = await connection.gotoDefinition(
      {
        textDocument: Convert.editorToTextDocumentIdentifier(editor),
        position: Convert.pointToPosition(editor.getLastCursor().getBufferPosition())
      }
    )

    if (results === null) return []
    if (!Array.isArray(results)) {
      results = [results]
    }

    return this.createSymbols(results as any, settings, query)
  }

  /**
   * Public: Supplies symbols in response to a symbol request from
   * `symbols-view-redux`.
   *
   * @param server The language server for the given editor.
   * @param meta Metadata about the symbol request from `symbols-view-redux`.
   *
   * @returns The symbols to be shown by `symbols-view-redux`.
   */
  async getSymbols(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta,
    settings: SymbolSettings
  ): Promise<SymbolResponse> {
    if (server === null) return []

    if (meta.type === 'project') {
      return this.getProjectSymbols(server, meta, settings)
    }

    if (meta.type === 'project-find') {
      return this.getProjectReferences(server, meta, settings)
    }

    const editor: TextEditor = meta.editor
    const connection = server.connection
    const results = await Utils.doWithCancellationToken(
      connection,
      this._cancellationTokens,
      (cancellationToken) => {
        return connection.documentSymbol(
          { textDocument: Convert.editorToTextDocumentIdentifier(editor) },
          cancellationToken
        )
      }
    )

    if (results === null || results.length === 0) return []
    return this.createSymbols(results, settings)
  }

  /**
   * Private: Converts various kinds of language server responses to the format
   * required by the `symbols` service.
   *
   * @param symbolResults A list of objects to be converted into symbols.
   * @param settings Settings from the user that control which symbols are
   *   returned to the UI.
   * @param name A name to use for each symbol if the raw symbol type doesn't
   *   have its own name; optional.
   *
   * @returns A list of symbols.
   */
  createSymbols(
    symbolResults: RawSymbolList,
    settings: SymbolSettings,
    name?: string
  ): SymbolResponse {
    const results: SymbolResponse = []
    let { ignoredTags = [] } = settings ?? {}
    ignoredTags = ignoredTags.map(t => t.toLowerCase())

    if (Location.is(symbolResults)) return []

    const processSymbols = (symbols: typeof symbolResults) => {
      for (const symbol of symbols) {
        if (DocumentSymbol.is(symbol)) {
          const range = symbol.selectionRange
          const position = Convert.positionToPoint(range.start)
          let tag = symbolKindToTag(symbol.kind)
          if (tag && ignoredTags.includes(tag)) continue

          results.push({
            name: symbol.name,
            position: position,
            tag
          })

          if (symbol.children) {
            processSymbols(symbol.children)
          }
        } else if (Location.is(symbol)) {
          let range = symbol.range
          let position = Convert.positionToPoint(range.start)
          let atomRange = Convert.lsRangeToAtomRange(range)

          results.push({
            name: name ?? 'Location',
            position,
            path: Convert.uriToPath(symbol.uri),
            range: atomRange
          })
        } else if (LocationLink.is(symbol)) {
          let range = symbol.targetRange
          let position = Convert.positionToPoint(range.start)
          let atomRange = Convert.lsRangeToAtomRange(range)

          results.push({
            name: name ?? 'Location',
            position,
            path: Convert.uriToPath(symbol.targetUri),
            range: atomRange
          })
        } else {
          let range = symbol.location.range
          let position = Convert.positionToPoint(range.start)
          let atomRange = Convert.lsRangeToAtomRange(range)
          let tag = symbolKindToTag(symbol.kind)
          let context = symbol.containerName

          if (tag && ignoredTags.includes(tag)) continue
          results.push({
            name: symbol.name,
            position,
            path: Convert.uriToPath(symbol.location.uri),
            range: atomRange,
            tag,
            context
          })
        }
      }
    }

    processSymbols(symbolResults)

    // TODO: We're sorting these by buffer position before the consumer sees
    // them, but we might want to leave that task to the consumer.
    results.sort((a, b) => {
      let pointA = a.position ?? a.range?.start
      let pointB = b.position ?? b.range?.start
      if (!pointA) return 1
      if (!pointB) return -1
      return pointA.compare(pointB)
    })

    return results
  }
}
