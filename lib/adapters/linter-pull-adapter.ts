import { Point, Range, TextEditor } from "atom"
import * as linter from "atom/linter"
import { CancellationTokenSource } from "vscode-jsonrpc"

import Convert from "../convert"
import { DocumentDiagnosticParams, DocumentDiagnosticReportKind, FullDocumentDiagnosticReport, LanguageClientConnection } from "../languageclient"
import { Logger, NullLogger } from "../logger"
import { ActiveServer } from "../server-manager"
import * as Utils from '../utils'
import IntentionsListAdapter from "./intentions-list-adapter"
import { lsDiagnosticToV2Message } from "./linter-push-v2-adapter"

// TODO: Does not yet support incremental re-linting by passing a `resultId`.

export default class LinterPullAdapter {
  private _cancellationTokens: WeakMap<LanguageClientConnection, CancellationTokenSource> = new WeakMap()

  private lastResultsForEditor: WeakMap<TextEditor, FullDocumentDiagnosticReport> = new WeakMap()

  private currentMessagesForEditor: WeakMap <TextEditor, linter.Message[]> = new WeakMap()

  logger: Logger
  intentionsListAdapter?: IntentionsListAdapter

  constructor({ logger, intentionsManager }: { logger?: Logger, intentionsManager?: IntentionsListAdapter }) {
    this.logger = logger ?? new NullLogger()
    this.intentionsListAdapter = intentionsManager
  }

  async lint(server: ActiveServer, editor: TextEditor) {
    this.logger.log('Linting editor', editor)
    const { connection } = server
    const textDocument = Convert.editorToTextDocumentIdentifier(editor)
    const lastResults = this.lastResultsForEditor.get(editor)
    const params: DocumentDiagnosticParams = { textDocument }
    // If we have a previous result from this editor, we can pass
    if (lastResults?.resultId) {
      params.previousResultId = lastResults.resultId
    }
    const result = await Utils.doWithCancellationToken(
      connection,
      this._cancellationTokens,
      (cancellationToken) => {
        return connection.diagnostic(params, cancellationToken)
      }
    )

    if (!result) return null

    // Now we're dealing with a document diagnostic report.
    if (result.kind === DocumentDiagnosticReportKind.Unchanged) {
      this.logger.info('Unchanged; reusing last result')
      // TODO: How should we handle this? Will `linter` do the right thing if
      // we don't return anything here, or will we have to cache the last set
      // of results and send them again in these scenarios?
      return this.reportToLinterMessages(lastResults ?? null, editor)
    }

    this.lastResultsForEditor.set(editor, result)

    return this.reportToLinterMessages(result, editor)
  }

  private reportToLinterMessages(
    report: FullDocumentDiagnosticReport | null,
    editor: TextEditor
  ) {
    if (report === null) return null

    const { items } = report
    const filePath = editor.getPath() ?? ''
    const messages = items.map(item => {
      const code = item.code ? String(item.code) : null
      const message = lsDiagnosticToV2Message(filePath, item)
      this.intentionsListAdapter?.onLinterMessageAdded(filePath, message, code ?? '', item, () => {}) // TODO
      return message
    })
    this.currentMessagesForEditor.set(editor, messages)
    return messages
  }

  public getDiagnosticsForEditorAtPosition(editor: TextEditor, position: Point | Range) {
    const report = this.lastResultsForEditor.get(editor)
    const diagnostics = report?.items ?? []

    return diagnostics.filter(diagnostic => {
      const diagnosticRange = Convert.lsRangeToAtomRange(diagnostic.range)
      if (positionIsPoint(position)) {
        return diagnosticRange.containsPoint(position)
      } else {
        return position.containsRange(diagnosticRange)
      }
    })
  }

  public getMessagesForEditorAtPosition(editor: TextEditor, position: Point | Range) {
    const messages = this.currentMessagesForEditor.get(editor) ?? []
    return messages.filter(message => {
      const messageRange = message.location.position
      if (positionIsPoint(position)) {
        return messageRange.containsPoint(position)
      } else {
        return position.containsRange(messageRange)
      }
    })
  }
}

function positionIsPoint(position: Point | Range): position is Point {
  return ('row' in position) && (typeof position.row === 'number')
}
