# ~~Atom~~ Pulsar Language Server Protocol Client (Forked!)

This repo was moved from [atom/atom-languageclient](https://github.com/atom/atom-languageclient).

Provide integration support for adding [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) servers to Pulsar.

---

## I followed a link from a package README. What functionality does this provide?

This isn’t a Pulsar package itself; it’s a library meant to be used by Pulsar packages. It knows how to talk to a language server and to hook up its features to Pulsar’s UI.

For instance:

* It knows how to supply autocompletion suggestions to Pulsar’s `autocomplete-plus` package
* It knows how to ask the language server where something is defined (a function, a class, whatever) so it can jump to the declaration of the symbol under the cursor (as implemented by the `symbols-view` package)
* It knows how to ask a language server to reformat the selected code
* It knows how to ask a language server for diagnostic messages and report them to the `linter` package

Many Pulsar features are implemented by packages that know how to do the UI for the feature but rely on a different package to provide the “brains” behind it. They define contracts called “services” that other packages can use to supply data to them.

Language servers are designed to be those brains, and `atom-languageclient` hooks them up to the services that can take advantage of them.

Capabilities vary; some language servers support lots of tasks, and others support only a few. But here are some things that a language server can do, and the parts of Pulsar that this package talks to to make them happen:

* `autocomplete-plus` (builtin Pulsar package)
  * See autocompletion options as you type
* `symbols-view` (builtin Pulsar package)
  * View and filter a list of symbols in the current file (function names, class names, etc.)
  * View and filter a list of symbols across all files in the project
  * Jump to the definition of the symbol under the cursor
* [linter][] and [linter-ui-default][]
  * View diagnostic messages as you type (syntax errors, stylistic suggestions, etc.)
* [intentions](https://web.pulsar-edit.dev/packages/intentions)
  * Open a menu to view possible code actions for a diagnostic message
  * Open a menu to view possible code actions for the file at large
* [pulsar-outline-view](https://web.pulsar-edit.dev/packages/pulsar-outline-view)
  * View a hierarchical list of the current file’s symbols
* [pulsar-refactor](https://web.pulsar-edit.dev/packages/pulsar-refactor)
  * Perform project-wide renaming of variables, methods, classes, types, etc.
* [pulsar-find-references](https://web.pulsar-edit.dev/packages/pulsar-find-references)
  * Place the cursor inside of a token to highlight other usages of that token
  * Place the cursor inside of a token, then view a `find-and-replace`-style “results” panel containing all usages of that token across your project
* [pulsar-code-format](https://web.pulsar-edit.dev/packages/pulsar-code-format)
* [pulsar-hover](https://web.pulsar-edit.dev/packages/pulsar-hover)
  * Hover over a symbol to see any related documentation, including method signatures
  * View a function’s parameter signature as you type its arguments
* [atom-ide-definitions](https://web.pulsar-edit.dev/packages/atom-ide-definitions)
  * Jump to the definition of the symbol under the cursor
* [atom-ide-datatip](https://web.pulsar-edit.dev/packages/atom-ide-datatip)
  * Hover over a symbol to see any related documentation, including method signatures
* [atom-ide-signature-help](https://web.pulsar-edit.dev/packages/atom-ide-signature-help)
  * View a function’s parameter signature as you type its arguments
* [atom-ide-code-format](https://web.pulsar-edit.dev/packages/atom-ide-code-format)
  * Invoke on a buffer (or a subset of your buffer) to reformat your code according to the language server’s settings

---

## What’s different from mainline `atom-languageclient`?

Here are a few of the notable features added in this fork:

* Symbol search within files and across projects, plus “Go to Reference” support, via the builtin [symbols-view](https://web.pulsar-edit.dev/packages/symbols-view) package
  * Ability to customize/ignore symbols before they’re shown to the user
* Deeper integration with `linter`:
  * Possible solutions for linting issues appear in an `intentions` menu
  * Ability to customize/ignore diagnostic messages before they’re shown to the user
* Using the `intentions` package for code actions:
  * Ability to invoke the `intentions:show` command anywhere in the buffer and receive code action suggestions
* Removed dependency on the `zadeh` library in favor of Pulsar’s built-in fuzzy-matcher (`zadeh` doesn’t have an Apple Silicon pre-build, so this was causing headaches for some users)
  * If the built-in fuzzy-matcher somehow isn’t present, we fall back to `fuzzaldrin` (written in pure JS)
* Ability to use `busy-signal` to report the status of server-initiated tasks
* Ability for consuming packages to filter server-sent messaages (via `window/showMessage`) before they’re shown to the user
* New, easier-to-use services — `hover` and `signature` — for hover information and signature help
* SOON: Ability to react to user-initiated file operations — new files, moved files, deleted files — via the tree view

More features are planned.

## Background

[Language Server Protocol (LSP)](https://microsoft.github.io/language-server-protocol/) is a JSON-RPC based mechanism whereby a client (IDE) may connect to an out-of-process server that can provide rich analysis, refactoring and interactive features for a given programming language.

## Implementation

This is not a Pulsar package; it’s an NPM package meant to be used as a dependency of a Pulsar package. It can be used by Pulsar package authors wanting to integrate LSP-compatible language servers with Pulsar. It provides:

- Conversion routines between Pulsar and LSP types
- A TypeScript wrapper around JSON-RPC for **v3** of the LSP protocol
- All necessary TypeScript input and return structures for LSP, notifications etc.
- A number of adapters to translate communication between Pulsar and the LSP's capabilities
- Automatic wiring up of adapters based on the negotiated capabilities of the language server
- Helper functions for downloading additional non-NPM dependencies

## Capabilities

The language server protocol consists of a number of capabilities. Some of these already have a counterpoint we can connect up to today while others do not. The following table shows each capability in v2 and how it is exposed via Pulsar:

| Capability                        | Atom interface                              |
| --------------------------------- | --------------------------------------------|
| window/showMessage                | `notifications` (builtin)                   |
| window/showMessageRequest         | `notifications` (builtin)                   |
| window/logMessage                 | Developer tools console                     |
| telemetry/event                   | Ignored                                     |
| workspace/didChangeWatchedFiles   | Pulsar core                                 |
| textDocument/publishDiagnostics   | `linter` v2 push/indie                      |
| textDocument/completion           | `autocomplete-plus` (builtin)               |
| completionItem/resolve            | `autocomplete-plus` (builtin)               |
| textDocument/hover                | `pulsar-hover`/`atom-ide-datatip`           |
| textDocument/signatureHelp        | `pulsar-hover`/`atom-ide-signature-help`    |
| textDocument/definition           | `symbols-view`/`atom-ide-definitions`       |
| textDocument/findReferences       | `pulsar-find-references`                    |
| textDocument/documentHighlight    | TBD                                         |
| textDocument/documentSymbol       | `symbols-view`/`pulsar-outline-view`        |
| workspace/symbol                  | `symbols-view` (builtin)                    |
| textDocument/codeAction           | `intentions`                                |
| textDocument/codeLens             | TBD                                         |
| textDocument/formatting           | `pulsar-code-format`/`atom-ide-code-format` |
| textDocument/rangeFormatting      | `pulsar-code-format`/`atom-ide-code-format` |
| textDocument/onTypeFormatting     | TBD                                         |
| textDocument/onSaveFormatting     | TBD                                         |
| textDocument/prepareCallHierarchy | TBD                                         |
| textDocument/rename               | `pulsar-refactor`                           |
| textDocument/didChange            | Pulsar core                                 |
| textDocument/didOpen              | Pulsar core                                 |
| textDocument/didSave              | Pulsar core                                 |
| textDocument/willSave             | Pulsar core                                 |
| textDocument/didClose             | Pulsar core                                 |

_(`atom-ide-ui` references removed, since it is currently incompatible with Pulsar)_

## Developing packages

The underlying JSON-RPC communication is handled by the [vscode-jsonrpc npm module](https://www.npmjs.com/package/vscode-jsonrpc).

### Minimal example (Nodejs-compatible LSP exe)

A minimal implementation can be illustrated by the Omnisharp package here which has only npm-managed dependencies, and the LSP is a JavaScript file. You simply provide the scope name, language name and server name as well as start your process and `AutoLanguageClient` takes care of interrogating your language server capabilities and wiring up the appropriate services within Atom to expose them.

```javascript
const { AutoLanguageClient } = require("atom-languageclient")

class CSharpLanguageClient extends AutoLanguageClient {
  getGrammarScopes() {
    return ["source.cs"]
  }
  getLanguageName() {
    return "C#"
  }
  getServerName() {
    return "OmniSharp"
  }
  getPackageName() {
    return "ide-csharp"
  }
  startServerProcess() {
    return super.spawnChildNode([
      require.resolve("omnisharp-client/languageserver/server")
    ])
  }
}

module.exports = new CSharpLanguageClient()
```

You can get this code packaged up with the necessary package.json etc. from the [ide-csharp](https://github.com/atom/ide-csharp) provides C# support via [Omnisharp (node-omnisharp)](https://github.com/OmniSharp/omnisharp-node-client) repo.

Note that you will also need to add various entries to the `providedServices` and `consumedServices` section of your package.json (for now). You can [obtain these entries here](https://github.com/atom/ide-csharp/tree/master/package.json).

### Minimal example (General LSP exe)

If the LSP is a general executable (not a JavaScript file), you should use `spawn` inside `startServerProcess`.

```javascript
const { AutoLanguageClient } = require("atom-languageclient")

class DLanguageClient extends AutoLanguageClient {
  getGrammarScopes() {
    return ["source.d"]
  }
  getLanguageName() {
    return "D"
  }
  getServerName() {
    return "serve-d"
  }
  getPackageName() {
    return "ide-d"
  }
  startServerProcess(projectPath) {
    return super.spawn(
      "serve-d", // the `name` or `path` of the executable
      // if the `name` is provided it checks `bin/platform-arch/exeName` by default, and if doesn't exists uses the `exeName` on the PATH
      [], // args passed to spawn the exe
      { cwd: projectPath } // child process spawn options
    )
  }
}

module.exports = new DLanguageClient()
```

### Using other connection types

The default connection type is _stdio_ however both _ipc_ and _sockets_ are also available.

#### IPC

To use ipc simply return _ipc_ from getConnectionType(), e.g.

```javascript
class ExampleLanguageClient extends AutoLanguageClient {
  getGrammarScopes() {
    return ["source.js", "javascript"]
  }
  getLanguageName() {
    return "JavaScript"
  }
  getServerName() {
    return "JavaScript Language Server"
  }
  getPackageName() {
    return "ide-javascript"
  }
  getConnectionType() {
    return "ipc"
  }
  startServerProcess() {
    const startServer = require.resolve("@example/js-language-server")
    return super.spawnChildNode([startServer, "--node-ipc"], {
      stdio: [null, null, null, "ipc"],
    })
  }
}
```

#### Sockets

Sockets are a little more complex because you need to allocate a free socket. The [ide-php package](https://github.com/atom/ide-php/blob/master/lib/main.js) contains an example of this.

### Debugging

Atom-LanguageClient can log all sent and received messages nicely formatted to the Developer Tools Console within Atom. To do so simply enable it with `atom.config.set('core.debugLSP', true)`, e.g.

### Tips

Some more elaborate scenarios can be found in the [ide-java](https://github.com/atom/ide-java) package which includes:

- Downloading and unpacking non-npm dependencies (in this case a .tar.gz containing JAR files)
- Platform-specific start-up configuration
- Wiring up custom extensions to the protocol (language/status to Atom Status-Bar, language/actionableNotification to Atom Notifications)

### Available packages

Right now we have the following experimental Atom LSP packages in development. They are mostly usable but are missing some features that either the LSP server doesn't support or expose functionality that is as yet unmapped to Atom (TODO and TBD in the capabilities table above).

### Official packages

- [ide-csharp](https://github.com/atom/ide-csharp) provides C# support via [Omnisharp (node-omnisharp)](https://github.com/OmniSharp/omnisharp-node-client)
- [ide-flowtype](https://github.com/flowtype/ide-flowtype) provides Flow support via [Flow Language Server](https://github.com/flowtype/flow-language-server)
- [ide-java](https://github.com/atom/ide-java) provides Java support via [Java Eclipse JDT](https://github.com/eclipse/eclipse.jdt.ls)
- [ide-typescript](https://github.com/atom/ide-typescript) provides TypeScript and Javascript support via [SourceGraph Typescript Language Server](https://github.com/sourcegraph/javascript-typescript-langserver)

### Community packages

Our [full list of Atom IDE packages](https://github.com/atom-ide-community/atom-languageclient/wiki/List-of-Atom-packages-using-Atom-LanguageClient) includes the community packages.

### Other language servers

Additional LSP servers that might be of interest to be packaged with this for Atom can be found at [LangServer.org](http://langserver.org)

## Contributing

### Running from source

If you want to run from source you will need to perform the following steps (you will need node and npm intalled):

1. Check out the source
2. From the source folder type `npm link` to build and link
3. From the folder where your package lives type `npm link atom-languageclient`

If you want to switch back to the production version of atom-languageclient type `npm unlink atom-languageclient` from the folder where your package lives.

### Before sending a PR

We have various unit tests and some linter rules - you can run both of these locally using `npm test` to ensure your CI will get a clean build.

### Guidance

Always feel free to help out! Whether it's [filing bugs and feature requests](https://github.com/atom-ide-community/atom-languageclient/issues/new) or working on some of the [open issues](https://github.com/atom-ide-community/atom-languageclient/issues), Atom's [contributing guide](https://github.com/atom/atom/blob/master/CONTRIBUTING.md) will help get you started while the [guide for contributing to packages](https://github.com/atom/atom/blob/master/docs/contributing-to-packages.md) has some extra information.

## License

MIT License. See [the license](/LICENSE.md) for more details.

[linter]: https://web.pulsar-edit.dev/packages/linter
[linter-ui-default]: https://web.pulsar-edit.dev/packages/linter-ui-default
