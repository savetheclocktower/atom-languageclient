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

type CodeEdit = {
  path: string,
  range: Range,
  newText: string
}

/** Public: Adapts workspace/applyEdit commands to editors. */
export default class ApplyEditAdapter {
  private static _markerLayersForEditors = new WeakMap<TextEditor, DisplayMarkerLayer>()

  /**
   * Public: Attach to a {@link LanguageClientConnection} to receive edit
   * events.}
   * @param connection
   */
  public static attach(connection: LanguageClientConnection): void {
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

  /** Tries to apply edits and reverts if anything goes wrong. Returns the checkpoint, so the caller can revert changes if needed. */
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

  public static async apply(workspaceEdit: WorkspaceEdit): Promise<ApplyWorkspaceEditResponse> {
    normalize(workspaceEdit)

    // Keep checkpoints from all successful buffer edits
    const checkpoints: Array<{ buffer: TextBuffer; checkpoint: number }> = []

    const promises = (workspaceEdit.documentChanges || []).map(
      async (edit): Promise<void> => {
        if (!TextDocumentEdit.is(edit)) {
          return ApplyEditAdapter.handleResourceOperation(edit).catch((err) => {
            throw Error(`Error during ${edit.kind} resource operation: ${err.message}`)
          })
        }
        const path = Convert.uriToPath(edit.textDocument.uri)
        const editor = (await atom.workspace.open(path, {
          searchAllPanes: true,
          // Open new editors in the background.
          activatePane: false,
          activateItem: false,
        })) as TextEditor
        const buffer = editor.getBuffer()
        const edits = Convert.convertLsTextEdits(edit.edits)
        const checkpoint = ApplyEditAdapter.applyEdits(editor, edits)
        checkpoints.push({ buffer, checkpoint })
      }
    )

    // Apply all edits or fail and revert everything
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
