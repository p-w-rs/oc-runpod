import { stat } from "node:fs/promises"
import { join } from "node:path"
import { atomicWrite, ensurePrivateDir, readJson, Serial, withFileLock } from "oc-secure-kit"
import { ACCOUNTS_FORMAT, normalizeAccount, type Account, type Discovery } from "./model.js"

interface AccountsFile { format: typeof ACCOUNTS_FORMAT; revision: number; accounts: Record<string, Account>; settings: Settings }
export interface Settings {
  /** Account used when the agent does not name one and several exist. */
  readonly defaultAccount?: string
}
/** Per-install state, never exported: what GitHub told us about each account. */
interface LocalFile { format: "oc-runpod-local/1"; discovery: Record<string, Discovery> }

const empty = (): AccountsFile => ({ format: ACCOUNTS_FORMAT, revision: 0, accounts: {}, settings: {} })
const sorted = <T>(record: Record<string, T>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)

export class AccountStore {
  readonly path: string
  readonly localPath: string
  #file = empty()
  #local: LocalFile = { format: "oc-runpod-local/1", discovery: {} }
  #stamp = ""
  #serial = new Serial()
  #listeners = new Set<() => void>()

  private constructor(dir: string) {
    this.path = join(dir, "accounts.json")
    this.localPath = join(dir, "local.json")
  }

  static async open(dir: string): Promise<AccountStore> {
    await ensurePrivateDir(dir)
    const store = new AccountStore(dir)
    await store.reload()
    return store
  }

  async reload(): Promise<boolean> {
    const stamps = await Promise.all([this.path, this.localPath].map(async path => {
      try { const info = await stat(path); return `${info.mtimeMs}:${info.size}:${info.ino}` }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error }
    }))
    const stamp = stamps.join("|")
    if (stamp === this.#stamp) return false
    const file = await readJson<AccountsFile>(this.path) ?? empty()
    if (file.format !== ACCOUNTS_FORMAT || !file.accounts) throw new Error(`Unsupported accounts file: ${this.path}`)
    file.settings = { ...empty().settings, ...file.settings }
    this.#file = file
    this.#local = await readJson<LocalFile>(this.localPath) ?? { format: "oc-runpod-local/1", discovery: {} }
    const changed = this.#stamp !== ""
    this.#stamp = stamp
    if (changed) this.#emit()
    return true
  }

  /** Last loaded state without disk access (tool descriptions, synchronous hooks). */
  cached() {
    return { accounts: sorted(this.#file.accounts), settings: this.#file.settings, discovery: this.#local.discovery }
  }
  async list(): Promise<Account[]> { await this.reload(); return sorted(this.#file.accounts) }
  async get(id: string): Promise<Account | undefined> { await this.reload(); return this.#file.accounts[id] }
  async settings(): Promise<Settings> { await this.reload(); return this.#file.settings }
  async discovery(id: string): Promise<Discovery | undefined> { await this.reload(); return this.#local.discovery[id] }

  put(account: Account, rename?: string): Promise<Account> {
    const checked = normalizeAccount(account)
    return this.#mutate(file => {
      if (rename !== undefined && rename !== checked.id) {
        if (!file.accounts[rename]) throw new Error(`No account ${rename}`)
        if (file.accounts[checked.id]) throw new Error(`Account ${checked.id} already exists`)
        delete file.accounts[rename]
      }
      file.accounts[checked.id] = checked
      return checked
    }, local => {
      if (rename !== undefined && rename !== checked.id && local.discovery[rename]) {
        local.discovery[checked.id] = local.discovery[rename]!
        delete local.discovery[rename]
      }
    })
  }

  remove(id: string): Promise<boolean> {
    return this.#mutate(file => {
      if (!file.accounts[id]) return false
      delete file.accounts[id]
      if (file.settings.defaultAccount === id) file.settings = {}
      return true
    }, local => { delete local.discovery[id] })
  }

  setSettings(settings: Partial<Settings>): Promise<Settings> {
    return this.#mutate(file => {
      if (settings.defaultAccount !== undefined && settings.defaultAccount !== null && !file.accounts[settings.defaultAccount]) throw new Error(`No account ${settings.defaultAccount}`)
      file.settings = { ...file.settings, ...settings }
      if (!file.settings.defaultAccount) delete (file.settings as { defaultAccount?: string }).defaultAccount
      return file.settings
    })
  }

  setDiscovery(id: string, discovery: Discovery | undefined): Promise<void> {
    return this.#mutate(() => undefined, local => {
      if (discovery) local.discovery[id] = discovery
      else delete local.discovery[id]
    }, false)
  }

  async exportAll(): Promise<{ accounts: Record<string, Account>; settings: Settings }> {
    await this.reload()
    return structuredClone({ accounts: this.#file.accounts, settings: this.#file.settings })
  }

  importAll(input: { accounts: Record<string, Account>; settings?: Partial<Settings> }, replaceAll = false): Promise<void> {
    const accounts = Object.values(input.accounts).map(account => normalizeAccount(account, new Date(account.updatedAt ?? Date.now())))
    return this.#mutate(file => {
      if (replaceAll) file.accounts = {}
      for (const account of accounts) file.accounts[account.id] = account
      if (input.settings) file.settings = { ...file.settings, ...input.settings }
    }, local => { if (replaceAll) for (const id of Object.keys(local.discovery)) if (!accounts.some(account => account.id === id)) delete local.discovery[id] })
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #emit(): void { for (const listener of this.#listeners) { try { listener() } catch {} } }

  #mutate<T>(change: (file: AccountsFile) => T, changeLocal?: (local: LocalFile) => void, bump = true): Promise<T> {
    return this.#serial.run(() => withFileLock(this.path, async () => {
      this.#stamp = ""
      await this.reload()
      const file = structuredClone(this.#file)
      const local = structuredClone(this.#local)
      const result = change(file)
      changeLocal?.(local)
      if (bump) {
        file.revision += 1
        await atomicWrite(this.path, JSON.stringify(file, null, 2) + "\n")
      }
      if (JSON.stringify(local) !== JSON.stringify(this.#local)) await atomicWrite(this.localPath, JSON.stringify(local, null, 2) + "\n")
      this.#stamp = ""
      await this.reload()
      this.#emit()
      return result
    }))
  }
}
