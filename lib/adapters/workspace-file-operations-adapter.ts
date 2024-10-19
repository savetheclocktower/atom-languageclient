import { Disposable } from "atom"
import { CreateFilesParams, DeleteFilesParams, FileOperationOptions, FileOperationRegistrationOptions, RenameFilesParams, ServerCapabilities, WorkspaceEdit } from "vscode-languageserver-protocol"
import { FileOperationFilter, FileOperationPatternKind } from "vscode-languageserver-protocol/lib/common/protocol.fileOperations"
import Convert from "../convert"
import { LanguageClientConnection } from "../languageclient"
import * as FS from 'fs/promises'
import * as Path from 'path'
import minimatch from 'minimatch'
import ApplyEditAdapter from "./apply-edit-adapter"

type MoveAction = { initialPath: string, newPath: string }
// Creation and deletion callbacks take an array of paths.
type TreeViewBeforeCallback = (paths: string[], handle: TreeViewV2Handle) => void
type TreeViewAfterCallback = (paths: string[]) => void

// Move (rename) callbacks take an array of objects; each object describes the
// origin and destination paths.
type TreeViewBeforeMoveCallback = (paths: MoveAction[], handle: TreeViewV2Handle) => void
type TreeViewAfterMoveCallback = (paths: MoveAction[]) => void

// A service definition for the proposed `tree-view` v2 service.
export interface TreeViewV2Service {
  selectedPaths(): string[]
  entryForPath(path: string): HTMLElement

  onWillMove(callback: TreeViewBeforeMoveCallback): Disposable
  onWillDelete(callback: TreeViewBeforeCallback): Disposable
  onWillCreate(callback: TreeViewBeforeCallback): Disposable

  onDidMove(callback: TreeViewAfterMoveCallback): Disposable
  onDidDelete(callback: TreeViewAfterCallback): Disposable
  onDidCreate(callback: TreeViewAfterCallback): Disposable
}

interface TreeViewV2Handle {
  hold(fn: () => void): Promise<void>
  aborted: boolean
}

/**
 * Public: An adapter for notifying the language server about user-initiated
 * file operations.
 *
 * This adapter relies on the `tree-view` service (version 1.1.0 or greater) to
 * tell it when the user creates, deletes, or moves files using the built-in
 * `tree-view` package (or any other package using that service).
 *
 * If the `tree-view` service is available (i.e., if the package consumes it),
 * workspace file operations will be set up automatically based on the server’s
 * capabilities.
 */
export default class WorkspaceFileOperationsAdapter {

  /**
   * Public: Determine whether this adapter can be used on a given server.
   * @param serverCapabilities The {ServerCapabilities} of the language server
   *   to consider.
   * @returns A boolean indicating whether this adapter can adapt the server.
   */
  static canAdapt(serverCapabilities: ServerCapabilities | undefined): boolean {
    let fileOps = serverCapabilities?.workspace?.fileOperations
    if (fileOps == null) return false
    return typeof fileOps === 'object'
  }

