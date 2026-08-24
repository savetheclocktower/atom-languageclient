import { CompositeDisposable, Disposable } from "atom"
import minimatch from 'minimatch'
import {
  CreateFilesParams,
  DeleteFilesParams,
  FileOperationOptions,
  FileOperationPatternKind,
  FileOperationRegistrationOptions,
  RenameFilesParams,
  ServerCapabilities,
  WorkspaceEdit
} from "vscode-languageserver-protocol"

import Convert from "../convert"
import { LanguageClientConnection } from "../languageclient"
import ApplyEditAdapter from "./apply-edit-adapter"

type FileOperationFilter = FileOperationRegistrationOptions['filters'][number];

/**
 * Whether a file operation acted on a file or on a directory.
 *
 * Named to match the LSP vocabulary: a server's filters narrow themselves by
 * {@link FileOperationPatternKind}, whose values are exactly these.
 */
export type FileOperationKind = FileOperationPatternKind

// Every action reports its `kind`, because only `tree-view` is in a position
// to know it. The filesystem cannot be consulted after the fact: a path being
// created does not exist yet, and one just deleted no longer does.
// `tree-view`, by contrast, knows which the user asked for — “Add File” and
// “Add Folder” are distinct commands.
//
// The three actions are told apart by which of `oldPath`/`newPath` they carry:
// `oldPath` is where something was, `newPath` is where it will be. A creation
// has only the latter, a deletion only the former, and a move has both.

/** A file or folder being created. */
export interface CreateAction {
  kind: FileOperationKind
  newPath: string
  oldPath?: never
}

/** A file or folder being deleted. */
export interface DeleteAction {
  kind: FileOperationKind
  oldPath: string
  newPath?: never
}

/** A file or folder being moved from one path to another. */
export interface MoveAction {
  kind: FileOperationKind
  oldPath: string
  newPath: string
}

/** A callback suitable for passing to `onWillCreate`. */
type TreeViewBeforeCreateCallback = (actions: CreateAction[], handle: TreeViewV1_1Handle) => void
/** A callback suitable for passing to `onDidCreate`. */
type TreeViewAfterCreateCallback = (actions: CreateAction[]) => void

/** A callback suitable for passing to `onWillDelete`. */
type TreeViewBeforeDeleteCallback = (actions: DeleteAction[], handle: TreeViewV1_1Handle) => void
/** A callback suitable for passing to `onDidDelete`. */
type TreeViewAfterDeleteCallback = (actions: DeleteAction[]) => void

/** A callback suitable for passing to `onWillMove`. */
type TreeViewBeforeMoveCallback = (actions: MoveAction[], handle: TreeViewV1_1Handle) => void
/** A callback suitable for passing to `onDidMove`. */
type TreeViewAfterMoveCallback = (actions: MoveAction[]) => void

// A service definition for the proposed `tree-view` v2 service.
export interface TreeViewV1_1Service {
  /**
   * Returns a list of the paths currently selected in the tree view.
   *
   * All returned paths will be absolute.
   */
  selectedPaths(): string[]
  /**
   * Returns the HTML element that corresponds to the given path.
   *
   * Designed to accept an absolute path; if there is no match, will return the
   * entry with the longest match among all entries for which `path` is a
   * substring match.
   */
  entryForPath(path: string): HTMLElement

  /**
   * Select the item for the given path in the tree view. If necessary, will
   * also reveal the tree view and ensure the item is visible in the
   * scrollport.
   */
  revealPath(path: string): boolean

  /**
   * Register a callback to act before one or more files are moved.
   *
   * The callback may delay the operation to perform an action; see
   * {@link TreeViewV1_1Handle} for caveats.
   */
  onWillMove(callback: TreeViewBeforeMoveCallback): Disposable
  /**
   * Register a callback to act before one or more files are deleted.
   *
   * The callback may delay the operation to perform an action; see
   * {@link TreeViewV1_1Handle} for caveats.
   */
  onWillDelete(callback: TreeViewBeforeDeleteCallback): Disposable
  /**
   * Register a callback to act before one or more files are created.
   *
   * The callback may delay the operation to perform an action; see
   * {@link TreeViewV1_1Handle} for caveats.
   */
  onWillCreate(callback: TreeViewBeforeCreateCallback): Disposable

  /**
   * Register a callback to act after one or more files are moved.
   */
  onDidMove(callback: TreeViewAfterMoveCallback): Disposable
  /**
   * Register a callback to act after one or more files are deleted.
   */
  onDidDelete(callback: TreeViewAfterDeleteCallback): Disposable
  /**
   * Register a callback to act after one or more files are created.
   */
  onDidCreate(callback: TreeViewAfterCreateCallback): Disposable
}

