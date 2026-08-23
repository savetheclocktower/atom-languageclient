import { Point } from "atom"
import * as fs from "fs"
import { tmpdir } from "os"
import { dirname,join } from "path"

import * as Utils from "../lib/utils"
import { createFakeEditor } from "./helpers"

describe("Utils", () => {
  describe("getWordAtPosition", () => {
    let editor: any
    beforeEach(() => {
      editor = createFakeEditor("test.txt")
      editor.setText("blah test1234 test-two")
    })

    it("gets the word at position from a text editor", () => {
      // "blah"
      let range = Utils.getWordAtPosition(editor, new Point(0, 0))
      expect(range.serialize()).toEqual([
        [0, 0],
        [0, 4],
      ])

      // "test1234"
      range = Utils.getWordAtPosition(editor, new Point(0, 7))
      expect(range.serialize()).toEqual([
        [0, 5],
        [0, 13],
      ])

      // "test"
      range = Utils.getWordAtPosition(editor, new Point(0, 14))
      expect(range.serialize()).toEqual([
        [0, 14],
        [0, 18],
      ])
    })

    it("returns empty ranges for non-words", () => {
      const range = Utils.getWordAtPosition(editor, new Point(0, 4))
      expect(range.serialize()).toEqual([
        [0, 4],
        [0, 4],
      ])
    })
  })

  describe("getExePath", () => {
    // These specs use real files rather than stubbing `fs.existsSync`. Under
    // `esModuleInterop`, `import * as fs` yields a synthetic namespace object
    // whose properties are getter-only, so it cannot be spied on — and even if
    // it could, it is a *copy*: `lib/utils.ts` reads from its own `require("fs")`
    // and would never see the stub.
    const exeName = process.platform === "win32" ? "serve-d.exe" : "serve-d"

    let tempDir: string
    let originalCwd: string

    beforeEach(() => {
      originalCwd = process.cwd()
      tempDir = fs.mkdtempSync(join(tmpdir(), "atom-languageclient-"))
    })

    afterEach(() => {
      process.chdir(originalCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    /** Creates an empty file, along with any missing parent directories. */
    function touch(path: string): string {
      fs.mkdirSync(dirname(path), { recursive: true })
      fs.writeFileSync(path, "")
      return path
    }

    it("returns the exe path under bin folder by default", () => {
      // The default root is relative, so it resolves against the working
      // directory. Run from a temp directory to avoid writing into the repo.
      process.chdir(tempDir)
      const expectedExe = touch(join(process.cwd(), "bin", `${process.platform}-${process.arch}`, exeName))

      expect(Utils.getExePath("serve-d")).toBe(expectedExe)
    })

    it("returns the exe path for the given root", () => {
      const rootPath = join(tempDir, `${process.platform}-${process.arch}`)
      const expectedExe = touch(join(rootPath, exeName))

      expect(Utils.getExePath("serve-d", rootPath)).toBe(expectedExe)
    })

    it("returns the exe name if the file does not exist under rootPath", () => {
      expect(Utils.getExePath("python", tempDir)).toBe("python")
    })
  })
})
