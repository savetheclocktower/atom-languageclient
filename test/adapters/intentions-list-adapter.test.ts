import { Point, Range, TextEditor } from "atom"
import * as linter from "atom/linter"

import IntentionsListAdapter, {
  Intention,
  IntentionsDelegate,
  MessageBundle,
} from "../../lib/adapters/intentions-list-adapter"
import * as ls from "../../lib/languageclient"
import { createSpyConnection } from "../helpers.js"

describe("IntentionsListAdapter", () => {
  const TEST_PATH = "/a/b/c/d.js"

  let connection: ls.LanguageClientConnection
  let editor: TextEditor

  function createDelegate(overrides: Partial<IntentionsDelegate> = {}): IntentionsDelegate {
    return {
      getCodeActions: () => Promise.resolve([]),
      filterCodeActions: (actions) => actions,
      getIntentionsForLinterMessage: () => null,
      ...overrides,
    }
  }

  function lsRange(startLine: number, startChar: number, endLine: number, endChar: number): ls.Range {
    return {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    }
  }

  function createDiagnostic(range: ls.Range, message = "test message"): ls.Diagnostic {
    return { range, message, severity: ls.DiagnosticSeverity.Error }
  }

  function createLinterMessage(position: Range, excerpt = "test message"): linter.Message {
    return {
      severity: "error",
      location: { file: TEST_PATH, position },
      excerpt,
    } as linter.Message
  }

  /** Registers a diagnostic and its linter message against a buffer range. */
  function seed(
    adapter: IntentionsListAdapter,
    forEditor: TextEditor,
    keyRange: Range,
    diagnostic: ls.Diagnostic,
    callback: () => void = () => undefined
  ): MessageBundle {
    const bundle: MessageBundle = {
      message: createLinterMessage(keyRange),
      code: "test-code",
      path: TEST_PATH,
      callback,
    }
    adapter.findOrCreateEditorIntentionsList(forEditor).add(keyRange, bundle, diagnostic)
    return bundle
  }

  beforeEach(() => {
    connection = new ls.LanguageClientConnection(createSpyConnection())
    editor = new TextEditor()
    editor.setText("hello world\nsecond line here\nthird line")
  })

  describe("getIntentions", () => {
    describe("choosing the range to ask for code actions", () => {
      it("uses a zero-width range at the cursor by default", async () => {
        // With no diagnostics and no selection there is nothing to widen to.
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        const [passedEditor, range, diagnostics] = getCodeActions.calls.argsFor(0)
        expect(passedEditor).toBe(editor)
        expect(range).toEqual(new Range([1, 2], [1, 2]))
        expect(diagnostics).toEqual([])
      })

      it("uses the selected range when the editor has a selection", async () => {
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))
        editor.setSelectedBufferRange(new Range([0, 0], [0, 5]))

        await adapter.getIntentions({ bufferPosition: new Point(0, 2), textEditor: editor }, connection)

        expect(getCodeActions.calls.argsFor(0)[1]).toEqual(new Range([0, 0], [0, 5]))
      })

      it("widens the range to cover every diagnostic at that position", async () => {
        // A zero-width range at the cursor would probably work, but a server is
        // more likely to offer the right fixes if it is shown the whole span
        // that the diagnostics cover.
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))

        // Both messages cover the cursor, but their diagnostic spans differ, so
        // the union is wider than either one alone.
        seed(adapter, editor, new Range([1, 0], [1, 4]), createDiagnostic(lsRange(1, 0, 1, 4)))
        seed(adapter, editor, new Range([1, 0], [1, 16]), createDiagnostic(lsRange(1, 8, 1, 16)))

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        expect(getCodeActions.calls.argsFor(0)[1]).toEqual(new Range([1, 0], [1, 16]))
      })

      it("prefers the diagnostic range over the current selection", async () => {
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))
        editor.setSelectedBufferRange(new Range([0, 0], [0, 5]))
        seed(adapter, editor, new Range([1, 0], [1, 16]), createDiagnostic(lsRange(1, 0, 1, 4)))

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        expect(getCodeActions.calls.argsFor(0)[1]).toEqual(new Range([1, 0], [1, 4]))
      })

      it("ignores diagnostics that do not cover the cursor", async () => {
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))
        seed(adapter, editor, new Range([2, 0], [2, 10]), createDiagnostic(lsRange(2, 0, 2, 10)))

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        expect(getCodeActions.calls.argsFor(0)[1]).toEqual(new Range([1, 2], [1, 2]))
        expect(getCodeActions.calls.argsFor(0)[2]).toEqual([])
      })

      it("keeps every diagnostic reported at the same range", async () => {
        // Two rules flagging the same token is routine; both should reach the
        // server so it can offer fixes for each.
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))
        const first = createDiagnostic(lsRange(1, 0, 1, 4), "first problem")
        const second = createDiagnostic(lsRange(1, 0, 1, 4), "second problem")

        seed(adapter, editor, new Range([1, 0], [1, 4]), first)
        seed(adapter, editor, new Range([1, 0], [1, 4]), second)

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        expect(getCodeActions.calls.argsFor(0)[2]).toEqual([first, second])
      })

      it("hands the matching diagnostics to the delegate", async () => {
        // They are gathered in one batch so that they can be converted into
        // code actions together.
        const getCodeActions = jasmine.createSpy("getCodeActions").and.resolveTo([])
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions }))
        const diagnostic = createDiagnostic(lsRange(1, 0, 1, 4))
        seed(adapter, editor, new Range([1, 0], [1, 16]), diagnostic)

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        expect(getCodeActions.calls.argsFor(0)[2]).toEqual([diagnostic])
      })
    })

    describe("converting code actions", () => {
      const editAction: ls.CodeAction = {
        title: "Fix this",
        kind: "quickfix",
        edit: { changes: {} },
      }

      it("turns a code action into an intention", async () => {
        const adapter = new IntentionsListAdapter(
          createDelegate({ getCodeActions: () => Promise.resolve([editAction]) })
        )

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(0, 0), textEditor: editor },
          connection
        )

        expect(intentions.length).toBe(1)
        expect(intentions[0].title).toBe("Fix this")
        expect(intentions[0].icon).toBe("tools")
        expect(intentions[0].priority).toBe(1)
        expect(typeof intentions[0].selected).toBe("function")
      })

      it("ignores bare Commands, which are not code actions", async () => {
        // A server may answer `textDocument/codeAction` with `Command` objects
        // rather than `CodeAction`s; those carry no edit to apply.
        const command = { title: "Run it", command: "doIt", arguments: ["a"] }
        const adapter = new IntentionsListAdapter(
          createDelegate({ getCodeActions: () => Promise.resolve([command as any]) })
        )

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(0, 0), textEditor: editor },
          connection
        )

        expect(intentions).toEqual([])
      })

      it("converts a command action that takes no arguments", async () => {
        // `arguments` is optional in LSP — a command such as
        // `source.organizeImports` needs none — so its absence must not
        // disqualify the action.
        const noArguments: ls.CodeAction = {
          title: "Organize imports",
          kind: "source.organizeImports",
          command: { title: "Organize", command: "organizeImports" },
        }
        const adapter = new IntentionsListAdapter(
          createDelegate({ getCodeActions: () => Promise.resolve([noArguments]) })
        )

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(0, 0), textEditor: editor },
          connection
        )

        expect(intentions.map((i) => i.title)).toEqual(["Organize imports"])
      })

      it("converts a quickfix whose command takes no arguments", async () => {
        // This goes down the edit-action path rather than the command one,
        // where spreading an absent `arguments` used to throw during conversion
        // and reject the whole intentions request.
        const quickfix: ls.CodeAction = {
          title: "Fix without arguments",
          kind: "quickfix",
          command: { title: "Fix", command: "doIt" },
        }
        const adapter = new IntentionsListAdapter(
          createDelegate({ getCodeActions: () => Promise.resolve([quickfix]) })
        )

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(0, 0), textEditor: editor },
          connection
        )

        expect(intentions.map((i) => i.title)).toEqual(["Fix without arguments"])
      })

      it("keeps only the first action of any given title", async () => {
        // Two entries with the same label are indistinguishable in the menu,
        // even if they would do different things.
        const first: ls.CodeAction = { title: "Fix this", kind: "quickfix", edit: { changes: {} } }
        const second: ls.CodeAction = { title: "Fix this", kind: "quickfix", edit: { changes: {} } }
        const third: ls.CodeAction = { title: "Fix that", kind: "quickfix", edit: { changes: {} } }
        const adapter = new IntentionsListAdapter(
          createDelegate({ getCodeActions: () => Promise.resolve([first, second, third]) })
        )

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(0, 0), textEditor: editor },
          connection
        )

        expect(intentions.map((i) => i.title)).toEqual(["Fix this", "Fix that"])
      })

      it("returns an empty list when the delegate declines to answer", async () => {
        const adapter = new IntentionsListAdapter(createDelegate({ getCodeActions: () => Promise.resolve(null) }))

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(0, 0), textEditor: editor },
          connection
        )

        expect(intentions).toEqual([])
      })
    })

    describe("intentions contributed for linter messages", () => {
      const extraIntention: Intention = {
        title: "Ignore this warning",
        priority: 2,
        selected: () => undefined,
      }

      it("appends whatever the delegate offers for messages at that position", async () => {
        // The server may have no code actions here, but the client may still
        // want to offer something of its own.
        const getIntentionsForLinterMessage = jasmine
          .createSpy("getIntentionsForLinterMessage")
          .and.returnValue([extraIntention])
        const adapter = new IntentionsListAdapter(createDelegate({ getIntentionsForLinterMessage }))
        const bundle = seed(adapter, editor, new Range([1, 0], [1, 16]), createDiagnostic(lsRange(1, 0, 1, 4)))

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(1, 2), textEditor: editor },
          connection
        )

        expect(intentions).toEqual([extraIntention])
        expect(getIntentionsForLinterMessage).toHaveBeenCalledTimes(1)
        expect(getIntentionsForLinterMessage.calls.argsFor(0)[0]).toBe(bundle)
        expect(getIntentionsForLinterMessage.calls.argsFor(0)[1]).toBe(editor)
      })

      it("lists them after the server's own code actions", async () => {
        const editAction: ls.CodeAction = { title: "Fix this", kind: "quickfix", edit: { changes: {} } }
        const adapter = new IntentionsListAdapter(
          createDelegate({
            getCodeActions: () => Promise.resolve([editAction]),
            getIntentionsForLinterMessage: () => [extraIntention],
          })
        )
        seed(adapter, editor, new Range([1, 0], [1, 16]), createDiagnostic(lsRange(1, 0, 1, 4)))

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(1, 2), textEditor: editor },
          connection
        )

        expect(intentions.map((i) => i.title)).toEqual(["Fix this", "Ignore this warning"])
      })

      it("tolerates a delegate that offers nothing", async () => {
        const adapter = new IntentionsListAdapter(createDelegate({ getIntentionsForLinterMessage: () => null }))
        seed(adapter, editor, new Range([1, 0], [1, 16]), createDiagnostic(lsRange(1, 0, 1, 4)))

        const intentions = await adapter.getIntentions(
          { bufferPosition: new Point(1, 2), textEditor: editor },
          connection
        )

        expect(intentions).toEqual([])
      })

      it("does not consult the delegate for an editor with no registered messages", async () => {
        const getIntentionsForLinterMessage = jasmine.createSpy("getIntentionsForLinterMessage").and.returnValue([])
        const adapter = new IntentionsListAdapter(createDelegate({ getIntentionsForLinterMessage }))

        await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

        expect(getIntentionsForLinterMessage).not.toHaveBeenCalled()
      })
    })
  })

  describe("onLinterMessageAdded", () => {
    beforeEach(() => {
      atom.workspace.getTextEditors().forEach((ed) => ed.destroy())
    })

    it("registers the message against every open editor for that path", async () => {
      const openEditor = (await atom.workspace.open(TEST_PATH)) as TextEditor
      const getIntentionsForLinterMessage = jasmine
        .createSpy("getIntentionsForLinterMessage")
        .and.returnValue([{ title: "Contributed", priority: 1, selected: () => undefined }])
      const adapter = new IntentionsListAdapter(createDelegate({ getIntentionsForLinterMessage }))

      const callback = jasmine.createSpy("callback")
      const message = createLinterMessage(new Range([0, 0], [0, 10]))
      adapter.onLinterMessageAdded(TEST_PATH, message, "test-code", createDiagnostic(lsRange(0, 0, 0, 10)), callback)

      const intentions = await adapter.getIntentions(
        { bufferPosition: new Point(0, 3), textEditor: openEditor },
        connection
      )

      expect(intentions.map((i) => i.title)).toEqual(["Contributed"])

      const bundle: MessageBundle = getIntentionsForLinterMessage.calls.argsFor(0)[0]
      expect(bundle.message).toBe(message)
      expect(bundle.code).toBe("test-code")
      expect(bundle.path).toBe(TEST_PATH)
      expect(bundle.callback).toBe(callback)
    })

    it("ignores editors open on a different path", async () => {
      const otherEditor = (await atom.workspace.open("/a/b/c/other.js")) as TextEditor
      const getIntentionsForLinterMessage = jasmine.createSpy("getIntentionsForLinterMessage").and.returnValue([])
      const adapter = new IntentionsListAdapter(createDelegate({ getIntentionsForLinterMessage }))

      adapter.onLinterMessageAdded(
        TEST_PATH,
        createLinterMessage(new Range([0, 0], [0, 10])),
        "test-code",
        createDiagnostic(lsRange(0, 0, 0, 10)),
        () => undefined
      )

      await adapter.getIntentions({ bufferPosition: new Point(0, 3), textEditor: otherEditor }, connection)

      expect(getIntentionsForLinterMessage).not.toHaveBeenCalled()
    })
  })

  describe("clearLinterIntentions", () => {
    it("forgets every message registered for that editor", async () => {
      const getIntentionsForLinterMessage = jasmine.createSpy("getIntentionsForLinterMessage").and.returnValue([])
      const adapter = new IntentionsListAdapter(createDelegate({ getIntentionsForLinterMessage }))
      seed(adapter, editor, new Range([1, 0], [1, 16]), createDiagnostic(lsRange(1, 0, 1, 4)))

      adapter.clearLinterIntentions(editor)
      await adapter.getIntentions({ bufferPosition: new Point(1, 2), textEditor: editor }, connection)

      expect(getIntentionsForLinterMessage).not.toHaveBeenCalled()
    })

    it("does nothing for an editor it has never seen", () => {
      const adapter = new IntentionsListAdapter(createDelegate())

      expect(() => adapter.clearLinterIntentions(new TextEditor())).not.toThrow()
    })
  })

  describe("findOrCreateEditorIntentionsList", () => {
    it("reuses the same list for a given editor", () => {
      const adapter = new IntentionsListAdapter(createDelegate())

      const first = adapter.findOrCreateEditorIntentionsList(editor)
      const second = adapter.findOrCreateEditorIntentionsList(editor)

      expect(second).toBe(first)
    })

    it("keeps a separate list per editor", () => {
      const adapter = new IntentionsListAdapter(createDelegate())

      const first = adapter.findOrCreateEditorIntentionsList(editor)
      const second = adapter.findOrCreateEditorIntentionsList(new TextEditor())

      expect(second).not.toBe(first)
    })
  })
})