/**
 * An object passed to `onWill*` callbacks of the tree view service. Allows the
 * consumer to delay the file operation until another arbitrary action is done,
 * though the tree view may enforce its own time limit for UX reasons.
 */
interface TreeViewV1_1Handle {
  /**
   * Request that the work done in `fn` be done _before_ the file operation is
   * performed.
   *
   * Since `fn` will often involve file operations and other async work, it may
   * go async… but the tree view reserves the right to enforce a timeout value
   * rather than wait indefinitely.
   *
   * Whatever requested the delay is responsible for checking {@link signal}
   * after any async work and responding appropriately (returning immediately,
   * rolling back any half-done work, etc.) if `tree-view` got impatient.
   *
   * Delaying is opt-in for a reason: a consumer that merely wants to do some
   * async bookkeeping shouldn't hold up the user's file operation to do it. If
   * the callback simply returned a promise, every `async` callback would block
   * by accident, whether or not it meant to.
   *
   * Must be called synchronously while the callback is running. A call made
   * later — from a `setTimeout`, say — arrives after the tree view has decided
   * whether to wait, and will be refused.
   *
   * Several packages may consume this service, and any of them may ask to
   * delay the same operation. All such requests run concurrently and share a
   * single timeout budget, since what the user is waiting on is the operation,
   * not any particular consumer. One slow consumer can therefore cost the
   * others their turn.
   *
   * @param fn The work to perform before the file operation proceeds.
   * @returns A promise that settles once the tree view has stopped waiting —
   *   whether because `fn` finished or because the budget ran out.
   */
  waitUntil(fn: () => void | Promise<void>): Promise<void>

  /**
   * Signals that the permission was revoked — i.e., that `tree-view` ran out of
   * patience and performed the file operation that a consumer asked it to
   * delay.
   *
   * This is stronger than ordinary cancellation: it means the operation has
   * **already happened**. Work done on the assumption that it hadn't is now
   * based on a stale picture of the filesystem, so a consumer should generally
   * discard it rather than apply it late.
   *
   * An {@link AbortSignal} rather than a bare boolean so that it can be
   * subscribed to and composed, and so that it matches how `symbols-view`
   * expresses the same idea to its own providers.
   */
  signal: AbortSignal
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
  private _subscriptions = new CompositeDisposable()

  /**
   * Public: Determine whether this adapter can be used on a given server.
   * @param serverCapabilities The {ServerCapabilities} of the language server
   *   to consider.
   * @returns A boolean indicating whether this adapter can adapt the server.
   */
  static canAdapt(serverCapabilities: ServerCapabilities | undefined): boolean {
    const fileOps = serverCapabilities?.workspace?.fileOperations
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
    private _treeViewService: TreeViewV1_1Service,
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
      this._subscriptions.add(
        this._treeViewService.onWillCreate((actions, handle) => this.willCreateFiles(actions, handle))
      )
    }
    if (this._capabilities?.willRename) {
      this._subscriptions.add(
        this._treeViewService.onWillMove((actions, handle) => this.willRenameFiles(actions, handle))
      )
    }
    if (this._capabilities?.willDelete) {
      this._subscriptions.add(
        this._treeViewService.onWillDelete((actions, handle) => this.willDeleteFiles(actions, handle))
      )
    }

