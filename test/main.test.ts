// This import must come first. Loading an adapter pulls in `lib/convert`
// *before* `lib/main`, which is the ordering that exposed an import cycle
// (main → linter-push-v2-adapter → … → convert → main). Under that ordering
// `main.js` ran `exports.Convert = convert_1.default` while `convert.js` was
// still mid-load, so `Convert` was permanently `undefined` for consumers.
import "../lib/adapters/autocomplete-adapter"

import { readFileSync } from "fs"
import { join } from "path"

import * as main from "../lib/main"

describe("main", () => {
  // Runtime values only — type-only exports such as `Logger` are erased by the
  // compiler and are deliberately absent here.
  const runtimeExports = [
    "AutoLanguageClient",
    "CommandExecutionAdapter",
    "ConsoleLogger",
    "Convert",
    "DownloadFile",
    "FilteredLogger",
    "LinterPushV2Adapter",
    "getExePath",
  ]

  it("exposes every public runtime export regardless of import order", () => {
    for (const name of runtimeExports) {
      expect((main as any)[name])
        .withContext(`main.${name} is undefined — check for an import cycle through "../main"`)
        .toBeDefined()
    }
  })

  it("does not let lib/convert depend on any adapter", () => {
    // `convert` is imported by nearly every adapter, so it must sit at the
    // bottom of the dependency graph. When it imported `diagnostic-adapter`,
    // the resulting cycle left `IdeDiagnosticAdapter`'s superclass undefined at
    // load time and threw "Class extends value undefined".
    //
    // Asserted against the compiled output because that is what actually gets
    // required at runtime, and the require order is what matters.
    const compiled = readFileSync(join(__dirname, "..", "lib", "convert.js"), "utf8")
    const adapterRequires = compiled.match(/require\("\.\/adapters\/[^"]+"\)/g)

    expect(adapterRequires).toBeNull()
  })

  it("exposes a usable Convert", () => {
    // `Convert` was present as a key but held `undefined`, so a bare
    // `toBeDefined` on the key alone would not have caught the regression.
    expect(typeof main.Convert.atomRangeToLSRange).toBe("function")
  })
})