  /**
   * Public: Create a new {WorkspaceFileOperationsAdapter} for the given
   * language server.
   *
   * @param _connection A {LanguageClientConnection} to the language server.
   * @param _treeViewService An instance of the `tree-view` service that will
   *   report the user's actions.
   * @param _capabilities An object describing the {FileOperationOptions}
   *   supported by this language server.
   */
  constructor(
    private _connection: LanguageClientConnection,
    private _treeViewService: TreeViewV2Service,
    private _capabilities: FileOperationOptions | undefined
  ) {

    // For each capability reported by the server, we'll wire up a handler.

    // The `onWillX` capabilities are wired up to methods that send out
    // `workspace/willXFiles` requests. They're treated as requests because
    // they can optionally return `WorkspaceEdit`s.
    //
    // If we report an operation and the server returns a `WorkspaceEdit`, we
    // are obligated to attempt to apply that `WorkspaceEdit`. The server is
    // telling us that the codebase should somehow be adjusted based on the
    // fact that a new file exists, a file no longer exists, or a file has
    // changed its location.
    //
    // The most obvious example would be moving a file that is required by
    // other files in your project; the language server might know how to
    // rename those imports so that they point to the new location.
    if (this._capabilities?.willCreate) {
      this._treeViewService.onWillCreate((paths, handle) => this.willCreateFiles(paths, handle))
    }
    if (this._capabilities?.willRename) {
      this._treeViewService.onWillMove((moves, handle) => this.willRenameFiles(moves, handle))
    }
    if (this._capabilities?.willDelete) {
      this._treeViewService.onWillDelete((deletions, handle) => this.willDeleteFiles(deletions, handle))
    }

    // The `onDidX` capabilities are wired up to methods that send out
    // `workspace/didXFiles` notifications. Unlike the methods above, these are
    // notifications because the server will not respond.
    if (this._capabilities?.didCreate) {
      this._treeViewService.onDidCreate((paths) => this.didCreateFiles(paths))
    }
    if (this._capabilities?.didRename) {
      this._treeViewService.onDidMove((moves) => this.didRenameFiles(moves))
    }
    if (this._capabilities?.didDelete) {
      this._treeViewService.onDidDelete((deletions) => this.didDeleteFiles(deletions))
    }
  }

  /**
   * Send a `willCreateFiles` request to the language server and apply any
   * {WorkspaceEdit} that may be returned.
   * @param paths An {Array} of paths to be created.
   * @param handle The handle that allows us to delay the file operation.
   */
  async willCreateFiles(paths: string[], handle: TreeViewV2Handle) {
    // The call to `handle.hold` signals to `tree-view` that we'd _like to_
    // perform this work. But `tree-view` will only wait for a reasonable
    // amount of time; the LSP spec allows a client to ignore a server if it's
    // too slow to process this request.
    await handle.hold(async () => {
      let filteredPaths = await this._filter(this._capabilities!.willCreate, paths)
      let params = buildCreateOrDeleteFilesParams(filteredPaths)
      let result = await this._connection.willCreateFiles(params)
      if (handle.aborted) return
      await this._handleResult(result)
    })
  }

  /**
   * Send a `willRenameFiles` request to the language server and apply any
   * {WorkspaceEdit} that may be returned.
   * @param paths An {Array} of objects, each one describing the old and new
   *   file paths of each operation in the batch.
   * @param handle The handle that allows us to delay the file operation.
   */
  async willRenameFiles(paths: MoveAction[], handle: TreeViewV2Handle) {
    // The call to `handle.hold` signals to `tree-view` that we'd _like to_
    // perform this work. But `tree-view` will only wait for a reasonable
    // amount of time; the LSP spec allows a client to ignore a server if it's
    // too slow to process this request.
    await handle.hold(async () => {
      let filteredPaths = await this._filter(this._capabilities!.willRename, paths, 'initialPath')
      let params = buildRenameFilesParams(filteredPaths)
      let result = await this._connection.willRenameFiles(params)
      if (handle.aborted) return
      await this._handleResult(result)
    })
  }

  /**
   * Send a `willDeleteFiles` request to the language server and apply any
   * {WorkspaceEdit} that may be returned.
   * @param paths An {Array} of paths to be deleted.
   * @param handle The handle that allows us to delay the file operation.
   */
  async willDeleteFiles(paths: string[], handle: TreeViewV2Handle) {
    // The call to `handle.hold` signals to `tree-view` that we'd _like to_
    // perform this work. But `tree-view` will only wait for a reasonable
    // amount of time; the LSP spec allows a client to ignore a server if it's
    // too slow to process this request.
    await handle.hold(async () => {
      let filteredPaths = await this._filter(this._capabilities!.willDelete, paths)
      let params = buildCreateOrDeleteFilesParams(filteredPaths)
      let result = await this._connection.willDeleteFiles(params)
      if (handle.aborted) return
      await this._handleResult(result)
    })
  }

  /**
   * Send a `didCreateFiles` notification to the language server.
   * @param paths An {Array} of paths that were created.
   */
  async didCreateFiles(paths: string[]) {
    let filteredPaths = await this._filter(this._capabilities!.didCreate, paths)
    let params = buildCreateOrDeleteFilesParams(filteredPaths)
    return this._connection.didCreateFiles(params)
  }