    // The `onDidX` capabilities are wired up to methods that send out
    // `workspace/didXFiles` notifications. Unlike the methods above, these are
    // notifications because the server will not respond.
    if (this._capabilities?.didCreate) {
      this._subscriptions.add(
        this._treeViewService.onDidCreate((actions) => this.didCreateFiles(actions))
      )
    }
    if (this._capabilities?.didRename) {
      this._subscriptions.add(
        this._treeViewService.onDidMove((actions) => this.didRenameFiles(actions))
      )
    }
    if (this._capabilities?.didDelete) {
      this._subscriptions.add(
        this._treeViewService.onDidDelete((actions) => this.didDeleteFiles(actions))
      )
    }
  }

  /**
   * Public: Unsubscribe from the `tree-view` service.
   *
   * These subscriptions belong to the tree view rather than to the server, so
   * they outlive a server shutdown unless they are disposed of explicitly —
   * leaving handlers firing at a dead connection.
   */
  public dispose(): void {
    this._subscriptions.dispose()
  }

  /**
   * Send a `willCreateFiles` request to the language server and apply any
   * {WorkspaceEdit} that may be returned.
   * @param actions An {Array} of the creations to be performed.
   * @param handle The handle that allows us to delay the file operation.
   */
  async willCreateFiles(actions: CreateAction[], handle: TreeViewV1_1Handle) {
    // The call to `handle.waitUntil` signals to `tree-view` that we'd _like to_
    // perform this work. But `tree-view` will only wait for a reasonable
    // amount of time; the LSP spec allows a client to ignore a server if it's
    // too slow to process this request.
    await handle.waitUntil(async () => {
      const filtered = await this._filter(this._capabilities!.willCreate, actions, (a) => a.newPath)
      const params = buildCreateFilesParams(filtered)
      const result = await this._connection.willCreateFiles(params)
      // TODO: Most of what a language server does in response to a file
      // operation would still be valid even if it were applied after the
      // operation were done! Maybe this should be left up to the consumer to
      // decide.
      if (handle.signal.aborted) return
      await this._handleResult(result)
    })
  }

  /**
   * Send a `willRenameFiles` request to the language server and apply any
   * {WorkspaceEdit} that may be returned.
   * @param actions An {Array} of objects, each one describing the old and new
   *   file paths of each operation in the batch.
   * @param handle The handle that allows us to delay the file operation.
   */
  async willRenameFiles(actions: MoveAction[], handle: TreeViewV1_1Handle) {
    // The call to `handle.waitUntil` signals to `tree-view` that we'd _like to_
    // perform this work. But `tree-view` will only wait for a reasonable
    // amount of time; the LSP spec allows a client to ignore a server if it's
    // too slow to process this request.
    await handle.waitUntil(async () => {
      // Matched on the origin path: the server is being told about a file it
      // already knows by that name.
      const filtered = await this._filter(this._capabilities!.willRename, actions, (a) => a.oldPath)
      const params = buildRenameFilesParams(filtered)
      const result = await this._connection.willRenameFiles(params)
      if (handle.signal.aborted) return
      await this._handleResult(result)
    })
  }

  /**
   * Send a `willDeleteFiles` request to the language server and apply any
   * {WorkspaceEdit} that may be returned.
   * @param actions An {Array} of the deletions to be performed.
   * @param handle The handle that allows us to delay the file operation.
   */
  async willDeleteFiles(actions: DeleteAction[], handle: TreeViewV1_1Handle) {
    // The call to `handle.waitUntil` signals to `tree-view` that we'd _like to_
    // perform this work. But `tree-view` will only wait for a reasonable
    // amount of time; the LSP spec allows a client to ignore a server if it's
    // too slow to process this request.
    await handle.waitUntil(async () => {
      const filtered = await this._filter(this._capabilities!.willDelete, actions, (a) => a.oldPath)
      const params = buildDeleteFilesParams(filtered)
      const result = await this._connection.willDeleteFiles(params)
      if (handle.signal.aborted) return
      await this._handleResult(result)
    })
  }

  /**
   * Send a `didCreateFiles` notification to the language server.
   * @param actions An {Array} of the creations that were performed.
   */
  async didCreateFiles(actions: CreateAction[]) {
    const filtered = await this._filter(this._capabilities!.didCreate, actions, (a) => a.newPath)
    const params = buildCreateFilesParams(filtered)
    return this._connection.didCreateFiles(params)
  }

  /**
   * Send a `didRenameFiles` notification to the language server.
   * @param actions An array of objects, each one describing the old and new
   *   file paths of each operation in the batch.
   */
  async didRenameFiles(actions: MoveAction[]) {
    // Matched on the origin path, exactly as `willRenameFiles` does. Filtering
    // the two phases on different paths would let them disagree: renaming
    // `foo.txt` to `foo.ts` under a `**/*.ts` filter would produce a
    // `didRenameFiles` with no preceding `willRenameFiles`.
    const filtered = await this._filter(this._capabilities!.didRename, actions, (a) => a.oldPath)
    const params = buildRenameFilesParams(filtered)
    return this._connection.didRenameFiles(params)
  }

  /**
   * Send a `didDeleteFiles` notification to the language server.
   * @param actions An array of the deletions that were performed.
   */
  async didDeleteFiles(actions: DeleteAction[]) {
    const filtered = await this._filter(this._capabilities!.didDelete, actions, (a) => a.oldPath)
    const params = buildDeleteFilesParams(filtered)
    return this._connection.didDeleteFiles(params)
  }

  private async _handleResult(result: WorkspaceEdit | null) {
    if (!result) return
    await ApplyEditAdapter.apply(result, { save: 'unmodified' })
  }

  /**
   * Private: Given a set of actions, use the server's own capabilities to
   * filter out any that the server has not registered interest in.
   *
   * @param capability A set of {@link FileOperationRegistrationOptions},
   *   including any potential globs that describe files and folders that this
   *   language server cares about.
   * @param actions The actions reported by `tree-view`.
   * @param pathOf Selects the path to match against; which one is relevant
   *   varies by operation, and for a move it varies by phase.
   * @returns The actions the server asked to hear about.
   */
  private async _filter<T extends { kind?: FileOperationKind }>(
    capability: FileOperationRegistrationOptions | undefined,
    actions: T[],
    pathOf: (action: T) => string
  ): Promise<T[]> {
    const filters = capability?.filters
    if (!filters) return actions

    const result: T[] = []
    for (const action of actions) {
      if (pathMatchesFilters(pathOf(action), action.kind, filters)) {
        result.push(action)
      }
    }
    return result
  }
}

