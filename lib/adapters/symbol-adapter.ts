import { Point, TextEditor } from 'atom'
import { CancellationTokenSource } from 'vscode-jsonrpc'
import Convert from '../convert'
import {
  DocumentSymbol,
  LanguageClientConnection,
  Location,
  LocationLink,
  SymbolInformation,
  SymbolKind,
  WorkspaceSymbol
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

export type ServerPromise = ReturnType<ServerManager['getServer']>

export type SymbolEntry = {
  position: Point,
  name: string,
  range?: AtomRange
  tag?: string | null,
  context?: string | null
} & (Partial<SymbolFileAndDirectory | SymbolPath>)

export type SymbolActionType = 'project' | 'project-find' | 'file'

export type SymbolMeta = {
  signal?: AbortSignal,
  editor: TextEditor,
  type: SymbolActionType,
  query?: string,
  range?: AtomRange
}

export type SymbolProvider = {
  canProvideSymbols(meta: SymbolMeta): MaybePromise<boolean | number>,
  getSymbols(meta: SymbolMeta, listController: ListController): MaybePromise<SymbolResponse>,
  name: string,
  packageName: string,
  isExclusive?: boolean
}

export type SymbolDelegate = {
  shouldIgnoreSymbol(symbol: SymbolEntry, editor: TextEditor, meta: SymbolMeta): boolean
}


export type SymbolResponse = SymbolEntry[]

type RawSymbolList = DocumentSymbol[] | SymbolInformation[] | Location[] | LocationLink[] | WorkspaceSymbol[]

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
 * Public: Provide symbols and go-to-definition functionality to the
 * `symbols-view` package.
 */
export default class SymbolAdapter {

  private _cancellationTokens: WeakMap<LanguageClientConnection, CancellationTokenSource> = new WeakMap()

  private _delegate?: SymbolDelegate

  isExclusive: boolean
  logger: Logger

  /**
   * Public: Creates a new {@link SymbolAdapter} to provide symbols to
   * `symbols-view`.
   *
   * @param logger An instance of {@link Logger}.
   */
  constructor(logger?: Logger, _delegate?: SymbolDelegate) {
    this.logger = logger || new NullLogger()
    this._delegate = _delegate
    this.isExclusive = true
  }

  /**
   * Reports to {@link AutoLanguageClient} whether it can supply symbols for the
   * given user request.
   *
   * @param server A language server instance.
   * @param meta Metadata about the symbol request from `symbols-view`.
   *
   * @returns Whether this provider can supply symbols, in the form of either a
   *   boolean or a numerical score.
   */
  async canProvideSymbols(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta
  ): Promise<boolean | number> {
    if (server === null) return false

    let {
      workspaceSymbolProvider,
      documentSymbolProvider,
      referencesProvider
    } = server.capabilities

    if (meta.type === 'project') {
      return !!workspaceSymbolProvider
    } else if (meta.type === 'file') {
      return !!documentSymbolProvider
    } else if (meta.type === 'project-find') {
      if (referencesProvider) {
        return 1
      } else if (workspaceSymbolProvider) {
        // Almost as useful as a references provider, but is more likely to
        // return more than one result.
        return 0.95
      }
    }
    return false
  }

  /**
   * Protected: Supplies project symbols for a given user request.
   *
   * @param server A language server instance.
   * @param meta Metadata about the symbol request from `symbols-view`.
   *
   * @returns The symbols to be shown by `symbols-view`.
   */
  protected async getProjectSymbols(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta
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
    return this.createSymbols(results, editor, meta)
  }

  /**
   * Protected: Supplies candidates to resolve a given project-wide reference
   * for `symbols-view`.
   *
   * @param server A language server instance.
   * @param meta Metadata about the symbol request from `symbols-view`.
   *
   * @returns The symbols to be shown by `symbols-view`.
   */
  protected async getProjectReferences(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta,
  ): Promise<SymbolEntry[]> {
    if (server === null) return []

    let editor = meta.editor
    let connection = server.connection

    let query = meta.query || (editor.getLastSelection()?.getText() ||
      editor.getWordUnderCursor() || null)

    if (query === null) return []

    let position = meta.range?.start ?? editor.getLastCursor().getBufferPosition()

    let params = Convert.editorToTextDocumentPositionParams(editor, position)
    let results = await connection.gotoDefinition(params)

    if (results === null) return []
    if (!Array.isArray(results)) {
      results = [results]
    }

    return this.createSymbols(results as any, editor, meta, query)
  }

  /**
   * Public: Supplies symbols in response to a symbol request from
   * `symbols-view`.
   *
   * @param server The language server for the given editor.
   * @param meta Metadata about the symbol request from `symbols-view`.
   *
   * @returns The symbols to be shown by `symbols-view`.
   */
  public async getSymbols(
    server: Awaited<ServerPromise>,
    meta: SymbolMeta,
  ): Promise<SymbolResponse> {
    if (server === null) return []

    if (meta.type === 'project') {
      return this.getProjectSymbols(server, meta)
    }

    if (meta.type === 'project-find') {
      return this.getProjectReferences(server, meta)
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
    return this.createSymbols(results, editor, meta)
  }

  /**
   * Private: Converts various kinds of language server responses to the format
   * required by the `symbols` service.
   *
   * @param symbolResults A list of objects to be converted into symbols.
   * @param name A name to use for each symbol if the raw symbol type doesn't
   *   have its own name; optional.
   *
   * @returns A list of symbols.
   */
  createSymbols(
    symbolResults: RawSymbolList,
    editor: TextEditor,
    meta: SymbolMeta,
    name?: string
  ): SymbolResponse {
    const results: SymbolResponse = []

    if (Location.is(symbolResults)) return []

    const processSymbols = (symbols: typeof symbolResults) => {
      for (const symbol of symbols) {
        if (isBareUri(symbol)) continue

        if (DocumentSymbol.is(symbol)) {
          let tag = symbolKindToTag(symbol.kind)
          const range = Convert.lsRangeToAtomRange(symbol.selectionRange)
          const position = range.start

          let result = {
            name: symbol.name,
            position,
            range,
            tag
          }

          results.push(result)

          if (symbol.children) {
            processSymbols(symbol.children)
          }
        } else if (Location.is(symbol)) {
          let range = symbol.range
          let position = Convert.positionToPoint(range.start)
          let atomRange = Convert.lsRangeToAtomRange(range)
          let result = {
            name: name ?? 'Location',
            position,
            path: Convert.uriToPath(symbol.uri),
            range: atomRange
          }
          results.push(result)
        } else if (LocationLink.is(symbol)) {
          let range = symbol.targetRange
          let position = Convert.positionToPoint(range.start)
          let atomRange = Convert.lsRangeToAtomRange(range)

          let result = {
            name: name ?? 'Location',
            position,
            path: Convert.uriToPath(symbol.targetUri),
            range: atomRange
          }

          results.push(result)
        } else if ('location' in symbol && 'range' in symbol.location) {
          let range = Convert.lsRangeToAtomRange(symbol.location.range)
          let position = Convert.positionToPoint(symbol.location.range.start)
          let tag = symbolKindToTag(symbol.kind)
          let context = symbol.containerName

          let result = {
            name: symbol.name,
            position,
            path: Convert.uriToPath(symbol.location.uri),
            range,
            tag,
            context
          }

          results.push(result)
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

    let filteredResults: SymbolResponse = []
    if (!this._delegate?.shouldIgnoreSymbol) {
      filteredResults = results
    } else {
      for (let result of results) {
        if (this._delegate?.shouldIgnoreSymbol(result, editor, meta))
          continue
        filteredResults.push(result)
      }
    }

    return filteredResults
  }
}

function isBareUri(symbol: unknown | { uri: string }): symbol is { uri: string } {
  if (symbol == null || typeof symbol !== 'object') return false
  return ('uri' in symbol && Object.keys(symbol).length === 1)
}
