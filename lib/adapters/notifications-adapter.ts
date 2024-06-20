import {
  LanguageClientConnection,
  MessageType,
  MessageActionItem,
  ShowMessageParams,
  ShowMessageRequestParams,
} from "../languageclient"
import { Notification, NotificationOptions } from "atom"

export interface NotificationButton {
  text: string
}

// A `NotificationsDelegate` offers a consumer ability to veto the display of a
// particular message. Sometimes a language server is particularly “chatty” and
// ends up annoying a user; sometimes it might make sense for a package to
// filter out single kind of message that doesn't need to be shown.
export interface NotificationsDelegate {
  shouldShowMessage(params: ShowMessageRequestParams, name: string, projectPath: string): boolean
  shouldShowMessageRequest(params: ShowMessageRequestParams, name: string, projectPath: string): boolean
}

/** Public: Adapts Atom's user notifications to those of the language server protocol. */
export default class NotificationsAdapter {
  /** Public: Attach to a {LanguageClientConnection} to recieve events indicating when user notifications should be displayed. */
  public static attach(
    connection: LanguageClientConnection,
    name: string,
    projectPath: string,
    delegate?: NotificationsDelegate
  ): void {
    connection.onShowMessage((m) => NotificationsAdapter.onShowMessage(m, name, projectPath, delegate))
    connection.onShowMessageRequest((m) => NotificationsAdapter.onShowMessageRequest(m, name, projectPath, delegate))
  }

  /**
   * Public: Show a notification message with buttons using the Atom notifications API.
   *
   * @param params The {ShowMessageRequestParams} received from the language server indicating the details of the
   *   notification to be displayed.
   * @param name The name of the language server so the user can identify the context of the message.
   * @param projectPath The path of the current project.
   */
  public static onShowMessageRequest(
    params: ShowMessageRequestParams,
    name: string,
    projectPath: string,
    delegate?: NotificationsDelegate
  ): Promise<MessageActionItem | null> {
    return new Promise((resolve, _reject) => {
      if (delegate) {
        let shouldProceed = delegate.shouldShowMessageRequest(params, name, projectPath)
        if (!shouldProceed) return
      }
      const options: NotificationOptions = {
        dismissable: true,
        detail: `${name} ${projectPath}`,
      }
      if (params.actions) {
        options.buttons = params.actions.map((a) => ({
          text: a.title,
          onDidClick: () => {
            resolve(a)
            if (notification != null) {
              notification.dismiss()
            }
          },
        }))
      }

      const notification = addNotificationForMessage(params.type, params.message, options)

      if (notification != null) {
        notification.onDidDismiss(() => {
          resolve(null)
        })
      }
    })
  }

  /**
   * Public: Show a notification message using the Atom notifications API.
   *
   * @param params The {ShowMessageParams} received from the language server indicating the details of the notification
   *   to be displayed.
   * @param name The name of the language server so the user can identify the context of the message.
   * @param projectPath The path of the current project.
   */
  public static onShowMessage(
    params: ShowMessageParams,
    name: string,
    projectPath: string,
    delegate?: NotificationsDelegate
  ): void {
    if (delegate) {
      let shouldProceed = delegate.shouldShowMessage(params, name, projectPath)
      if (!shouldProceed) return
    }
    addNotificationForMessage(params.type, params.message, {
      dismissable: true,
      detail: `${name} ${projectPath}`,
    })
  }

  /**
   * Public: Convert a {MessageActionItem} from the language server into an equivalent {NotificationButton} within Atom.
   *
   * @param actionItem The {MessageActionItem} to be converted.
   * @returns A {NotificationButton} equivalent to the {MessageActionItem} given.
   */
  public static actionItemToNotificationButton(actionItem: MessageActionItem): NotificationButton {
    return {
      text: actionItem.title,
    }
  }
}

function messageTypeToString(messageType: number): string {
  switch (messageType) {
    case MessageType.Error:
      return "error"
    case MessageType.Warning:
      return "warning"
    default:
      return "info"
  }
}

function addNotificationForMessage(
  messageType: number,
  message: string,
  options: NotificationOptions
): Notification | null {
  function isDuplicate(note: Notification): boolean {
    const noteDismissed = note.isDismissed && note.isDismissed()
    const noteOptions = (note.getOptions && note.getOptions()) || {}
    return (
      !noteDismissed &&
      note.getType() === messageTypeToString(messageType) &&
      note.getMessage() === message &&
      noteOptions.detail === options.detail
    )
  }
  if (atom.notifications.getNotifications().some(isDuplicate)) {
    return null
  }

  switch (messageType) {
    case MessageType.Error:
      return atom.notifications.addError(message, options)
    case MessageType.Warning:
      return atom.notifications.addWarning(message, options)
    case MessageType.Log:
      return null
    case MessageType.Info:
    default:
      return atom.notifications.addInfo(message, options)
  }
}