/**
 * Match a path against one of a server's globs.
 *
 * The glob is applied to the whole path rather than a project-relative one.
 * The spec documents the glob syntax but never says what it is matched
 * against, so the reference client in `vscode-languageclient` sets the de facto
 * behavior, and it uses the full path. Two further reasons to follow it:
 * {@link FileOperationPattern} carries no base URI to be relative *to* — unlike
 * the `RelativePattern` that 3.17 added for file watchers — and servers are
 * overwhelmingly written and tested against that client.
 *
 * In practice the distinction only shows up for root-anchored globs such as
 * `src/**​/*.ts`; the far more common `**​/*.ts` matches either way, because
 * `**` absorbs any number of leading segments.
 */
function pathMatchesGlob(filePath: string, glob: string) {
  // Normalize Windows separators; the glob syntax is defined in terms of `/`.
  return minimatch(filePath.replace(/\\/g, '/'), glob)
}

/**
 * Decide whether a path is one the server asked to hear about.
 *
 * @param filePath The path in question.
 * @param kind Whether that path is a file or a folder, as reported by
 *   `tree-view`, or `undefined` if it did not say.
 * @param filters The server's registered filters.
 */
function pathMatchesFilters(
  filePath: string,
  kind: FileOperationKind | undefined,
  filters: FileOperationFilter[]
) {
  // A total absence of filters means that we pass.
  if (filters.length === 0) return true

  // But if any filters are specified, we need to pass at least one. Hence
  // we'll try this path against each specified filter and stop after the first
  // match.
  for (const filter of filters) {
    // `scheme` is a URI scheme — `file`, `untitled`, and so on — not a
    // file-versus-folder distinction. Everything `tree-view` reports to us
    // lives on disk, so a filter asking for anything else can't match.
    if (filter.scheme && filter.scheme !== 'file') {
      continue
    }
    // If a filter doesn't specify a pattern… well, something's gone wrong. But
    // in that case, fail open, as though a filter had not been specified in
    // the first place.
    if (!filter?.pattern?.glob) {
      return true
    }
    if (!pathMatchesGlob(filePath, filter.pattern.glob)) {
      continue
    }

    // The glob matched. If this filter doesn't narrow itself to files or to
    // folders, that settles it.
    const wanted = filter.pattern.matches
    if (!wanted) return true

    // If `tree-view` didn't tell us which this is — an older version of the
    // service, say, or an unforeseen ambiguous situation — treat it as a match
    // rather than dropping it. Under-reporting leaves the server with a stale
    // picture of the project, which is worse than telling it about one path
    // too many. `vscode-languageclient` makes the same choice when it can't
    // stat.
    if (kind === undefined || kind === wanted) {
      return true
    }
  }

  return false
}

function buildCreateFilesParams(actions: CreateAction[]): CreateFilesParams {
  return { files: actions.map(({ newPath }) => ({ uri: Convert.pathToUri(newPath) })) }
}

function buildDeleteFilesParams(actions: DeleteAction[]): DeleteFilesParams {
  return { files: actions.map(({ oldPath }) => ({ uri: Convert.pathToUri(oldPath) })) }
}

function buildRenameFilesParams(actions: MoveAction[]): RenameFilesParams {
  const files = actions.map(({ oldPath, newPath }) => {
    return {
      oldUri: Convert.pathToUri(oldPath),
      newUri: Convert.pathToUri(newPath)
    }
  })
  return { files }
}
