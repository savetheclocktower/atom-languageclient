import { BusyMessage, BusySignalService } from "atom-ide"

import {
  LanguageClientConnection,
  ProgressToken,
  WorkDoneProgressBegin,
  WorkDoneProgressCancelParams,
  WorkDoneProgressCreateParams,
  WorkDoneProgressEnd,
  WorkDoneProgressReport
} from "../languageclient"

const WORK_DONE_PROGRESS_KINDS = Object.freeze(['begin', 'report', 'end'])

function isWorkDoneProgress(value: any): value is WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd {
  if (!value || typeof value !== 'object') return false
  if (!('kind' in value)) return false
  if (!WORK_DONE_PROGRESS_KINDS.includes(value.kind)) return false
  return true
}

/**
 * Public: Handles progress reporting on server-initiated tasks. Funnels those
 * tasks to `busy-signal`’s `atom-ide-busy-signal` service.
 */
export default class WorkDoneProgressAdapter {
  // Per-server, deliberately. A `ProgressToken` is chosen by the server, and a
  // server is free to use something as unremarkable as `1`. Were these shared,
  // two servers running at once could collide on a token, and one server's
  // `end` would dispose the other's busy message.
  private _jobs: Map<ProgressToken, BusyMessage> = new Map()
  private _titles: Map<ProgressToken, string> = new Map()

  /**
   * Public: Create an adapter that reports one server's progress to
   * `busy-signal`.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server whose progress should be reported.
   * @param _api The `busy-signal` service to report to.
   */
  constructor(connection: LanguageClientConnection, private _api: BusySignalService) {
    connection.onWorkDoneProgressCreate(
      (params) => this.createWorkDoneProgress(params)
    )

    connection.onProgress(
      (params) => {
        // `$/progress` is used for lots of things, so only some of these will
        // be relevant to us.
        const { token, value } = params
        // Filter out anything that doesn't have a token we recognize…
        if (!this._jobs.has(token)) return
        // …and anything that isn't of a kind we expect. (The above condition
        // would be enough to prove that this is one of ours, but this one
        // makes TypeScript happy.)
        if (!isWorkDoneProgress(value)) return
        switch (value.kind) {
          case 'begin':
            this.beginWorkDoneProgress(token, value)
            break
          case 'report':
            this.updateWorkDoneProgress(token, value)
            break
          case 'end':
            this.endWorkDoneProgress(token, value)
            break
          default:
            // Do nothing
        }
      }
    )
  }


  /**
   * Responds to `window/workDoneProgress/create` by creating a new task in
   * `busy-signal`.
   */
  createWorkDoneProgress(params: WorkDoneProgressCreateParams) {
    // The title isn't specified until the task begins, so we'll use a generic
    // message for the moment.
    //
    // TODO: The `revealTooltip` option doesn't seem to be working, but I'll
    // leave it in for now.
    const message = this._api.reportBusy(`Busy…`, { revealTooltip: true })
    this._jobs.set(params.token, message)
  }

  /**
   * Public: Dispose of this adapter, closing out any progress still in flight.
   *
   * A server that goes away mid-task would otherwise leave its busy message
   * spinning forever, since nothing else will ever send the `end` that would
   * have cleared it.
   */
  public dispose(): void {
    for (const message of this._jobs.values()) {
      message.dispose()
    }
    this._jobs.clear()
    this._titles.clear()
  }

  // Currently unused; will be used if client-initiated cancelling is ever
  // implemented.
  //
  // The spec says that this can always be sent, even for a task that the
  // server says is not cancellable. So it sounds like it always cancels the
  // task in the UI and sometimes cancels the task on the server side.
  cancelWorkDoneProgress(params: WorkDoneProgressCancelParams) {
    const message = this._jobs.get(params.token)
    if (!message) return
    message.dispose()
    this._forget(params.token)
  }

  /**
   * Responds to a `WorkDoneProgressBegin` message sent via `$/progress` by
   * setting the message's title in `busy-signal`. If a percentage is sent, it
   * will be shown in the title.
   */
  beginWorkDoneProgress(token: ProgressToken, params: WorkDoneProgressBegin) {
    const message = this._jobs.get(token)
    if (!message) return
    this._titles.set(token, params.title)
    const newTitle = this.formatMessageFromParams(params.title, params)
    message.setTitle(newTitle)
  }

  /**
   * Responds to a `WorkDoneProgressReport` message sent via `$/progress` by
   * updating the message's title in `busy-signal`. If a percentage is sent, it
   * will be shown in the title.
   */
  updateWorkDoneProgress(token: ProgressToken, params: WorkDoneProgressReport) {
    const message = this._jobs.get(token)
    if (!message) return
    // Since `title` is mandatory in the spec, we are practically guaranteed to
    // find a title here, but we should fall back to an empty string just to
    // make everyone happy.
    const title = this._titles.get(token) ?? ''
    const newTitle = this.formatMessageFromParams(title, params)
    if (newTitle) {
      message.setTitle(newTitle)
    }
  }

  /**
   * Responds to a `WorkDoneProgressReport` message sent via `$/progress` by
   * updating the message's title in `busy-signal` one final time (if
   * applicable), then marking the message as done.
   */
  endWorkDoneProgress(token: ProgressToken, params: WorkDoneProgressEnd) {
    const message = this._jobs.get(token)
    if (!message) return
    // Since `title` is mandatory in the spec, we are practically guaranteed to
    // find a title here, but we should fall back to an empty string just to
    // make everyone happy.
    const title = this._titles.get(token) ?? ''
    const newTitle = this.formatMessageFromParams(title, params)
    if (newTitle) {
      // Optionally set a final title before finishing the operation; otherwise
      // this will keep the original task title and clear the percentage, if
      // any.
      message.setTitle(newTitle)
    }
    message.dispose()
    this._forget(token)
  }

  /** Drop everything we were keeping about a token. */
  private _forget(token: ProgressToken) {
    this._jobs.delete(token)
    this._titles.delete(token)
  }

  // Build a title for a given `busy-signal` task by incorporating (a) the
  // task's original `title` (required), the most recent `message` (optional),
  // and the most recent percentage (optional).
  private formatMessageFromParams(title: string, params: WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd): string {
    const percentage = 'percentage' in params ? params.percentage : undefined
    // Compared against `undefined` rather than tested for truthiness: a task
    // opening at `0` is reporting its progress, not omitting it.
    const hasPercentage = typeof percentage === 'number'
    const { message } = params

    if (!message && !hasPercentage) return title

    // Assembled from the parts that are actually present, so that a
    // percentage with no message doesn't leave a gap where the message
    // would have been.
    const parts: string[] = []
    if (message) parts.push(message)
    if (hasPercentage) parts.push(`(${percentage}%)`)

    return `${title}: ${parts.join(' ')}`
  }

}
