import { Range } from "atom"

import CodeActionAdapter from "../../lib/adapters/code-action-adapter"
import IdeDiagnosticAdapter from "../../lib/adapters/diagnostic-adapter"
import LinterPushV2Adapter from "../../lib/adapters/linter-push-v2-adapter"
import Convert from "../../lib/convert"
import * as ls from "../../lib/languageclient"
import { createFakeEditor,createSpyConnection } from "../helpers.js"

describe("CodeActionAdapter", () => {
  describe("canAdapt", () => {
    it("returns true if range formatting is supported", () => {
      const result = CodeActionAdapter.canAdapt({
        codeActionProvider: true,
      })
      expect(result).toBe(true)
    })

    it("returns false it no formatting supported", () => {
      const result = CodeActionAdapter.canAdapt({})
      expect(result).toBe(false)
    })
  })

  describe("getCodeActions", () => {
    const testPath = "/test.txt"
    const testCommand: ls.Command = {
      command: "testCommand",
      title: "Test Command",
      arguments: ["a", "b"],
    }

    let languageClient: ls.LanguageClientConnection

    beforeEach(() => {
      languageClient = new ls.LanguageClientConnection(createSpyConnection())
      spyOn(languageClient, "codeAction").and.returnValue(Promise.resolve([testCommand]))
      spyOn(languageClient, "executeCommand").and.callThrough()
    })

    /**
     * Invokes the adapter and returns both the resulting code actions and the
     * {@link ls.CodeActionParams} that were actually sent to the server.
     */
    async function invoke(
      linterAdapter: LinterPushV2Adapter | IdeDiagnosticAdapter,
      linterMessages: any
    ): Promise<{ params: ls.CodeActionParams; actions: any[] }> {
      const actions = await CodeActionAdapter.getCodeActions(
        languageClient,
        { codeActionProvider: true },
        linterAdapter,
        createFakeEditor(testPath),
        new Range([1, 2], [3, 4]),
        linterMessages,
        (x) => x,
        () => Promise.resolve(true)
      )
      const params: ls.CodeActionParams = (languageClient as any).codeAction.calls.all()[0].args[0]
      return { params, actions }
    }

    it("sends the editor's URI and the requested range", async () => {
      const { params } = await invoke(new IdeDiagnosticAdapter(languageClient), [])

      expect(params.textDocument.uri).toBe(`file://${testPath}`)
      expect(params.range).toEqual({
        start: { line: 1, character: 2 },
        end: { line: 3, character: 4 },
      })
    })

    it("sends an empty diagnostic list when given no messages", async () => {
      const { params } = await invoke(new IdeDiagnosticAdapter(languageClient), [])
      expect(params.context.diagnostics).toEqual([])
    })

    // `createCodeActionParams` accepts three different message shapes and
    // dispatches on them. Each branch gets its own spec below.

    it("passes language server diagnostics through unconverted", async () => {
      const diagnostic: ls.Diagnostic = {
        range: Convert.atomRangeToLSRange(new Range([1, 2], [3, 3])),
        severity: ls.DiagnosticSeverity.Error,
        code: "test code",
        source: "test linter",
        message: "test message",
      }

      const { params } = await invoke(new IdeDiagnosticAdapter(languageClient), [diagnostic])

      expect(params.context.diagnostics).toEqual([diagnostic])
    })

    it("converts atom-ide diagnostics via the IdeDiagnosticAdapter", async () => {
      const linterAdapter = new IdeDiagnosticAdapter(languageClient)
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore private method
      spyOn(linterAdapter, "getDiagnosticCode").and.returnValue("test code")

      const { params } = await invoke(linterAdapter, [
        {
          filePath: testPath,
          type: "Error",
          text: "test message",
          range: new Range([1, 2], [3, 3]),
          providerName: "test linter",
        },
      ])

      expect(params.context.diagnostics).toEqual([
        {
          range: {
            start: { line: 1, character: 2 },
            end: { line: 3, character: 3 },
          },
          severity: ls.DiagnosticSeverity.Error,
          code: "test code",
          source: "test linter",
          message: "test message",
        },
      ])
    })

    it("resolves Linter v2 messages through the linter adapter", async () => {
      const linterAdapter = new LinterPushV2Adapter(languageClient)
      const converted: ls.Diagnostic[] = [
        {
          range: Convert.atomRangeToLSRange(new Range([1, 2], [3, 3])),
          severity: ls.DiagnosticSeverity.Error,
          message: "test message",
        },
      ]
      // The lookup itself is the linter adapter's concern and is covered by its
      // own specs; here we only assert that `CodeActionAdapter` routes to it.
      const lookup = spyOn(linterAdapter, "getLSDiagnosticsForMessages").and.returnValue(converted)

      const messages = [
        {
          location: { file: testPath, position: new Range([1, 2], [3, 3]) },
          excerpt: "test message",
          severity: "error",
        },
      ]
      const { params } = await invoke(linterAdapter, messages)

      expect(lookup).toHaveBeenCalledWith(messages as any)
      expect(params.context.diagnostics).toEqual(converted)
    })

    it("returns code actions that execute their command when applied", async () => {
      const { actions } = await invoke(new IdeDiagnosticAdapter(languageClient), [])

      expect(actions.length).toBe(1)
      expect(await actions[0].getTitle()).toBe("Test Command")

      await actions[0].apply()
      expect((languageClient as any).executeCommand).toHaveBeenCalled()
      expect((languageClient as any).executeCommand.calls.all()[0].args).toEqual([
        {
          command: "testCommand",
          arguments: ["a", "b"],
        },
      ])
    })
  })
})
