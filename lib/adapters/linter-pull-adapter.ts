import * as linter from "atom/linter"
import { Diagnostic, DocumentDiagnosticParams, DocumentDiagnosticReportKind, FullDocumentDiagnosticReport, LanguageClientConnection, MarkupContent } from "../languageclient"
import { CancellationTokenSource } from "vscode-jsonrpc"
import { Logger, NullLogger } from "../logger"
import { Point, Range, TextEditor } from "atom"
import * as Utils from '../utils'
import Convert from "../convert"
import LinterPushV2Adapter from "./linter-push-v2-adapter"
import { ActiveServer } from "../server-manager"
import IntentionsListAdapter from "./intentions-list-adapter"

// TODO: Does not yet support incremental re-linting by passing a `resultId`.

export default class LinterPullAdapter {
  private _cancellationTokens: WeakMap<LanguageClientConnection, CancellationTokenSource> = new WeakMap()

  private lastResultsForEditor: WeakMap<TextEditor, FullDocumentDiagnosticReport> = new WeakMap()

  private currentMessagesForEditor: WeakMap <TextEditor, linter.Message[]> = new WeakMap()

  logger: Logger
  intentionsListAdapter?: IntentionsListAdapter

  constructor ({ logger, intentionsManager }: { logger?: Logger, intentionsManager?: IntentionsListAdapter }) {
    this.logger = logger ?? new NullLogger()
    this.intentionsListAdapter = intentionsManager
  }

  async lint (server: ActiveServer, editor: TextEditor) {
    this.logger.log('Linting editor', editor)
    let { connection } = server
    let textDocument = Convert.editorToTextDocumentIdentifier(editor)
    let lastResults = this.lastResultsForEditor.get(editor)
    let params: DocumentDiagnosticParams = { textDocument }
    // If we have a previous result from this editor, we can pass
    if (lastResults?.resultId) {
      params.previousResultId = lastResults.resultId
    }
    let result = await Utils.doWithCancellationToken(
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

    let { items } = report
    let filePath = editor.getPath() ?? ''
    let messages = items.map(item => {
      let code = item.code ? String(item.code) : null
      let message = this.diagnosticToV2Message(filePath, item)
      this.intentionsListAdapter?.onLinterMessageAdded(filePath, message, code ?? '', item, () => {}) // TODO
      return message
    })
    this.currentMessagesForEditor.set(editor, messages)
    return messages
  }

  // TODO: Share utilities between linter types.
  public diagnosticToV2Message (filePath: string, diagnostic: Diagnostic): linter.Message {
    return {
      location: {
        file: filePath,
        position: Convert.lsRangeToAtomRange(diagnostic.range)
      },
      excerpt: this.normalizeMessageText(diagnostic.message),
      linterName: diagnostic.source,
      severity: LinterPushV2Adapter.diagnosticSeverityToSeverity(diagnostic.severity ?? -1)
    }
  }

  private normalizeMessageText (text: string | MarkupContent) {
    if (typeof text === 'string') return text
    return text.value
  }

  public getDiagnosticsForEditorAtPosition (editor: TextEditor, position: Point | Range) {
    let report = this.lastResultsForEditor.get(editor)
    let diagnostics = report?.items ?? []

    return diagnostics.filter(diagnostic => {
      let diagnosticRange = Convert.lsRangeToAtomRange(diagnostic.range)
      if (positionIsPoint(position)) {
        return diagnosticRange.containsPoint(position)
      } else {
        return position.containsRange(diagnosticRange)
      }
    })
  }

  public getMessagesForEditorAtPosition (editor: TextEditor, position: Point | Range) {
    let messages = this.currentMessagesForEditor.get(editor) ?? []
    return messages.filter(message => {
      let messageRange = message.location.position
      if (positionIsPoint(position)) {
        return messageRange.containsPoint(position)
      } else {
        return position.containsRange(messageRange)
      }
    })
  }
}

function positionIsPoint (position: Point | Range): position is Point {
  return ('row' in position) && (typeof position.row === 'number');
}
