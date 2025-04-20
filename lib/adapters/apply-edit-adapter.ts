import type * as atomIde from "atom-ide-base"
import Convert from "../convert"
import {
  LanguageClientConnection,
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResponse,
  WorkspaceEdit,
  TextDocumentEdit,
  CreateFile,
  RenameFile,
  DeleteFile,
  DocumentUri,
} from "../languageclient"
import {
  DisplayMarker,
  DisplayMarkerLayer,
  TextBuffer,
  TextEditor
} from "atom"
import { promises as fsp, Stats } from "fs"
// @ts-ignore Messed-up types file
import rimraf from "rimraf"
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
  save: 'all' | 'none' | 'unmodified'
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
    * checkpoint, so the caller can revert changes if needed.
   */
  public static applyEdits(editor: TextEditor, edits: atomIde.TextEdit[]): number {
    let buffer = editor.getBuffer()
    const checkpoint = buffer.createCheckpoint()
    try {
      let layer = ApplyEditAdapter.findOrCreateMarkerLayerForEditor(editor)

      let markerMap = new Map<atomIde.TextEdit, DisplayMarker>()
      for (let edit of edits) {
        let marker = layer.markBufferRange(edit.oldRange)
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
          let marker = markerMap.get(current)
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

  public static async apply(
    workspaceEdit: WorkspaceEdit,
    options: ApplyWorkspaceEditOptions = { save: 'none' }
  ): Promise<ApplyWorkspaceEditResponse> {
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

        let wasModified = editor.isModified()
        const buffer = editor.getBuffer()

        // A language server can give us a `VersionedTextDocumentIdentifier`
        // instead of a simple `TextDocumentIdentifier`. This is safer because
        // it tells us the versions of the documents against which this
        // `WorkspaceEdit` was made.
        if (edit.textDocument.version && this._documentSyncAdapter) {
          let editorSyncAdapter = this._documentSyncAdapter.getEditorSyncAdapter(editor)
          if (editorSyncAdapter) {
            let versionedTextDocumentIdentifier = editorSyncAdapter.getVersionedTextDocumentIdentifier()
            if (edit.textDocument.version !== versionedTextDocumentIdentifier.version) {
              throw new Error(`Version mismatch on document: ${edit.textDocument.uri}; expected version ${edit.textDocument.version} but got version ${versionedTextDocumentIdentifier.version}`)
            }
          }
        }
        const edits = Convert.convertLsTextEdits(edit.edits)
        const checkpoint = ApplyEditAdapter.applyEdits(editor, edits)
        checkpoints.push({ buffer, checkpoint })
        if (options.save === 'none') {
          return
        } else if (options.save === 'unmodified' && wasModified) {
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
      const stats: boolean | Stats = await fsp.lstat(path).catch(() => false)
      const ignoreIfNotExists = edit.options?.ignoreIfNotExists

      if (!stats) {
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
