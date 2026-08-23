import { CompositeDisposable, Point, Range, TextEditor } from "atom"

import IntentionsListAdapter from "../../lib/adapters/intentions-list-adapter"
import LinterPullAdapter from "../../lib/adapters/linter-pull-adapter"
import * as ls from "../../lib/languageclient"
import { ActiveServer } from "../../lib/server-manager"
import { createFakeEditor, createSpyConnection } from "../helpers.js"

describe("LinterPullAdapter", () => {
  const TEST_PATH = "/a/b/c/d.js"

  let server: ActiveServer
  let editor: TextEditor

  function createServer(): ActiveServer {
    return {
      capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },
      connection: new ls.LanguageClientConnection(createSpyConnection()),
      disposable: new CompositeDisposable(),
      process: undefined as any,
      projectPath: "/",
    }
  }

  function lsRange(startLine: number, startChar: number, endLine: number, endChar: number): ls.Range {
    return {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    }
  }

  function createDiagnostic(range: ls.Range, message = "test message", code?: string | number): ls.Diagnostic {
    return { range, message, severity: ls.DiagnosticSeverity.Error, source: "test linter", code }
  }

  /** A full document diagnostic report, as returned by `textDocument/diagnostic`. */
  function fullReport(items: ls.Diagnostic[], resultId?: string): any {
    return { kind: ls.DocumentDiagnosticReportKind.Full, items, resultId }
  }

  function unchangedReport(resultId: string): any {
    return { kind: ls.DocumentDiagnosticReportKind.Unchanged, resultId }
  }

  /** Stubs the server's `textDocument/diagnostic` responses, in order. */
  function stubDiagnostics(...reports: any[]): jasmine.Spy {
    const spy = spyOn(server.connection, "diagnostic")
    spy.and.returnValues(...reports.map((report) => Promise.resolve(report)))
    return spy
  }

  function createIntentionsSpy() {
    return {
      onLinterMessageAdded: jasmine.createSpy("onLinterMessageAdded"),
      clearLinterIntentions: jasmine.createSpy("clearLinterIntentions"),
    } as unknown as IntentionsListAdapter
  }

  beforeEach(() => {
    server = createServer()
    editor = createFakeEditor(TEST_PATH)
  })

  describe("lint", () => {
    it("asks the server for diagnostics for the editor's document", async () => {
      const spy = stubDiagnostics(fullReport([]))
      const adapter = new LinterPullAdapter({})

      await adapter.lint(server, editor)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.calls.argsFor(0)[0].textDocument.uri).toBe(`file://${TEST_PATH}`)
    })

    it("does not send a previousResultId on the first pass", async () => {
      const spy = stubDiagnostics(fullReport([]))
      const adapter = new LinterPullAdapter({})

      await adapter.lint(server, editor)

      expect(spy.calls.argsFor(0)[0].previousResultId).toBeUndefined()
    })

    it("sends the previous resultId once the server has supplied one", async () => {
      const spy = stubDiagnostics(fullReport([], "result-1"), fullReport([], "result-2"))
      const adapter = new LinterPullAdapter({})

      await adapter.lint(server, editor)
      await adapter.lint(server, editor)

      expect(spy.calls.argsFor(1)[0].previousResultId).toBe("result-1")
    })

    it("returns null when the server answers with nothing", async () => {
      stubDiagnostics(null)
      const adapter = new LinterPullAdapter({})

      expect(await adapter.lint(server, editor)).toBeNull()
    })

    it("converts diagnostics into linter messages", async () => {
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 2, 1, 8), "something is wrong")]))
      const adapter = new LinterPullAdapter({})

      const messages = await adapter.lint(server, editor)

      expect(messages!.length).toBe(1)
      expect(messages![0].excerpt).toBe("something is wrong")
      expect(messages![0].severity).toBe("error")
      expect(messages![0].linterName).toBe("test linter")
      expect(messages![0].location.file).toBe(TEST_PATH)
      expect(messages![0].location.position).toEqual(new Range([1, 2], [1, 8]))
    })

    describe("when the server reports the document as unchanged", () => {
      it("reuses the messages from the last full report", async () => {
        stubDiagnostics(
          fullReport([createDiagnostic(lsRange(1, 2, 1, 8), "still wrong")], "result-1"),
          unchangedReport("result-1")
        )
        const adapter = new LinterPullAdapter({})

        await adapter.lint(server, editor)
        const messages = await adapter.lint(server, editor)

        expect(messages!.length).toBe(1)
        expect(messages![0].excerpt).toBe("still wrong")
      })

      it("returns null when there is no earlier report to reuse", async () => {
        stubDiagnostics(unchangedReport("result-1"))
        const adapter = new LinterPullAdapter({})

        expect(await adapter.lint(server, editor)).toBeNull()
      })
    })
  })

  describe("intentions", () => {
    it("registers each message with the intentions adapter", async () => {
      const intentions = createIntentionsSpy()
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 2, 1, 8), "wrong", "E123")]))
      const adapter = new LinterPullAdapter({ intentionsManager: intentions })

      const messages = await adapter.lint(server, editor)

      const spy = intentions.onLinterMessageAdded as unknown as jasmine.Spy
      expect(spy).toHaveBeenCalledTimes(1)
      const [path, message, code] = spy.calls.argsFor(0)
      expect(path).toBe(TEST_PATH)
      expect(message).toBe(messages![0])
      expect(code).toBe("E123")
    })

    it("registers a codeless diagnostic with a null code", async () => {
      // `code` is optional in LSP. Registration must still happen, because it
      // is what files the diagnostic as context for the code-action request —
      // not merely what feeds `getIntentionsForLinterMessage`.
      const intentions = createIntentionsSpy()
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 2, 1, 8), "no code here")]))
      const adapter = new LinterPullAdapter({ intentionsManager: intentions })

      await adapter.lint(server, editor)

      const spy = intentions.onLinterMessageAdded as unknown as jasmine.Spy
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.calls.argsFor(0)[2]).toBeNull()
    })

    it("stringifies a numeric diagnostic code", async () => {
      const intentions = createIntentionsSpy()
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 2, 1, 8), "numeric", 2304)]))
      const adapter = new LinterPullAdapter({ intentionsManager: intentions })

      await adapter.lint(server, editor)

      const spy = intentions.onLinterMessageAdded as unknown as jasmine.Spy
      expect(spy.calls.argsFor(0)[2]).toBe("2304")
    })

    it("clears the previous pass's intentions before registering new ones", async () => {
      // Otherwise the same fix is filed against the same range on every lint
      // and appears in the menu once per pass.
      const order: string[] = []
      const intentions = {
        clearLinterIntentions: jasmine.createSpy("clearLinterIntentions").and.callFake(() => {
          order.push("clear")
        }),
        onLinterMessageAdded: jasmine.createSpy("onLinterMessageAdded").and.callFake(() => {
          order.push("add")
        }),
      } as unknown as IntentionsListAdapter

      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 2, 1, 8)), createDiagnostic(lsRange(2, 2, 2, 8))]))
      const adapter = new LinterPullAdapter({ intentionsManager: intentions })

      await adapter.lint(server, editor)

      expect(order).toEqual(["clear", "add", "add"])
      expect(intentions.clearLinterIntentions).toHaveBeenCalledWith(editor)
    })

    it("does not accumulate duplicate intentions across lint passes", async () => {
      // Exercised against a real `IntentionsListAdapter` so that the check is on
      // what actually reaches the menu, not just the calls made.
      atom.workspace.getTextEditors().forEach((ed) => ed.destroy())
      const openEditor = (await atom.workspace.open(TEST_PATH)) as TextEditor

      const contributed = { title: "Fix it", priority: 1, selected: () => undefined }
      const intentions = new IntentionsListAdapter({
        getCodeActions: () => Promise.resolve([]),
        filterCodeActions: (actions) => actions,
        getIntentionsForLinterMessage: () => [contributed],
      })
      stubDiagnostics(
        fullReport([createDiagnostic(lsRange(0, 0, 0, 5))]),
        fullReport([createDiagnostic(lsRange(0, 0, 0, 5))])
      )
      const adapter = new LinterPullAdapter({ intentionsManager: intentions })

      await adapter.lint(server, openEditor)
      await adapter.lint(server, openEditor)

      const results = await intentions.getIntentions(
        { bufferPosition: new Point(0, 2), textEditor: openEditor },
        server.connection
      )

      expect(results.length).toBe(1)
    })

    it("supplies a callback that re-lints the editor", async () => {
      const intentions = createIntentionsSpy()
      const spy = stubDiagnostics(
        fullReport([createDiagnostic(lsRange(1, 2, 1, 8))]),
        fullReport([createDiagnostic(lsRange(1, 2, 1, 8))])
      )
      const adapter = new LinterPullAdapter({ intentionsManager: intentions })

      await adapter.lint(server, editor)

      const callback = (intentions.onLinterMessageAdded as unknown as jasmine.Spy).calls.argsFor(0)[4]
      await callback()

      expect(spy).toHaveBeenCalledTimes(2)
    })
  })

  describe("the message delegate", () => {
    it("omits messages the delegate wants ignored", async () => {
      stubDiagnostics(
        fullReport([
          createDiagnostic(lsRange(1, 0, 1, 4), "keep me"),
          createDiagnostic(lsRange(2, 0, 2, 4), "ignore me"),
        ])
      )
      const adapter = new LinterPullAdapter({
        delegate: {
          shouldIgnoreLinterMessage: (diag) => diag.message === "ignore me",
          transformLinterMessage: (message) => message,
          getLinterMessageLimitForBuffer: () => Infinity,
        },
      })

      const messages = await adapter.lint(server, editor)

      expect(messages!.map((m) => m.excerpt)).toEqual(["keep me"])
    })

    it("passes the converted range to shouldIgnoreLinterMessage", async () => {
      const shouldIgnoreLinterMessage = jasmine.createSpy("shouldIgnoreLinterMessage").and.returnValue(false)
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 2, 1, 8))]))
      const adapter = new LinterPullAdapter({
        delegate: {
          shouldIgnoreLinterMessage,
          transformLinterMessage: (message) => message,
          getLinterMessageLimitForBuffer: () => Infinity,
        },
      })

      await adapter.lint(server, editor)

      const [, passedEditor, range] = shouldIgnoreLinterMessage.calls.argsFor(0)
      expect(passedEditor).toBe(editor)
      expect(range).toEqual(new Range([1, 2], [1, 8]))
    })

    it("uses a replacement message returned by the delegate", async () => {
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 0, 1, 4), "original")]))
      const adapter = new LinterPullAdapter({
        delegate: {
          shouldIgnoreLinterMessage: () => false,
          transformLinterMessage: (message) => ({ ...message, excerpt: "replaced" }),
          getLinterMessageLimitForBuffer: () => Infinity,
        },
      })

      const messages = await adapter.lint(server, editor)

      expect(messages![0].excerpt).toBe("replaced")
    })

    it("keeps the original message when the delegate mutates in place", async () => {
      // The contract allows returning nothing and editing the message directly.
      stubDiagnostics(fullReport([createDiagnostic(lsRange(1, 0, 1, 4), "original")]))
      const adapter = new LinterPullAdapter({
        delegate: {
          shouldIgnoreLinterMessage: () => false,
          transformLinterMessage: (message) => {
            message.excerpt = "mutated"
          },
          getLinterMessageLimitForBuffer: () => Infinity,
        },
      })

      const messages = await adapter.lint(server, editor)

      expect(messages!.length).toBe(1)
      expect(messages![0].excerpt).toBe("mutated")
    })

    it("stops at the message limit the delegate reports", async () => {
      stubDiagnostics(
        fullReport([
          createDiagnostic(lsRange(1, 0, 1, 4), "first"),
          createDiagnostic(lsRange(2, 0, 2, 4), "second"),
          createDiagnostic(lsRange(3, 0, 3, 4), "third"),
        ])
      )
      const adapter = new LinterPullAdapter({
        delegate: {
          shouldIgnoreLinterMessage: () => false,
          transformLinterMessage: (message) => message,
          getLinterMessageLimitForBuffer: () => 2,
        },
      })

      const messages = await adapter.lint(server, editor)

      expect(messages!.map((m) => m.excerpt)).toEqual(["first", "second"])
    })

    it("imposes no limit when there is no delegate", async () => {
      stubDiagnostics(
        fullReport([createDiagnostic(lsRange(1, 0, 1, 4)), createDiagnostic(lsRange(2, 0, 2, 4))])
      )
      const adapter = new LinterPullAdapter({})

      expect((await adapter.lint(server, editor))!.length).toBe(2)
    })
  })

  describe("relint", () => {
    it("returns null for an editor that has never been linted", async () => {
      const adapter = new LinterPullAdapter({})

      expect(await adapter.relint(editor)).toBeNull()
    })

    it("re-runs diagnostics against the server that last served the editor", async () => {
      const spy = stubDiagnostics(fullReport([]), fullReport([createDiagnostic(lsRange(1, 0, 1, 4), "new")]))
      const adapter = new LinterPullAdapter({})

      await adapter.lint(server, editor)
      const messages = await adapter.relint(editor)

      expect(spy).toHaveBeenCalledTimes(2)
      expect(messages!.map((m) => m.excerpt)).toEqual(["new"])
    })
  })

  describe("getDiagnosticsForEditorAtPosition", () => {
    beforeEach(async () => {
      stubDiagnostics(
        fullReport([
          createDiagnostic(lsRange(1, 0, 1, 10), "first"),
          createDiagnostic(lsRange(3, 0, 3, 10), "second"),
        ])
      )
    })

    it("returns the diagnostics whose range contains the point", async () => {
      const adapter = new LinterPullAdapter({})
      await adapter.lint(server, editor)

      const found = adapter.getDiagnosticsForEditorAtPosition(editor, new Point(1, 5))

      expect(found.map((d) => d.message)).toEqual(["first"])
    })

    it("returns the diagnostics a range fully encloses", async () => {
      const adapter = new LinterPullAdapter({})
      await adapter.lint(server, editor)

      const found = adapter.getDiagnosticsForEditorAtPosition(editor, new Range([0, 0], [2, 0]))

      expect(found.map((d) => d.message)).toEqual(["first"])
    })

    it("returns nothing for an editor that was never linted", () => {
      const adapter = new LinterPullAdapter({})

      expect(adapter.getDiagnosticsForEditorAtPosition(editor, new Point(1, 5))).toEqual([])
    })
  })

  describe("getMessagesForEditorAtPosition", () => {
    beforeEach(() => {
      stubDiagnostics(
        fullReport([
          createDiagnostic(lsRange(1, 0, 1, 10), "first"),
          createDiagnostic(lsRange(3, 0, 3, 10), "second"),
        ])
      )
    })

    it("returns the messages whose range contains the point", async () => {
      const adapter = new LinterPullAdapter({})
      await adapter.lint(server, editor)

      const found = adapter.getMessagesForEditorAtPosition(editor, new Point(3, 5))

      expect(found.map((m) => m.excerpt)).toEqual(["second"])
    })

    it("returns the messages a range fully encloses", async () => {
      const adapter = new LinterPullAdapter({})
      await adapter.lint(server, editor)

      const found = adapter.getMessagesForEditorAtPosition(editor, new Range([2, 0], [4, 0]))

      expect(found.map((m) => m.excerpt)).toEqual(["second"])
    })

    it("returns nothing for an editor that was never linted", () => {
      const adapter = new LinterPullAdapter({})

      expect(adapter.getMessagesForEditorAtPosition(editor, new Point(1, 5))).toEqual([])
    })
  })
})
