import type * as atomIde from "atom-ide-base"
import type * as ls from "../languageclient"
import * as linter from "atom/linter"
import LinterPushV2Adapter from "./linter-push-v2-adapter"
/* eslint-disable import/no-deprecated */
import IdeDiagnosticAdapter from "./diagnostic-adapter"
import assert = require("assert")
import Convert from "../convert"
import CommandExecutionAdapter from "./command-execution-adapter"
import ApplyEditAdapter from "./apply-edit-adapter"
import {
  CodeAction,
  CodeActionParams,
  Command,
  Diagnostic,
  LanguageClientConnection,
  ServerCapabilities,
  WorkspaceEdit,
} from "../languageclient"

import { Range, TextEditor } from "atom"
import type * as intentions from "./intentions-list-adapter"

type LinterMessageParams = linter.Message[] | atomIde.Diagnostic[] | Diagnostic[]
type ActionFilterer = (actions: (Command | CodeAction)[] | null) => (Command | CodeAction)[] | null


export type CodeActionsDelegate = {
  getCodeActions (
    editor: TextEditor,
    range: Range, diagnostics:
    ls.Diagnostic[] | undefined
  ): Promise<(ls.Command | ls.CodeAction)[] | null>,
  filterCodeActions(
    actions: (ls.Command | ls.CodeAction)[] | null
  ): (ls.Command | ls.CodeAction)[] | null
}

export default class CodeActionAdapter {
  /**
   * @returns A boolean indicating this adapter can adapt the server based on
   *   the given serverCapabilities.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return !!serverCapabilities.codeActionProvider
  }

  /**
   * Public: Retrieves atom-ide code actions for a given editor, range, and
   * context (diagnostics). Throws an error if codeActionProvider is not a
   * registered capability.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that provides highlights.
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server that will be used.
   * @param editor The Atom {@link TextEditor} containing the diagnostics.
   * @param range The Atom {@link Range} to fetch code actions for.
   * @param linterMessages An array of linter messages to fetch code actions
   *   for. This is typically a list of messages intersecting `range`.
   *
   * @returns A {@link Promise} resolving with an array of atom-ide
   *   {@link CodeAction}s.
   */

   public static async getCodeActions(
    connection: LanguageClientConnection,
    serverCapabilities: ServerCapabilities,
    linterAdapter: LinterPushV2Adapter | IdeDiagnosticAdapter | undefined,
    editor: TextEditor,
    range: Range,
    linterMessages: Diagnostic[],
    filterActions: ActionFilterer = (actions) => actions,
    onApply: (action: Command | CodeAction) => Promise<boolean> = () => Promise.resolve(true),
    kinds?: string[]
  ): Promise<atomIde.CodeAction[]> {
    let actions = await CodeActionAdapter.getLsCodeActions(
      connection,
      serverCapabilities,
      linterAdapter,
      editor,
      range,
      linterMessages,
      filterActions,
      kinds
    )
    return actions.map((action) => (
      CodeActionAdapter.createCodeAction(action, connection, onApply)
    ))
  }

  /**
   * Public: Retrieves language server code actions for a given editor, range,
   * and context (diagnostics). Throws an error if codeActionProvider is not a
   * registered capability.
   *
   * @param connection A {@link LanguageClientConnection} to the language
   *   server that provides highlights.
   * @param serverCapabilities The {@link ServerCapabilities} of the language
   *   server that will be used.
   * @param editor The Atom {@link TextEditor} containing the diagnostics.
   * @param range The Atom {@link Range} to fetch code actions for.
   * @param linterMessages An {@link Array<linter.Message>} to fetch code
   *   actions for. This is typically a list of messages intersecting `range`.
   *
   * @returns A {@link Promise} that resolves with an array of
   *   {@link ls.CodeAction}s.
   */
  public static async getLsCodeActions(
    connection: LanguageClientConnection,
    serverCapabilities: ServerCapabilities,
    linterAdapter: LinterPushV2Adapter | IdeDiagnosticAdapter | undefined,
    editor: TextEditor,
    range: Range,
    linterMessages: Diagnostic[],
    filterActions: ActionFilterer = (actions) => actions,
    kinds?: string[]
  ): Promise<(Command | CodeAction)[]>  {
    if (linterAdapter == null) return []

    assert(
      serverCapabilities.codeActionProvider,
      "Must have the textDocument/codeAction capability"
    )

    const params = createCodeActionParams(linterAdapter, editor, range, linterMessages, kinds)
    const actions = filterActions(await connection.codeAction(params))
    if (actions === null) return []
    return actions
  }

