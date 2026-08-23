import { Point, Range } from "atom"

import LinterPushV2Adapter from "../../lib/adapters/linter-push-v2-adapter"
import * as ls from "../../lib/languageclient"
import { createSpyConnection } from "../helpers.js"

describe("LinterPushV2Adapter", () => {
  describe("constructor", () => {
    it("subscribes to onPublishDiagnostics", () => {
      const languageClient = new ls.LanguageClientConnection(createSpyConnection())
      spyOn(languageClient, "onPublishDiagnostics").and.callThrough()
      // eslint-disable-next-line no-new
      new LinterPushV2Adapter(languageClient)
      expect((languageClient as any).onPublishDiagnostics).toHaveBeenCalled()
    })
  })

  describe("captureDiagnostics", () => {
    function lsRange(startLine: number, startChar: number, endLine: number, endChar: number): ls.Range {
      return {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
      }
    }

    it("registers intentions for diagnostics whether or not they carry a code", () => {
      // Registration is also what files a diagnostic as context for the
      // subsequent `textDocument/codeAction` request, so skipping the codeless
      // ones kept the server from ever hearing about them. `code` is optional
      // in LSP.
      const onLinterMessageAdded = jasmine.createSpy("onLinterMessageAdded")
      const intentions = { onLinterMessageAdded, clearLinterIntentions: () => undefined } as any
      const adapter = new LinterPushV2Adapter(
        new ls.LanguageClientConnection(createSpyConnection()),
        intentions
      )

      adapter.captureDiagnostics({
        uri: "file:///a/b/c/d.js",
        diagnostics: [
          { range: lsRange(1, 0, 1, 4), message: "with code", severity: ls.DiagnosticSeverity.Error, code: "E1" },
          { range: lsRange(2, 0, 2, 4), message: "without code", severity: ls.DiagnosticSeverity.Error },
        ],
      })

      expect(onLinterMessageAdded).toHaveBeenCalledTimes(2)
      expect(onLinterMessageAdded.calls.argsFor(0)[2]).toBe("E1")
      expect(onLinterMessageAdded.calls.argsFor(1)[2]).toBeNull()
    })
  })

  describe("diagnosticToMessage", () => {
    it("converts Diagnostic and path to a linter$Message", () => {
      const filePath = "/a/b/c/d"
      const diagnostic: ls.Diagnostic = {
        message: "This is a message",
        range: {
          start: { line: 1, character: 2 },
          end: { line: 3, character: 4 },
        },
        source: "source",
        code: "code",
        severity: ls.DiagnosticSeverity.Information,
      }

      const connection: any = { onPublishDiagnostics() {} }
      const adapter = new LinterPushV2Adapter(connection)
      const result = adapter.diagnosticToV2Message(filePath, diagnostic)

      expect(result.excerpt).toBe(diagnostic.message as string)
      expect(result.linterName).toBe(diagnostic.source)
      expect(result.location.file).toBe(filePath)
      expect(result.location.position).toEqual(new Range(new Point(1, 2), new Point(3, 4)))
      expect(result.severity).toBe("info")
    })
  })

  describe("diagnosticSeverityToSeverity", () => {
    it('converts DiagnosticSeverity.Error to "error"', () => {
      const severity = LinterPushV2Adapter.diagnosticSeverityToSeverity(ls.DiagnosticSeverity.Error)
      expect(severity).toBe("error")
    })

    it('converts DiagnosticSeverity.Warning to "warning"', () => {
      const severity = LinterPushV2Adapter.diagnosticSeverityToSeverity(ls.DiagnosticSeverity.Warning)
      expect(severity).toBe("warning")
    })

    it('converts DiagnosticSeverity.Information to "info"', () => {
      const severity = LinterPushV2Adapter.diagnosticSeverityToSeverity(ls.DiagnosticSeverity.Information)
      expect(severity).toBe("info")
    })

    it('converts DiagnosticSeverity.Hint to "info"', () => {
      const severity = LinterPushV2Adapter.diagnosticSeverityToSeverity(ls.DiagnosticSeverity.Hint)
      expect(severity).toBe("info")
    })
  })
})
