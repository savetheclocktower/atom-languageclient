import {
  DisplayMarker,
  DisplayMarkerLayer,
  TextBuffer,
  TextEditor
} from "atom"
import type * as atomIde from "atom-ide-base"
import { promises as fsp, Stats } from "fs"
// @ts-expect-error Messed-up types file
import rimraf from "rimraf"

import Convert from "../convert"
import {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResponse,
  CreateFile,
  DeleteFile,
  DocumentUri,
  LanguageClientConnection,
  RenameFile,
  TextDocumentEdit,
  WorkspaceEdit,
} from "../languageclient"
import DocumentSyncAdapter from "./document-sync-adapter"

// Options to pass to `ApplyEditAdapter.apply`.
type ApplyWorkspaceEditOptions = {
  // Whether to save after making changes to buffers:
  //
  // - 'all' means we will always save after making changes. (Not recommended.)
  // - 'none' means we will never save after making changes.
  // - 'unmodified' means that, if the file was unmodified from disk before we
  //   applied changes, we will save it once the changes were made.
  //
  // For backward compatibility, 'unmodified' is the default value.
  save?: 'all' | 'none' | 'unmodified'
}

/** Public: Adapts workspace/applyEdit commands to editors. */
export default class ApplyEditAdapter {
  private static _markerLayersForEditors = new WeakMap<TextEditor, DisplayMarkerLayer>()

  private static _documentSyncAdapter: DocumentSyncAdapter | null = null

  /**
   * Public: Attach to a {@link LanguageClientConnection} to receive edit
   * events.}
   * @param connection
   */
  public static attach(
    connection: LanguageClientConnection,
    documentSyncAdapter?: DocumentSyncAdapter
  ): void {
    if (documentSyncAdapter) {
      this._documentSyncAdapter = documentSyncAdapter
    }
    connection.onApplyEdit((m) => ApplyEditAdapter.onApplyEdit(m))
  }

  public static findOrCreateMarkerLayerForEditor(editor: TextEditor): DisplayMarkerLayer {
    let layer = this._markerLayersForEditors.get(editor)
    if (layer === undefined) {
      layer = editor.addMarkerLayer({ maintainHistory: true })
      this._markerLayersForEditors.set(editor, layer)
    }
    return layer
  }

  /**
   * Tries to apply edits and reverts if anything goes wrong. Returns the
   * checkpoint so that the caller can revert changes if needed.
   */
  public static applyEdits(editor: TextEditor, rawEdits: atomIde.TextEdit[]): number {
    const buffer = editor.getBuffer()
    const checkpoint = buffer.createCheckpoint()
    const edits: atomIde.TextEdit[] = normalizeTextEdits(rawEdits)
    // TODO: Decide whether to allow a package to spy on `TextEdit`s or
    // alter/override them with an advice method.
    try {
      const layer = ApplyEditAdapter.findOrCreateMarkerLayerForEditor(editor)

      const markerMap = new Map<atomIde.TextEdit, DisplayMarker>()
      for (const edit of edits) {
        const marker = layer.markBufferRange(edit.oldRange)
        markerMap.set(edit, marker)
      }

      // Sort edits in reverse order to prevent edit conflicts. (But markers
      // should also take care of this.)
      edits.sort(
        (edit1, edit2) => -edit1.oldRange.compare(edit2.oldRange)
      )
      edits.reduce(
        (previous: atomIde.TextEdit | null, current) => {
          validateEdit(buffer, current, previous)
          const marker = markerMap.get(current)
          if (!marker) throw new Error(`Marker missing range!`)
          buffer.setTextInRange(marker.getBufferRange(), current.newText)
          return current
        },
        null
      )
      buffer.groupChangesSinceCheckpoint(checkpoint)
      return checkpoint
    } catch (err) {
      buffer.revertToCheckpoint(checkpoint)
      throw err
    }
  }

  public static async onApplyEdit(params: ApplyWorkspaceEditParams): Promise<ApplyWorkspaceEditResponse> {
    return ApplyEditAdapter.apply(params.edit)
  }

