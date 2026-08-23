import { Point, Range, TextEditor } from "atom"
import * as linter from "atom/linter"
import { CancellationTokenSource } from "vscode-jsonrpc"

import Convert from "../convert"
import {
  DocumentDiagnosticParams,
  DocumentDiagnosticReportKind,
  FullDocumentDiagnosticReport,
  LanguageClientConnection
} from "../languageclient"
import { Logger, NullLogger } from "../logger"
import { ActiveServer } from "../server-manager"
import * as Utils from '../utils'
import IntentionsListAdapter from "./intentions-list-adapter"
import { LinterMessageDelegate, lsDiagnosticToV2Message } from "./linter-push-v2-adapter"

// TODO: Does not yet support incremental re-linting by passing a `resultId`.

// TODO: Ignores the `relatedDocuments` field of a document diagnostic report.
// A server with `interFileDependencies` may report diagnostics for *other*
// files alongside the one that was asked about — a change here invalidating a
// reference over there — and those are currently dropped. Surfacing them means
// reporting messages for files this `lint()` call was not asked about, which
// the `linter` service's per-editor model does not obviously accommodate.

/**
 * An adapter that implements a “pull” model for retrieving diagnostics via
 * `textDocument/diagnostics`.
 *
 * This method was added in version 3.17.0 of the LSP spec.
 */
export default class LinterPullAdapter {
  private _cancellationTokens: WeakMap<LanguageClientConnection, CancellationTokenSource> = new WeakMap()

  private lastResultsForEditor: WeakMap<TextEditor, FullDocumentDiagnosticReport> = new WeakMap()

  private currentMessagesForEditor: WeakMap <TextEditor, linter.Message[]> = new WeakMap()

  private lastServerForEditor: WeakMap<TextEditor, ActiveServer> = new WeakMap()

  logger: Logger
  intentionsListAdapter?: IntentionsListAdapter
  delegate?: LinterMessageDelegate

  constructor(
    { logger, intentionsManager, delegate }: {
      logger?: Logger,
      intentionsManager?: IntentionsListAdapter,
      delegate?: LinterMessageDelegate
    }
  ) {
    this.logger = logger ?? new NullLogger()
    this.intentionsListAdapter = intentionsManager
    this.delegate = delegate
  }

  /**
   * Re-runs diagnostics for an editor that has already been linted at least
   * once.
   *
   * The push adapter can recapture from the last `publishDiagnostics` payload
   * it was handed; in the pull model the server has to be asked again, so we
   * remember which server last served this editor.
   */
  public async relint(editor: TextEditor): Promise<linter.Message[] | null> {
    const server = this.lastServerForEditor.get(editor)
    if (!server) return null
    return this.lint(server, editor)
  }

  async lint(server: ActiveServer, editor: TextEditor) {
    this.lastServerForEditor.set(editor, server)
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

    // Discard the intentions registered on the previous pass before adding this
    // one's. Without this, the same fix is filed against the same buffer range
    // on every lint and shows up in the menu once per pass. The push adapter
    // clears for the same reason before it captures.
    this.intentionsListAdapter?.clearLinterIntentions(editor)

    const recapture = () => { void this.relint(editor) }

    // A pathological server response — tens of thousands of messages — can
    // overwhelm `linter`, so honor the same cap the push adapter respects.
    const messageLimit = this.delegate?.getLinterMessageLimitForBuffer(editor.getBuffer()) ?? Infinity

    const messages: linter.Message[] = []
    for (const item of items) {
      if (messages.length >= messageLimit) break

      const range = Convert.lsRangeToAtomRange(item.range)
      if (this.delegate?.shouldIgnoreLinterMessage(item, editor, range)) continue

      const code = item.code ? String(item.code) : null
      let message = lsDiagnosticToV2Message(filePath, item)

      // A client may reshape the message, either by mutating it in place and
      // returning nothing or by returning a replacement.
      message = this.delegate?.transformLinterMessage?.(message, item, editor) ?? message

      // The intentions list adapter needs to know when new linter messages are
      // generated so that it can keep track of which ones are associated with
      // which buffer ranges. If the linter messages have any associated fixes,
      // they should be shown in the intentions menu.
      this.intentionsListAdapter?.onLinterMessageAdded(filePath, message, code, item, recapture)
      messages.push(message)
    }

    this.currentMessagesForEditor.set(editor, messages)
    return messages
  }

  /**
   * Returns original {@link Diagnostic} messages with ranges that include the
   * given point or range.
   */
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

  /**
   * Returns {@link linter.Message} objects with ranges that include the given
   * point or range.
   */
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