  private static createCodeAction(
    action: Command | CodeAction,
    connection: LanguageClientConnection,
    onApply: (action: Command | CodeAction) => Promise<boolean>
  ): atomIde.CodeAction {
    return {
      async apply() {
        if (!(await onApply(action))) {
          return
        }
        if (CodeAction.is(action)) {
          CodeActionAdapter.applyWorkspaceEdit(action.edit)
          await CodeActionAdapter.executeCommand(action.command, connection)
        } else {
          await CodeActionAdapter.executeCommand(action, connection)
        }
      },
      getTitle(): Promise<string> {
        return Promise.resolve(action.title)
      },
      dispose(): void {},
    }
  }

  private static applyWorkspaceEdit(edit: WorkspaceEdit | undefined): void {
    if (WorkspaceEdit.is(edit)) {
      ApplyEditAdapter.onApplyEdit({ edit })
    }
  }

  private static async executeCommand(command: any, connection: LanguageClientConnection): Promise<void> {
    if (Command.is(command)) {
      await connection.executeCommand({
        command: command.command,
        arguments: command.arguments,
      })
    }
  }
}

function createCodeActionParams(
  linterAdapter: LinterPushV2Adapter | IdeDiagnosticAdapter,
  editor: TextEditor,
  range: Range,
  linterMessages: LinterMessageParams,
  kinds?: string[]
): CodeActionParams {
  let diagnostics: Diagnostic[]
  if (!linterMessages || linterMessages.length === 0) {
    diagnostics = []
  } else {
    if (areLsDiagnostics(linterMessages)) {
      diagnostics = linterMessages
    } else if (areLinterMessages(linterMessages)) {
      diagnostics = linterAdapter.getLSDiagnosticsForMessages(linterMessages as linter.Message[])
    } else {
      diagnostics = (linterAdapter as IdeDiagnosticAdapter).getLSDiagnosticsForIdeDiagnostics(
        linterMessages as atomIde.Diagnostic[],
        editor
      )
    }
  }

  let context: CodeActionParams['context'] = { diagnostics }
  if (kinds && kinds.length > 0) context.only = kinds

  return {
    textDocument: Convert.editorToTextDocumentIdentifier(editor),
    range: Convert.atomRangeToLSRange(range),
    context
  }
}

function areLsDiagnostics(things: unknown): things is Diagnostic[] {
  if (!Array.isArray(things)) return false
  return things.every(t => Diagnostic.is(t))
}

function areLinterMessages(linterMessages: linter.Message[] | atomIde.Diagnostic[]): boolean {
  if ("excerpt" in linterMessages[0]) {
    return true
  }
  return false
}

export function convertCodeActionToIntentionListOption(
  action: ls.CodeAction,
  connection: LanguageClientConnection
): intentions.Intention | null {
  let callback
  if (isEditAction(action)) {
    callback = editActionToCallback(action)
  } else  {
    callback = commandActionToCallback(action, connection)
  }

  if (!callback) return null
  return {
    title: action.title,
    icon: 'tools',
    selected: callback,
    priority: 1
  }
}

function commandActionToCallback(
  action: ls.CodeAction,
  connection: LanguageClientConnection
): intentions.Intention['selected'] | null {
  let { command: outerCommand } = action
  if (!outerCommand) return null

  let { command, arguments: args } = outerCommand
  if (!command || !args) return null

  return () => {
    CommandExecutionAdapter.executeCommand(connection, command, args)
  }
}

function editActionToCallback(
  action: ls.CodeAction
): intentions.Intention['selected'] | null {
  let { command, edit } = action
  if (!command && !edit) return null

  let edits: ls.WorkspaceEdit[] = []
  if (edit) edits.push(edit)
  if (command) edits.push(
    ...(command.arguments as ls.WorkspaceEdit[])
  )

  return () => {
    let promises = edits.map(e => {
      return ApplyEditAdapter.apply(e)
    })
    return Promise.all(promises)
  }
}

function isEditAction(action: ls.CodeAction): boolean {
  if (action.kind === 'quickfix') return true
  if (action.edit) return true
  return false
}