  /**
   * Apply an LSP {@link WorkspaceEdit} to a project.
   *
   * A `WorkspaceEdit` is more expansive than a `TextEdit[]` list and can
   * include file operations like creations, deletions, and renamings.
   */
  public static async apply(
    rawWorkspaceEdit: WorkspaceEdit,
    { save = 'unmodified' }: ApplyWorkspaceEditOptions = {}
  ): Promise<ApplyWorkspaceEditResponse> {
    const workspaceEdit = rawWorkspaceEdit
    // TODO: Decide whether to allow a package to spy on `WorkspaceEdit`s or
    // alter/override them with an advice method.
    normalize(workspaceEdit)

    // Keep checkpoints from all successful buffer edits.
    const checkpoints: Array<{ buffer: TextBuffer; checkpoint: number }> = []

    // Here are the ways that a `WorkspaceEdit` could plausibly fail:
    //
    // * A `TextDocumentEdit` is nonsensical or invalid in some way (e.g.,
    //   describes an invalid range).
    // * Multiple `TextDocumentEdit`s are provided and are invalid as a group
    //   (e.g., they overlap).
    // * One or more of the edits assumes a version of the document that is no
    //   longer valid.
    // * We're asked to create a file, but the file already exists.
    // * We're asked to rename a file, but the destination name already exists.
    // * We're asked to delete a file, but the file does not exist.
    // * One of the file-based operations fails because of a lack of
    //   permissions.
    //
    // We've listed our `workspaceEdit.failureHandling` capability as
    // “text-only transactional.” That means that, if we somehow fail to apply
    // this `WorkspaceEdit`, we commit to rolling back the `TextDocumentEdit`s
    // but not any of the resource (file) operations.
    //
    // It's good that we have this option because we don't really have the
    // capability of doing otherwise in the general case. The LSP spec does not
    // restrict the ability of a `WorkspaceEdit` to interleave various kinds of
    // edits; in fact, if resource operations are included, the client _must_
    // apply edits in the prescribed order. (This is surely because a single
    // `WorkspaceEdit` can, e.g., both create a file and add content to it, so
    // one must come before the other.)
    //
    // We could go to great lengths to try to bundle arbitrary batches of
    // filesystem changes into a single transaction, but not even VS Code
    // appears to do this. Instead, we'll apply `WorkspaceEdit`s as the spec
    // directs us to, and if they fail… well, we didn't over-promise.
    //
    // If a specific IDE package wants to opt out of this behavior, it can
    // override `getInitializeParams` and modify what it reports to a specific
    // language server; it'd probably want to change
    // `capabilities.workspace.resourceOperations` to `undefined` before
    // returning it. This would signal to the language server that it should
    // not try to send the client any resource operations in the first place.
    const promises = (workspaceEdit.documentChanges || []).map(
      async (edit): Promise<void> => {
        if (!TextDocumentEdit.is(edit)) {
          return ApplyEditAdapter.handleResourceOperation(edit).catch((err) => {
            throw Error(`Error during ${edit.kind} resource operation: ${err.message}`)
          })
        }
        const path = Convert.uriToPath(edit.textDocument.uri)

        // TODO: Feels weird to force an editor to open for each unique buffer
        // to which we want to apply edits. But it's necessary when
        // `options.save` is `none`, since that forces us to give the modified
        // state a UI so that the user can approve or reject the edit.
        //
        // But when `options.save` is `all` or `unmodified`, we should be able
        // to get away with applying edits to `TextBuffer`s headlessly the way
        // we do in other code paths.
        const editor = (await atom.workspace.open(path, {
          searchAllPanes: true,
          // Open new editors in the background.
          activatePane: false,
          activateItem: false,
        })) as TextEditor

        const wasModified = editor.isModified()
        const buffer = editor.getBuffer()

        // A language server can give us a `VersionedTextDocumentIdentifier`
        // instead of a simple `TextDocumentIdentifier`. This is safer because
        // it tells us the versions of the documents against which this
        // `WorkspaceEdit` was made.
        if (edit.textDocument.version && this._documentSyncAdapter) {
          const editorSyncAdapter = this._documentSyncAdapter.getEditorSyncAdapter(editor)
          if (editorSyncAdapter) {
            const versionedTextDocumentIdentifier = editorSyncAdapter.getVersionedTextDocumentIdentifier()
            if (edit.textDocument.version !== versionedTextDocumentIdentifier.version) {
              throw new Error(`Version mismatch on document: ${edit.textDocument.uri}; expected version ${edit.textDocument.version} but got version ${versionedTextDocumentIdentifier.version}`)
            }
          }
        }
        const edits = Convert.convertLsTextEdits(edit.edits)
        const checkpoint = ApplyEditAdapter.applyEdits(editor, edits)
        checkpoints.push({ buffer, checkpoint })
        if (save === 'none') {
          return
        } else if (save === 'unmodified' && wasModified) {
          return
        } else {
          await editor.save()
        }
      }
    )

    // Apply all edits… or fail and revert everything that we can possibly
    // revert.
    const applied = await Promise.all(promises)
      .then(() => true)
      .catch((err) => {
        atom.notifications.addError("workspace/applyEdits failed", {
          description: "Failed to apply edits.",
          detail: err.message,
        })
        checkpoints.forEach(({ buffer, checkpoint }) => {
          buffer.revertToCheckpoint(checkpoint)
        })
        return false
      })

    return { applied }
  }