  /**
   * Send a `didRenameFiles` notification to the language server.
   * @param paths An {Array} of objects, each one describing the old and new
   *   file paths of each operation in the batch.
   */
  async didRenameFiles(paths: MoveAction[]) {
    let filteredPaths = await this._filter(this._capabilities!.didRename, paths, 'newPath')
    let params = buildRenameFilesParams(filteredPaths)
    return this._connection.didRenameFiles(params)
  }

  /**
   * Send a `didDeleteFiles` notification to the language server.
   * @param paths An {Array} of paths that were deleted.
   */
  async didDeleteFiles(paths: string[]) {
    let filteredPaths = await this._filter(this._capabilities!.didDelete, paths)
    let params = buildCreateOrDeleteFilesParams(filteredPaths)
    return this._connection.didDeleteFiles(params)
  }

  private async _handleResult(result: WorkspaceEdit | null) {
    if (!result) return
    await ApplyEditAdapter.apply(result, { save: 'unmodified' })
  }

  /**
   * Private: Given a set of paths, use the server's own capabilities to filter
   * out any paths that the server has not registered interest in.
   * @param capability A set of {FileOperationRegistrationOptions}, including
   *   any potential globs that describe files and folders that this language
   *   server cares about.
   * @param items A set of either strings or objects describing the names of
   *   the files in question.
   * @returns A filtered set of paths.
   */
  private async _filter(capability: FileOperationRegistrationOptions | undefined, items: Array<string>) : Promise<Array<string>>
  private async _filter(capability: FileOperationRegistrationOptions | undefined, items: Array<MoveAction>, property: string) : Promise<Array<MoveAction>>
  private async _filter(capability: FileOperationRegistrationOptions | undefined, items: Array<string | MoveAction>, property?: string) {
    let filters = capability?.filters
    if (!filters) return items

    return items.filter(async (item) => {
      if (!filters) return true
      if (typeof item === 'string') {
        return await pathMatchesFilters(item, filters)
      } else {
        let pathValue = property === 'initialPath' ? item.initialPath : item.newPath
        return await pathMatchesFilters(pathValue, filters)
      }
    })
  }
}

async function getTypeForFilePath(filePath: string): Promise<FileOperationPatternKind | null> {
  let stat = await FS.lstat(filePath)
  if (stat.isDirectory()) return 'folder'
  if (stat.isFile()) return 'file'
  return null
}

function pathMatchesGlob(filePath: string, glob: string) {
  let [projectPath, relativePath] = atom.project.relativizePath(filePath)
  // If this file somehow isn't part of the project, ignore it.
  if (!projectPath) return false
  return minimatch(relativePath, glob)
}

async function pathMatchesFilters(filePath: string, filters: FileOperationFilter[]) {
  let type = await getTypeForFilePath(filePath)
  if (!type) return false

  // A total absence of filters means that we pass.
  if (filters.length === 0) return true

  // But if any filters are specified, we need to pass at least one. Hence
  // we'll try this path against each specified filter and stop after the first
  // match.
  for (let filter of filters) {
    // If a filter specifies a scheme, bail early if it doesn't match this
    // path.
    if (filter.scheme && type !== filter.scheme) {
      continue
    }
    // If a filter doesn't specify a pattern… well, something's gone wrong. But
    // in that case, fail open, as though a filter had not been specified in
    // the first place.
    if (!filter?.pattern?.glob) {
      return true
    } else {
      return pathMatchesGlob(filePath, filter.pattern.glob)
    }
  }

  return false
}

function buildCreateOrDeleteFilesParams(paths: string[]): CreateFilesParams | DeleteFilesParams {
  let files = paths.map(p => ({ uri: Convert.pathToUri(p) }))
  return { files }
}

function buildRenameFilesParams(paths: MoveAction[]): RenameFilesParams {
  let files = paths.map(({ initialPath, newPath }) => {
    return {
      oldUri: Convert.pathToUri(initialPath),
      newUri: Convert.pathToUri(newPath)
    }
  })
  return { files }
}
