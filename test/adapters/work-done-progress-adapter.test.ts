import { BusySignalService } from "atom-ide"

import WorkDoneProgressAdapter from "../../lib/adapters/work-done-progress-adapter"
import * as ls from "../../lib/languageclient"
import { createSpyConnection } from "../helpers.js"

describe("WorkDoneProgressAdapter", () => {
  const TOKEN = "progress-token-1"

  interface FakeBusyMessage {
    initialTitle: string
    setTitle: jasmine.Spy
    dispose: jasmine.Spy
  }

  let messages: FakeBusyMessage[]
  let api: BusySignalService
  let adapter: WorkDoneProgressAdapter
  let connection: ls.LanguageClientConnection

  function createBusySignalService(): BusySignalService {
    return {
      reportBusy: jasmine.createSpy("reportBusy").and.callFake((title: string) => {
        const message: FakeBusyMessage = {
          initialTitle: title,
          setTitle: jasmine.createSpy("setTitle"),
          dispose: jasmine.createSpy("dispose"),
        }
        messages.push(message)
        return message
      }),
      reportBusyWhile: jasmine.createSpy("reportBusyWhile"),
      dispose: jasmine.createSpy("dispose"),
    } as unknown as BusySignalService
  }

  /** The most recent `BusyMessage` handed out by the fake service. */
  function lastMessage(): FakeBusyMessage {
    return messages[messages.length - 1]
  }

  /** Registers a job for `token` and returns its busy message. */
  function createJob(token: ls.ProgressToken = TOKEN): FakeBusyMessage {
    adapter.createWorkDoneProgress({ token })
    return lastMessage()
  }

  beforeEach(() => {
    messages = []
    api = createBusySignalService()
    connection = new ls.LanguageClientConnection(createSpyConnection())
    adapter = new WorkDoneProgressAdapter(connection, api)
  })

  describe("wiring", () => {
    let onCreate: (params: ls.WorkDoneProgressCreateParams) => unknown
    let onProgress: (params: { token: ls.ProgressToken; value: unknown }) => void

    beforeEach(() => {
      // A fresh connection, so that the callbacks can be captured as the
      // constructor registers them.
      connection = new ls.LanguageClientConnection(createSpyConnection())
      spyOn(connection, "onWorkDoneProgressCreate").and.callFake((callback: any) => {
        onCreate = callback
      })
      spyOn(connection, "onProgress").and.callFake((callback: any) => {
        onProgress = callback
      })
      adapter = new WorkDoneProgressAdapter(connection, api)
    })

    it("subscribes to both the create request and the progress notification", () => {
      expect(connection.onWorkDoneProgressCreate).toHaveBeenCalledTimes(1)
      expect(connection.onProgress).toHaveBeenCalledTimes(1)
    })

    it("creates a busy message when the server asks for one", () => {
      onCreate({ token: TOKEN })

      expect(api.reportBusy).toHaveBeenCalledTimes(1)
    })

    it("routes a begin notification to the busy message's title", () => {
      onCreate({ token: TOKEN })
      onProgress({ token: TOKEN, value: { kind: "begin", title: "Indexing" } })

      expect(lastMessage().setTitle).toHaveBeenCalledWith("Indexing")
    })

    it("routes a report notification to the busy message's title", () => {
      onCreate({ token: TOKEN })
      onProgress({ token: TOKEN, value: { kind: "begin", title: "Indexing" } })
      onProgress({ token: TOKEN, value: { kind: "report", message: "src/main.ts" } })

      expect(lastMessage().setTitle).toHaveBeenCalledWith("Indexing: src/main.ts")
    })

    it("routes an end notification to disposal", () => {
      onCreate({ token: TOKEN })
      onProgress({ token: TOKEN, value: { kind: "begin", title: "Indexing" } })
      onProgress({ token: TOKEN, value: { kind: "end" } })

      expect(lastMessage().dispose).toHaveBeenCalledTimes(1)
    })

    it("ignores progress for a token it did not create", () => {
      // `$/progress` carries all sorts of traffic, only some of which is ours.
      onProgress({ token: "someone-else's-token", value: { kind: "begin", title: "Not ours" } })

      expect(api.reportBusy).not.toHaveBeenCalled()
      expect(messages.length).toBe(0)
    })

    it("ignores a progress value that is not a work-done progress", () => {
      onCreate({ token: TOKEN })
      const message = lastMessage()

      onProgress({ token: TOKEN, value: { some: "other payload" } })
      onProgress({ token: TOKEN, value: { kind: "unrecognized" } })
      onProgress({ token: TOKEN, value: null })

      expect(message.setTitle).not.toHaveBeenCalled()
      expect(message.dispose).not.toHaveBeenCalled()
    })
  })

  describe("createWorkDoneProgress", () => {
    it("opens a busy message straight away", () => {
      // The real title does not arrive until `begin`, so a placeholder stands
      // in until then.
      const message = createJob()

      expect(api.reportBusy).toHaveBeenCalledTimes(1)
      expect(message.initialTitle).toBe("Busy…")
    })

    it("files the message under its token", () => {
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing")
    })
  })

  describe("beginWorkDoneProgress", () => {
    it("sets the title the server supplied", () => {
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing")
    })

    it("appends a message when one is supplied", () => {
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, {
        kind: "begin",
        title: "Indexing",
        message: "src/main.ts",
      })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: src/main.ts")
    })

    it("appends a percentage alongside the message", () => {
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, {
        kind: "begin",
        title: "Indexing",
        message: "src/main.ts",
        percentage: 40,
      })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: src/main.ts (40%)")
    })

    it("remembers the title for later reports to build on", () => {
      // `report` and `end` carry no title of their own.
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })
      adapter.updateWorkDoneProgress(TOKEN, { kind: "report", message: "src/main.ts" })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: src/main.ts")
    })

    it("appends a percentage on its own without leaving a gap", () => {
      // A server may report progress numerically with no accompanying text.
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing", percentage: 40 })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: (40%)")
    })

    it("shows a percentage of zero rather than treating it as absent", () => {
      // A task opening at 0% is reporting its progress, not omitting it.
      const message = createJob()

      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing", percentage: 0 })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: (0%)")
    })

    it("does nothing for a token with no job", () => {
      expect(() => {
        adapter.beginWorkDoneProgress("unknown", { kind: "begin", title: "Indexing" })
      }).not.toThrow()
      expect(api.reportBusy).not.toHaveBeenCalled()
    })
  })

  describe("dispose", () => {
    it("closes out any progress still in flight", () => {
      // A server that goes away mid-task would otherwise strand its busy
      // message, since nothing will ever send the `end` that clears it.
      const first = createJob("token-a")
      const second = createJob("token-b")

      adapter.dispose()

      expect(first.dispose).toHaveBeenCalledTimes(1)
      expect(second.dispose).toHaveBeenCalledTimes(1)
    })

    it("forgets the jobs it closed", () => {
      const message = createJob()
      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })

      adapter.dispose()
      message.setTitle.calls.reset()
      message.dispose.calls.reset()
      adapter.endWorkDoneProgress(TOKEN, { kind: "end", message: "late" })

      expect(message.setTitle).not.toHaveBeenCalled()
      expect(message.dispose).not.toHaveBeenCalled()
    })

    it("is harmless when nothing is in flight", () => {
      expect(() => adapter.dispose()).not.toThrow()
    })
  })

  describe("updateWorkDoneProgress", () => {
    it("rebuilds the title from the one remembered at begin", () => {
      const message = createJob()
      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })

      adapter.updateWorkDoneProgress(TOKEN, {
        kind: "report",
        message: "src/main.ts",
        percentage: 60,
      })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: src/main.ts (60%)")
    })

    it("keeps the bare title when the report adds nothing", () => {
      const message = createJob()
      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })
      message.setTitle.calls.reset()

      adapter.updateWorkDoneProgress(TOKEN, { kind: "report" })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing")
    })

    it("does nothing for a token with no job", () => {
      expect(() => {
        adapter.updateWorkDoneProgress("unknown", { kind: "report", message: "x" })
      }).not.toThrow()
    })
  })

  describe("endWorkDoneProgress", () => {
    it("disposes the busy message", () => {
      const message = createJob()
      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })

      adapter.endWorkDoneProgress(TOKEN, { kind: "end" })

      expect(message.dispose).toHaveBeenCalledTimes(1)
    })

    it("sets a closing title when the server supplies a final message", () => {
      const message = createJob()
      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })
      message.setTitle.calls.reset()

      adapter.endWorkDoneProgress(TOKEN, { kind: "end", message: "done" })

      expect(message.setTitle).toHaveBeenCalledWith("Indexing: done")
    })

    it("forgets the job so later progress on that token is ignored", () => {
      const message = createJob()
      adapter.beginWorkDoneProgress(TOKEN, { kind: "begin", title: "Indexing" })

      adapter.endWorkDoneProgress(TOKEN, { kind: "end" })
      message.dispose.calls.reset()
      message.setTitle.calls.reset()
      adapter.endWorkDoneProgress(TOKEN, { kind: "end", message: "again" })

      expect(message.dispose).not.toHaveBeenCalled()
      expect(message.setTitle).not.toHaveBeenCalled()
    })

    it("does nothing for a token with no job", () => {
      expect(() => {
        adapter.endWorkDoneProgress("unknown", { kind: "end" })
      }).not.toThrow()
    })
  })

  describe("cancelWorkDoneProgress", () => {
    it("disposes the busy message and forgets the job", () => {
      const message = createJob()

      adapter.cancelWorkDoneProgress({ token: TOKEN })

      expect(message.dispose).toHaveBeenCalledTimes(1)

      // Forgotten, so a late report on that token is ignored.
      message.setTitle.calls.reset()
      adapter.updateWorkDoneProgress(TOKEN, { kind: "report", message: "late" })
      expect(message.setTitle).not.toHaveBeenCalled()
    })

    it("does nothing for a token with no job", () => {
      expect(() => {
        adapter.cancelWorkDoneProgress({ token: "unknown" })
      }).not.toThrow()
    })
  })

  describe("concurrent jobs", () => {
    it("keeps separate tokens' titles apart", () => {
      const first = createJob("token-a")
      const second = createJob("token-b")

      adapter.beginWorkDoneProgress("token-a", { kind: "begin", title: "Indexing" })
      adapter.beginWorkDoneProgress("token-b", { kind: "begin", title: "Building" })
      adapter.updateWorkDoneProgress("token-a", { kind: "report", message: "a.ts" })
      adapter.updateWorkDoneProgress("token-b", { kind: "report", message: "b.ts" })

      expect(first.setTitle).toHaveBeenCalledWith("Indexing: a.ts")
      expect(second.setTitle).toHaveBeenCalledWith("Building: b.ts")
    })

    it("ends only the job that was ended", () => {
      const first = createJob("token-a")
      const second = createJob("token-b")
      adapter.beginWorkDoneProgress("token-b", { kind: "begin", title: "Building" })

      adapter.endWorkDoneProgress("token-a", { kind: "end" })

      expect(first.dispose).toHaveBeenCalledTimes(1)
      expect(second.dispose).not.toHaveBeenCalled()

      // The surviving job still responds to its own progress.
      adapter.updateWorkDoneProgress("token-b", { kind: "report", message: "b.ts" })
      expect(second.setTitle).toHaveBeenCalledWith("Building: b.ts")
    })
  })
})