  private static async handleResourceOperation(edit: CreateFile | RenameFile | DeleteFile): Promise<void> {
    if (DeleteFile.is(edit)) {
      const path = Convert.uriToPath(edit.uri)
      const stats: false | Stats = await fsp.lstat(path).catch(() => false)
      const ignoreIfNotExists = edit.options?.ignoreIfNotExists

      if (stats === false) {
        if (ignoreIfNotExists !== false) {
          return
        }
        throw Error(`Target doesn't exist.`)
      }

      if (stats.isDirectory()) {
        if (edit.options?.recursive) {
          return new Promise((resolve, reject) => {
            rimraf(path, { glob: false }, (err: unknown) => {
              if (err) {
                reject(err)
              }
              resolve()
            })
          })
        }
        return fsp.rmdir(path, { recursive: edit.options?.recursive })
      }

      return fsp.unlink(path)
    }
    if (RenameFile.is(edit)) {
      const oldPath = Convert.uriToPath(edit.oldUri)
      const newPath = Convert.uriToPath(edit.newUri)
      const exists = await fsp
        .access(newPath)
        .then(() => true)
        .catch(() => false)
      const ignoreIfExists = edit.options?.ignoreIfExists
      const overwrite = edit.options?.overwrite

      if (exists && ignoreIfExists && !overwrite) {
        return
      }

      if (exists && !ignoreIfExists && !overwrite) {
        throw Error(`Target exists.`)
      }

      return fsp.rename(oldPath, newPath)
    }
    if (CreateFile.is(edit)) {
      const path = Convert.uriToPath(edit.uri)
      const exists = await fsp
        .access(path)
        .then(() => true)
        .catch(() => false)
      const ignoreIfExists = edit.options?.ignoreIfExists
      const overwrite = edit.options?.overwrite

      if (exists && ignoreIfExists && !overwrite) {
        return
      }

      return fsp.writeFile(path, "")
    }
  }
}

function normalize(workspaceEdit: WorkspaceEdit): void {
  const documentChanges = workspaceEdit.documentChanges || []

  if (!("documentChanges" in workspaceEdit) && "changes" in workspaceEdit) {
    Object.keys(workspaceEdit.changes || []).forEach((uri: DocumentUri) => {
      documentChanges.push({
        textDocument: {
          version: null,
          uri,
        },
        edits: workspaceEdit.changes![uri],
      })
    })
  }

  workspaceEdit.documentChanges = documentChanges
}

