import {
  LanguageClientConnection,
  ProgressToken,
  WorkDoneProgressBegin,
  WorkDoneProgressCancelParams,
  WorkDoneProgressCreateParams,
  WorkDoneProgressEnd,
  WorkDoneProgressReport
} from "../languageclient"
import { BusyMessage, BusySignalService } from "atom-ide"

const WORK_DONE_PROGRESS_KINDS = Object.freeze(['begin', 'report', 'end'])

function isWorkDoneProgress(value: any): value is WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd {
  if (!value || typeof value !== 'object') return false
  if (!('kind' in value)) return false
  if (!WORK_DONE_PROGRESS_KINDS.includes(value.kind)) return false
  return true
}

/**
 * Public: Handles progress reporting on server-initiated tasks. Funnels those tasks to
 * `busy-signal`’s `atom-ide-busy-signal` service.
 */
export default class WorkDoneProgressAdapter {
  static JOBS: Map<ProgressToken, BusyMessage> = new Map()
  static TITLES: Map<ProgressToken, string> = new Map()

  public static attach(connection: LanguageClientConnection, api: BusySignalService) {
    connection.onWorkDoneProgressCreate(
      (params) => this.createWorkDoneProgress(params, api)
    )

    connection.onProgress(
      (params) => {
        // `$/progress` is used for lots of things, so only some of these will
        // be relevant to us.
        let { token, value } = params
        // Filter out anything that doesn't have a token we recognize…
        if (!this.JOBS.has(token)) return
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
        }
      }
    )
  }


  /**
   * Responds to `window/workDoneProgress/create` by creating a new task in
   * `busy-signal`.
   */
  static createWorkDoneProgress(params: WorkDoneProgressCreateParams, api: BusySignalService) {
    // The title isn't specified until the task begins, so we'll use a generic
    // message for the moment.
    //
    // TODO: The `revealTooltip` option doesn't seem to be working, but I'll
    // leave it in for now.
    let message = api.reportBusy(`Busy…`, { revealTooltip: true })
    this.JOBS.set(params.token, message)
  }

  // Currently unused; will be used if client-initiated cancelling is ever
  // implemented.
  //
  // The spec says that this can always be sent, even for a task that the
  // server says is not cancellable. So it sounds like it always cancels the
  // task in the UI and sometimes cancels the task on the server side.
  static cancelWorkDoneProgress(params: WorkDoneProgressCancelParams) {
    let message = this.JOBS.get(params.token)
    if (!message) return
    message.dispose()
    this.JOBS.delete(params.token)
  }

  /**
   * Responds to a `WorkDoneProgressBegin` message sent via `$/progress` by
   * setting the message's title in `busy-signal`. If a percentage is sent, it
   * will be shown in the title.
   */
  static beginWorkDoneProgress(token: ProgressToken, params: WorkDoneProgressBegin) {
    let message = this.JOBS.get(token)
    if (!message) return
    this.TITLES.set(token, params.title)
    let newTitle = this.formatMessageFromParams(params.title, params)
    message.setTitle(newTitle)
  }

  /**
   * Responds to a `WorkDoneProgressReport` message sent via `$/progress` by
   * updating the message's title in `busy-signal`. If a percentage is sent, it
   * will be shown in the title.
   */
  static updateWorkDoneProgress(token: ProgressToken, params: WorkDoneProgressReport) {
    let message = this.JOBS.get(token)
    if (!message) return
    // Since `title` is mandatory in the spec, we are practically guaranteed to
    // find a title here, but we should fall back to an empty string just to
    // make everyone happy.
    let title = this.TITLES.get(token) ?? ''
    let newTitle = this.formatMessageFromParams(title, params)
    if (newTitle) {
      message.setTitle(newTitle)
    }
  }

  /**
   * Responds to a `WorkDoneProgressReport` message sent via `$/progress` by
   * updating the message's title in `busy-signal` one final time (if
   * applicable), then marking the message as done.
   */
  static endWorkDoneProgress(token: ProgressToken, params: WorkDoneProgressEnd) {
    let message = this.JOBS.get(token)
    if (!message) return
    // Since `title` is mandatory in the spec, we are practically guaranteed to
    // find a title here, but we should fall back to an empty string just to
    // make everyone happy.
    let title = this.TITLES.get(token) ?? ''
    let newTitle = this.formatMessageFromParams(title, params)
    if (newTitle) {
      // Optionally set a final title before finishing the operation; otherwise
      // this will keep the original task title and clear the percentage, if
      // any.
      message.setTitle(newTitle)
    }
    message.dispose()
    this.JOBS.delete(token)
  }

  // Build a title for a given `busy-signal` task by incorporating (a) the
  // task's original `title` (required), the most recent `message` (optional),
  // and the most recent percentage (optional).
  private static formatMessageFromParams(title: string, params: WorkDoneProgressBegin | WorkDoneProgressReport | WorkDoneProgressEnd): string {
    let percentage = 'percentage' in params ? params.percentage : null
    if (!params.message && !percentage) return title
    let message = params.message ?? ``
    if (percentage) {
      message = `${message} (${percentage}%)`
    }
    return `${title}: ${message}`
  }

}
