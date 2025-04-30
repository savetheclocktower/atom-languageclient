import type * as atomIde from "atom-ide-base"
import assert = require("assert")
import Convert from "../convert"
import { ActiveServer } from "../server-manager"
import { CompositeDisposable, Point, TextEditor } from "atom"
import {
  LanguageClientConnection,
  ServerCapabilities,
  SignatureHelp,
  SignatureHelpContext,
  SignatureHelpTriggerKind
} from "../languageclient"

class TimeoutError extends Error {
  name = 'TimeoutError'
}

/**
 * Returns a promise that rejects after the given amount of time.
 */
async function timeout<T = unknown>(ms: number) {
  // Accepts an arbitrary generic parameter to make TypeScript happy; since
  // this promise can never resolve, it's a moot point.
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new TimeoutError()), ms)
  })
}

/**
 * Service definition for the `signature` service.
 *
 * Acts like a provider — unlike `signature-help`, which inverts the
 * provider/consumer relationship. We manage to pull this off because the
 * actual provider object is a `Promise` that _resolves_ to this object.
 */
export type SignatureProvider = {
  name: string
  packageName: string
  priority: number
  grammarScopes: string[]
  triggerCharacters?: Set<string>
  retriggerCharacters?: Set<string>
  getSignature: (editor: TextEditor, point: Point, context?: SignatureHelpContext) => Promise<SignatureHelp | null>
}

export class SignatureAdapter {
  private _disposables = new CompositeDisposable()
  private _connection: LanguageClientConnection
  private _capabilities: ServerCapabilities

  public triggerCharacters?: Set<string>
  public retriggerCharacters?: Set<string>

  private static _createdPromise: Promise<SignatureAdapter | null> | null = null
  private static _resolveCreatedPromise: ((adapter: SignatureAdapter) => void) | null = null
  private static _firstCreatedAdapter: SignatureAdapter | null = null

  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return serverCapabilities.signatureHelpProvider != null
  }

  /**
   * Called after a `SignatureAdapter` is instantiated.
   */
  public static didCreate(adapter: SignatureAdapter) {
    this._resolveCreatedPromise?.(adapter)
  }

  /**
   * Wait for a `SignatureAdapter` to be created.
   *
   * Rejects after the specified timeout, or 5000ms by default.
   */
  public static waitForFirst(timeoutMs = 5000): Promise<SignatureAdapter | null> {
    if (this._firstCreatedAdapter) {
      return Promise.resolve(this._firstCreatedAdapter)
    }
    if (!this._createdPromise) {
      this._createdPromise = new Promise<SignatureAdapter | null>((resolve) => {
        this._resolveCreatedPromise = resolve
      })
    }
    // Wait a maximum of 5 seconds before giving up.
    return Promise.race<SignatureAdapter | null>([
      this._createdPromise,
      timeout<SignatureAdapter | null>(timeoutMs)
    ])
  }

  constructor(server: ActiveServer) {
    this._connection = server.connection
    this._capabilities = server.capabilities

    let { triggerCharacters, retriggerCharacters } = this._capabilities.signatureHelpProvider ?? {}

    if (Array.isArray(triggerCharacters)) {
      this.triggerCharacters = new Set<string>(triggerCharacters)
    }
    if (Array.isArray(retriggerCharacters)) {
      this.retriggerCharacters = new Set<string>(retriggerCharacters)
    }
    SignatureAdapter.didCreate(this)
  }

  public dispose(): void {
    this._disposables.dispose()
  }

  public getSignature(
    editor: TextEditor,
    point: Point,
    context?: SignatureHelpContext
  ): Promise<SignatureHelp | null> {
    let params = {
      ...Convert.editorToTextDocumentPositionParams(editor, point),
      context: {
        triggerKind: SignatureHelpTriggerKind.TriggerCharacter,
        ...(context ?? {})
      }
    }
    return this._connection.signatureHelp(params)
  }
}


export default class SignatureHelpAdapter {
  private _disposables: CompositeDisposable = new CompositeDisposable()
  private _connection: LanguageClientConnection
  private _capabilities: ServerCapabilities
  private _grammarScopes: string[]

  constructor(server: ActiveServer, grammarScopes: string[]) {
    this._connection = server.connection
    this._capabilities = server.capabilities
    this._grammarScopes = grammarScopes
  }

  /**
   * @returns A boolean indicating this adapter can adapt the server based on
   * the given serverCapabilities.
   */
  public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
    return serverCapabilities.signatureHelpProvider != null
  }

  public dispose(): void {
    this._disposables.dispose()
  }

  public attach(register: atomIde.SignatureHelpRegistry): void {
    const { signatureHelpProvider } = this._capabilities
    assert(signatureHelpProvider != null)

    let triggerCharacters: Set<string> | undefined
    if (signatureHelpProvider && Array.isArray(signatureHelpProvider.triggerCharacters)) {
      triggerCharacters = new Set(signatureHelpProvider.triggerCharacters)
      if (Array.isArray(signatureHelpProvider.retriggerCharacters)) {
        // TODO: Should we do this in lieu of proper support for
        // `retriggerCharacters`?
        for (let char of signatureHelpProvider.retriggerCharacters) {
          triggerCharacters.add(char)
        }
      }
    }

    this._disposables.add(
      register({
        priority: 1,
        grammarScopes: this._grammarScopes,
        triggerCharacters,
        getSignatureHelp: this.getSignatureHelp.bind(this),
      })
    )
  }

  /** Public: Retrieves signature help for a given editor and position. */
  public getSignatureHelp(editor: TextEditor, point: Point): Promise<SignatureHelp | null> {
    let params = Convert.editorToTextDocumentPositionParams(editor, point)
    return this._connection.signatureHelp(params)
  }
}
