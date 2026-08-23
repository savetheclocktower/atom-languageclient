import { CompositeDisposable, Point, Range } from "atom"

import SymbolAdapter, { SymbolDelegate, SymbolEntry, SymbolMeta } from "../../lib/adapters/symbol-adapter"
import * as ls from "../../lib/languageclient"
import { ActiveServer } from "../../lib/server-manager"
import { createFakeEditor, createSpyConnection } from "../helpers.js"

describe("SymbolAdapter", () => {
  const TEST_PATH = "/a/b/c/d.js"

  function createServer(capabilities: ls.ServerCapabilities = {}): ActiveServer {
    return {
      capabilities,
      connection: new ls.LanguageClientConnection(createSpyConnection()),
      disposable: new CompositeDisposable(),
      process: undefined as any,
      projectPath: "/",
    }
  }

  function createMeta(overrides: Partial<SymbolMeta> = {}): SymbolMeta {
    return {
      type: "file",
      editor: createFakeEditor(TEST_PATH),
      ...overrides,
    }
  }

  /** Shorthand for a language-server range. */
  function lsRange(startLine: number, startChar: number, endLine: number, endChar: number): ls.Range {
    return {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    }
  }

  let adapter: SymbolAdapter

  beforeEach(() => {
    adapter = new SymbolAdapter()
  })

  describe("canProvideSymbols", () => {
    it("declines when there is no server", async () => {
      expect(await adapter.canProvideSymbols(null, createMeta())).toBe(false)
    })

    describe("for a file search", () => {
      const meta = () => createMeta({ type: "file" })

      it("accepts when the server provides document symbols", async () => {
        const server = createServer({ documentSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(true)
      })

      it("declines when the server does not", async () => {
        // A workspace symbol provider is no help for a single-file search.
        const server = createServer({ workspaceSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(false)
      })
    })

    describe("for a project search", () => {
      const meta = () => createMeta({ type: "project" })

      it("accepts when the server provides workspace symbols", async () => {
        const server = createServer({ workspaceSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(true)
      })

      it("declines when the server does not", async () => {
        const server = createServer({ documentSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(false)
      })
    })

    describe("for a project-find search", () => {
      const meta = () => createMeta({ type: "project-find" })

      it("scores a full 1 when the server can resolve a definition", async () => {
        const server = createServer({ definitionProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(1)
      })

      it("scores slightly lower when it can only fall back to workspace symbols", async () => {
        // The service contract invites providers to return a lower score when
        // they are a workable but non-ideal candidate for the task.
        const server = createServer({ workspaceSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(0.95)
      })

      it("prefers the definition provider when the server offers both", async () => {
        const server = createServer({ definitionProvider: true, workspaceSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(1)
      })

      it("ignores referencesProvider, which gates a different request", async () => {
        // `project-find` is answered with `textDocument/definition`. A server
        // that can list references but cannot resolve a definition is no help,
        // and claiming otherwise gets it asked for a method it never
        // advertised.
        const server = createServer({ referencesProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(false)
      })

      it("declines when the server can do neither", async () => {
        const server = createServer({ documentSymbolProvider: true })
        expect(await adapter.canProvideSymbols(server, meta())).toBe(false)
      })
    })
  })

  describe("createSymbols", () => {
    let editor: ReturnType<typeof createFakeEditor>
    let meta: SymbolMeta

    beforeEach(() => {
      editor = createFakeEditor(TEST_PATH)
      meta = createMeta({ editor })
    })

    describe("from DocumentSymbols", () => {
      const method: ls.DocumentSymbol = {
        name: "myMethod",
        kind: ls.SymbolKind.Method,
        range: lsRange(2, 2, 4, 3),
        selectionRange: lsRange(2, 8, 2, 16),
      }

      const klass: ls.DocumentSymbol = {
        name: "MyClass",
        kind: ls.SymbolKind.Class,
        range: lsRange(0, 0, 10, 1),
        selectionRange: lsRange(0, 6, 0, 13),
        children: [method],
      }

      it("uses the selectionRange for both position and range", () => {
        // `range` spans the symbol's whole body; `selectionRange` covers just
        // the name token, which is what should be highlighted on selection.
        const [symbol] = adapter.createSymbols([klass], editor, meta)

        expect(symbol.name).toBe("MyClass")
        expect(symbol.position).toEqual(new Point(0, 6))
        expect(symbol.range).toEqual(new Range([0, 6], [0, 13]))
      })

      it("flattens children into the returned list", () => {
        // `symbols-view` expects a flat list, not a tree.
        const symbols = adapter.createSymbols([klass], editor, meta)

        expect(symbols.map((s) => s.name)).toEqual(["MyClass", "myMethod"])
      })

      it("does not attach a path, since the symbols are from the current file", () => {
        const [symbol] = adapter.createSymbols([klass], editor, meta)

        expect((symbol as any).path).toBeUndefined()
      })
    })

    describe("from SymbolInformation", () => {
      const symbolInformation: ls.SymbolInformation = {
        name: "doThing",
        kind: ls.SymbolKind.Function,
        location: { uri: "file:///project/src/thing.ts", range: lsRange(4, 2, 4, 9) },
        containerName: "ThingModule",
      }

      it("converts the location's uri into a path", () => {
        const [symbol] = adapter.createSymbols([symbolInformation], editor, meta)

        expect(symbol.name).toBe("doThing")
        expect((symbol as any).path).toBe("/project/src/thing.ts")
        expect(symbol.position).toEqual(new Point(4, 2))
        expect(symbol.range).toEqual(new Range([4, 2], [4, 9]))
      })

      it("exposes containerName as the symbol's context", () => {
        const [symbol] = adapter.createSymbols([symbolInformation], editor, meta)

        expect(symbol.context).toBe("ThingModule")
      })

      it("skips symbols whose location carries no range", () => {
        // An unresolved `WorkspaceSymbol` may supply only a `uri`, deferring the
        // range until `workspaceSymbol/resolve`. There is nothing to point at.
        const unresolved = {
          name: "unresolved",
          kind: ls.SymbolKind.Function,
          location: { uri: "file:///project/src/thing.ts" },
        }

        expect(adapter.createSymbols([unresolved as any], editor, meta)).toEqual([])
      })
    })

    describe("from Locations", () => {
      const location: ls.Location = {
        uri: "file:///project/src/other.ts",
        range: lsRange(1, 0, 1, 5),
      }

      it("names the symbol after the supplied query", () => {
        // A bare `Location` carries no name of its own, so go-to-definition
        // results are labelled with the term the user was resolving.
        const [symbol] = adapter.createSymbols([location], editor, meta, "myQuery")

        expect(symbol.name).toBe("myQuery")
        expect((symbol as any).path).toBe("/project/src/other.ts")
        expect(symbol.position).toEqual(new Point(1, 0))
      })

      it("falls back to a generic name when no query is supplied", () => {
        const [symbol] = adapter.createSymbols([location], editor, meta)

        expect(symbol.name).toBe("Location")
      })

      it("accepts a single Location that is not wrapped in a list", () => {
        // `textDocument/definition` and `textDocument/declaration` may answer
        // with one `Location` rather than an array. Only `Location` has a
        // singular form — `LocationLink` is always sent as an array.
        const symbols = adapter.createSymbols(location, editor, meta, "myQuery")

        expect(symbols.length).toBe(1)
        expect(symbols[0].name).toBe("myQuery")
        expect(symbols[0].position).toEqual(new Point(1, 0))
      })
    })

    describe("from LocationLinks", () => {
      const locationLink: ls.LocationLink = {
        targetUri: "file:///project/src/target.ts",
        targetRange: lsRange(7, 0, 9, 1),
        targetSelectionRange: lsRange(7, 6, 7, 12),
      }

      it("uses the full targetRange rather than the selection range", () => {
        const [symbol] = adapter.createSymbols([locationLink], editor, meta, "myQuery")

        expect(symbol.name).toBe("myQuery")
        expect((symbol as any).path).toBe("/project/src/target.ts")
        expect(symbol.position).toEqual(new Point(7, 0))
        expect(symbol.range).toEqual(new Range([7, 0], [9, 1]))
      })
    })

    describe("tags", () => {
      function tagFor(kind: ls.SymbolKind): string | null | undefined {
        const symbol: ls.DocumentSymbol = {
          name: "thing",
          kind,
          range: lsRange(0, 0, 0, 5),
          selectionRange: lsRange(0, 0, 0, 5),
        }
        return adapter.createSymbols([symbol], editor, meta)[0].tag
      }

      it("maps a symbol kind to a human-readable tag", () => {
        expect(tagFor(ls.SymbolKind.Class)).toBe("class")
        expect(tagFor(ls.SymbolKind.Method)).toBe("method")
        expect(tagFor(ls.SymbolKind.Variable)).toBe("variable")
      })

      it("folds kinds without a distinct tag into the closest equivalent", () => {
        expect(tagFor(ls.SymbolKind.Struct)).toBe("class")
        expect(tagFor(ls.SymbolKind.EnumMember)).toBe("constant")
      })

      it("returns null for a kind it has no tag for", () => {
        expect(tagFor(ls.SymbolKind.Event)).toBeNull()
      })
    })

    it("sorts symbols by buffer position", () => {
      const later: ls.DocumentSymbol = {
        name: "later",
        kind: ls.SymbolKind.Function,
        range: lsRange(9, 0, 9, 5),
        selectionRange: lsRange(9, 0, 9, 5),
      }
      const earlier: ls.DocumentSymbol = {
        name: "earlier",
        kind: ls.SymbolKind.Function,
        range: lsRange(1, 0, 1, 7),
        selectionRange: lsRange(1, 0, 1, 7),
      }
      const sameRowLaterColumn: ls.DocumentSymbol = {
        name: "sameRow",
        kind: ls.SymbolKind.Function,
        range: lsRange(1, 4, 1, 11),
        selectionRange: lsRange(1, 4, 1, 11),
      }

      const symbols = adapter.createSymbols([later, sameRowLaterColumn, earlier], editor, meta)

      expect(symbols.map((s) => s.name)).toEqual(["earlier", "sameRow", "later"])
    })

    describe("when a delegate is supplied", () => {
      it("omits symbols the delegate rejects", () => {
        const delegate: SymbolDelegate = {
          shouldIgnoreSymbol: (symbol: SymbolEntry) => symbol.name === "hidden",
        }
        const delegatingAdapter = new SymbolAdapter(undefined, delegate)

        const symbols = delegatingAdapter.createSymbols(
          [
            {
              name: "hidden",
              kind: ls.SymbolKind.Function,
              range: lsRange(0, 0, 0, 6),
              selectionRange: lsRange(0, 0, 0, 6),
            },
            {
              name: "shown",
              kind: ls.SymbolKind.Function,
              range: lsRange(1, 0, 1, 5),
              selectionRange: lsRange(1, 0, 1, 5),
            },
          ],
          editor,
          meta
        )

        expect(symbols.map((s) => s.name)).toEqual(["shown"])
      })

      it("passes the editor and request metadata to the delegate", () => {
        const delegate: SymbolDelegate = { shouldIgnoreSymbol: () => false }
        const spy = spyOn(delegate, "shouldIgnoreSymbol").and.returnValue(false)
        const delegatingAdapter = new SymbolAdapter(undefined, delegate)

        delegatingAdapter.createSymbols(
          [
            {
              name: "thing",
              kind: ls.SymbolKind.Function,
              range: lsRange(0, 0, 0, 5),
              selectionRange: lsRange(0, 0, 0, 5),
            },
          ],
          editor,
          meta
        )

        expect(spy).toHaveBeenCalledTimes(1)
        const [symbol, passedEditor, passedMeta] = spy.calls.argsFor(0)
        expect(symbol.name).toBe("thing")
        expect(passedEditor).toBe(editor)
        expect(passedMeta).toBe(meta)
      })
    })

    it("returns an empty list when given no results", () => {
      expect(adapter.createSymbols([], editor, meta)).toEqual([])
    })
  })

  describe("getSymbols", () => {
    it("returns nothing when there is no server", async () => {
      expect(await adapter.getSymbols(null, createMeta())).toEqual([])
    })

    it("asks for document symbols for a file search", async () => {
      const server = createServer({ documentSymbolProvider: true })
      const spy = spyOn(server.connection, "documentSymbol").and.resolveTo([])
      const meta = createMeta({ type: "file" })

      await adapter.getSymbols(server, meta)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.calls.argsFor(0)[0].textDocument.uri).toBe(`file://${TEST_PATH}`)
    })

    it("asks for workspace symbols for a project search", async () => {
      const server = createServer({ workspaceSymbolProvider: true })
      const spy = spyOn(server.connection, "workspaceSymbol").and.resolveTo([])
      const meta = createMeta({ type: "project", query: "thing" })

      await adapter.getSymbols(server, meta)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.calls.argsFor(0)[0]).toEqual({ query: "thing" })
    })

    it("asks for a definition for a project-find search", async () => {
      const server = createServer({ definitionProvider: true })
      const spy = spyOn(server.connection, "gotoDefinition").and.resolveTo([])
      const meta = createMeta({ type: "project-find", query: "thing" })

      await adapter.getSymbols(server, meta)

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it("falls back to a workspace symbol search when the server cannot resolve definitions", async () => {
      // This is the tier `canProvideSymbols` scores 0.95. Such a server may
      // still be picked for the task, so it must be asked something it can
      // actually answer.
      const server = createServer({ workspaceSymbolProvider: true })
      const workspaceSymbol = spyOn(server.connection, "workspaceSymbol").and.resolveTo([])
      const gotoDefinition = spyOn(server.connection, "gotoDefinition").and.resolveTo([])
      const meta = createMeta({ type: "project-find", query: "thing" })

      await adapter.getSymbols(server, meta)

      expect(gotoDefinition).not.toHaveBeenCalled()
      expect(workspaceSymbol).toHaveBeenCalledTimes(1)
      expect(workspaceSymbol.calls.argsFor(0)[0]).toEqual({ query: "thing" })
    })

    it("returns nothing for a project-find search the server cannot serve at all", async () => {
      const server = createServer({ documentSymbolProvider: true })
      const gotoDefinition = spyOn(server.connection, "gotoDefinition").and.resolveTo([])
      const meta = createMeta({ type: "project-find", query: "thing" })

      expect(await adapter.getSymbols(server, meta)).toEqual([])
      expect(gotoDefinition).not.toHaveBeenCalled()
    })

    it("wraps a single definition result into a list", async () => {
      // `textDocument/definition` may answer with one `Location` rather than an
      // array; the symbol service always expects a list.
      const server = createServer({ definitionProvider: true })
      spyOn(server.connection, "gotoDefinition").and.resolveTo({
        uri: "file:///project/src/target.ts",
        range: lsRange(3, 1, 3, 8),
      } as any)
      const meta = createMeta({ type: "project-find", query: "thing" })

      const symbols = await adapter.getSymbols(server, meta)

      expect(symbols.length).toBe(1)
      expect(symbols[0].name).toBe("thing")
      expect((symbols[0] as any).path).toBe("/project/src/target.ts")
    })

    it("resolves a definition at the start of the supplied range", async () => {
      // When the consumer hands over an explicit range, that wins over the
      // cursor position.
      const server = createServer({ definitionProvider: true })
      const spy = spyOn(server.connection, "gotoDefinition").and.resolveTo([])
      const meta = createMeta({
        type: "project-find",
        query: "thing",
        range: new Range([6, 2], [6, 7]),
      })

      await adapter.getSymbols(server, meta)

      expect(spy.calls.argsFor(0)[0].position).toEqual({ line: 6, character: 2 })
    })

    it("returns nothing for a project-find search with nothing to resolve", async () => {
      const server = createServer({ definitionProvider: true })
      const spy = spyOn(server.connection, "gotoDefinition").and.resolveTo([])
      // An empty editor yields no selection and no word under the cursor.
      const meta = createMeta({ type: "project-find" })

      expect(await adapter.getSymbols(server, meta)).toEqual([])
      expect(spy).not.toHaveBeenCalled()
    })
  })
})