/**
 * Fix lists of `TextEdit`s that include multiple edits at the same insertion
 * point.
 *
 * Generally, the LSP spec doesn't like `TextEdit` lists in which the edits
 * overlap. But it does carve out an exception for several edits inserting at
 * the same point; it says that the edits should be applied in order:
 *
 *    If multiple inserts have the same position, the order in the array
 *    defines the order in which the inserted strings appear in the resulting
 *    text.
 *
 * This is where we implement this behavior. We group edits together by their
 * stated range, then we consolidate them in a way that preserves the ordering
 * and intent.
 *
 * There are possible ways to construct lists of `TextEdit`s that would run
 * afoul of this normalization because they flagrantly violate the spec (e.g.,
 * interleaving insertion edits with other edits, or having genuine overlaps),
 * and this won't catch those cases. But that's fine.
 *
 * One thing is unclear, though. The LSP spec lists examples of multiple edits
 * having the same insertion point: “…multiple inserts, or any number of
 * inserts followed by a single remove or replace edit.” It's not obvious how
 * the second example is meant.
 *
 * If it means that the final edit might remove or replace text elsewhere in
 * the document, in a way that does not overlap with the referenced insertions,
 * that's fine.
 *
 * But if it means that the final edit would alter some of the content inserted
 * by the earlier inserts, then that's a problem! The whole point is that the
 * `range` of the LSP `TextEdit` describes buffer coordinates _before any edits
 * have been applied_. So the final `TextEdit` would be unexpressable.
 *
 * Thus: even after this normalization process, if the returned `TextEdit[]`
 * list contains edits with overlapping ranges, then it is still invalid, and
 * we will be unable to apply it. We can handle normalization in the way that
 * the LSP spec describes, but we can't turn genuinely incoherent edit lists
 * into something valid.
 */
function normalizeTextEdits(edits: atomIde.TextEdit[]) {
  if (edits.length === 1) return edits
  if (!textEditListHasDuplicateRanges(edits)) return edits

  // Keys will be string representations of ranges; values will be arrays of
  // strings.
  const editIndex = new Index<string, string>()
  // Keep track of which ranges we've already seen.
  const seenRanges = new Set<string>()

  // This list will hold the first `TextEdit` for each unique `oldRange`. This
  // is how we ensure that ordering is preserved.
  //
  // Whenever we skip adding an edit to this list, it's because there's an
  // earlier edit with the same range, and that edit will be the one that
  // we alter to consolidate the group of edits at that range.
  const orderedEdits: atomIde.TextEdit[] = []
  for (const edit of edits) {
    const key = edit.oldRange.toString()
    if (!seenRanges.has(key)) {
      orderedEdits.push(edit)
      seenRanges.add(key)
    }
    editIndex.add(key, edit.newText)
  }

  // Build a new `TextEdit[]` list. Keep the original ordering and preserve
  // the metadata held by the the first edit for each unique range, but
  // consolidate all insertions for a given range into one edit.
  const result: atomIde.TextEdit[] = []
  for (const edit of orderedEdits) {
    const key = edit.oldRange.toString()
    const newText = editIndex.get(key)!.join('')
    result.push({ ...edit, newText })
  }

  return result
}

function validateEdit(buffer: TextBuffer, edit: atomIde.TextEdit, prevEdit: atomIde.TextEdit | null): void {
  const path = buffer.getPath() || ""
  if (prevEdit && edit.oldRange.end.compare(prevEdit.oldRange.start) > 0) {
    throw Error(`Found overlapping edit ranges in ${path}`)
  }
  const startRow = edit.oldRange.start.row
  const startCol = edit.oldRange.start.column
  const lineLength = buffer.lineLengthForRow(startRow)
  if (lineLength == null) {
    throw Error(`Out of range edit on ${path}:${startRow + 1}:${startCol + 1}. Desired edit range: ${edit.oldRange.toString()}`)
  } else if (startCol > lineLength) {
    // The edit wants to start at a point that's past the end of the line, but
    // this is OK. `setTextInRange` seems to do just fine with this.
  }
}

// Detects whether a list of `TextEdit`s is problematic in a specific way — if
// it include the exact same range in more than one edit.
function textEditListHasDuplicateRanges(textEdits: atomIde.TextEdit[]) {
  const ranges = new Set()
  for (const edit of textEdits) {
    const key = edit.oldRange.toString()
    if (ranges.has(key)) return true
    ranges.add(key)
  }
  return false
}


// Private: A subclass of `Map` that anticipates multiple values at each key.
// The main way to add a value at a given key is via a new `Index::add` method.
class Index<K, V> extends Map<K, V[]> {
  // Like `Map::set`, but adds one or more values at a given key. Initializes
  // the key's value to be an empty array if necessary.
  add(key: K, ...values: V[]) {
    let existing = this.get(key)
    if (!existing) {
      existing = []
      this.set(key, existing)
    }
    existing.push(...values)
  }
}
