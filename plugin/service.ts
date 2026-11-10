import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { McpClient, PolicyStore, Redactor, startBrowserSignIn, Vault, type BrowserSignIn, type McpToolInfo, type PermissionBridge } from "oc-secure-kit"
import { API_KEY, DEFAULT_API, DEFAULT_MCP, SECRET_NAMES, SSH_KEY, type Account, type Discovery, type PodSummary } from "./model.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-runpod"
export const VERSION = "0.1.0"
const SERVICE = "Runpod"
const run = promisify(execFile)

export interface SignInState {
  readonly account: string
  readonly url: string
  readonly expiresAt: number
  status: "waiting" | "done" | "failed"
  error?: string
  readonly flow: BrowserSignIn
}

interface Catalog { readonly tools: McpToolInfo[]; readonly at: number }
const CATALOG_TTL = 6 * 60 * 60_000

/** A pod as RunPod's API returns it (only the fields the plugin uses). */
export interface PodRecord {
  readonly id: string
  readonly name?: string
  readonly status?: string
  readonly cost?: number | { perHr?: number; total?: number } | null
  readonly gpu?: { id?: string; count?: number } | null
  readonly startedAt?: string | null
  readonly ssh?: {
    readonly direct?: { readonly host: string; readonly port: number; readonly username?: string; readonly command?: string } | null
    readonly proxy?: { readonly host: string; readonly port: number; readonly username: string; readonly command?: string } | null
  } | null
}

export const costPerHr = (pod: PodRecord): number | undefined =>
  typeof pod.cost === "number" ? pod.cost : typeof pod.cost?.perHr === "number" ? pod.cost.perHr : undefined

export const summarize = (pod: PodRecord): PodSummary => ({
  id: pod.id, name: pod.name ?? pod.id, status: pod.status ?? "unknown",
  ...(costPerHr(pod) !== undefined && { costPerHr: costPerHr(pod) }),
  ...(pod.gpu?.id && { gpu: `${pod.gpu.count ?? 1}× ${pod.gpu.id}` }), ...(pod.startedAt && { startedAt: pod.startedAt }),
})

/** Accounts, vault, permissions, sign-in and per-account connections of one data directory. */
export class RunpodService {
  readonly redactor = new Redactor()
  readonly signIns = new Map<string, SignInState>()
  #bridge?: PermissionBridge
  #redactorStale = false
  #mcp = new Map<string, McpClient>()
  #catalog = new Map<string, Catalog>()

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    readonly mcpUrl: string,
    readonly apiUrl: string,
  ) {}

  static async open(dir: string, options: { mcpUrl?: string; apiUrl?: string } = {}): Promise<RunpodService> {
    const [store, vault, policy] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir)])
    const service = new RunpodService(dir, store, vault, policy, options.mcpUrl ?? DEFAULT_MCP, (options.apiUrl ?? DEFAULT_API).replace(/\/+$/, ""))
    await service.refreshRedactor()
    vault.onChange(() => { service.#redactorStale = true })
    store.onChange(() => { service.#mcp.clear(); service.#catalog.clear() })
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }

  async pick(id: string | undefined): Promise<Account> {
    const accounts = await this.store.list()
    if (id) {
      const found = accounts.find(account => account.id === id || account.team?.toLowerCase() === id.toLowerCase())
      if (!found) throw new Error(`No RunPod account ${JSON.stringify(id)}. Accounts: ${accounts.map(account => `${account.id}${account.team ? ` (${account.team})` : ""}`).join(", ") || "(none; create one with runpod_account_upsert)"}`)
      return found
    }
    if (accounts.length === 1) return accounts[0]!
    const fallback = (await this.store.settings()).defaultAccount
    if (fallback) { const found = accounts.find(account => account.id === fallback); if (found) return found }
    if (!accounts.length) throw new Error("No RunPod account is configured yet. Create one with runpod_account_upsert, then runpod_signin.")
    throw new Error(`Several RunPod accounts exist (${accounts.map(account => `${account.id}${account.team ? ` = ${account.team}` : ""}`).join(", ")}). Pass account=<id>; decide from the conversation or ask the user.`)
  }

  // ------------------------------------------------------------------ credentials

  async apiKey(account: Account): Promise<string> {
    const key = await this.vault.get(account.id, API_KEY)
    if (!key) throw new Error(account.auth === "browser"
      ? `${account.id} is not signed in to RunPod. Call runpod_signin account=${account.id} and give the user the link.`
      : `${account.id} has no API key yet: ask the user to enter it in OpenCode's RunPod view (Settings → RunPod) or with: pixi run key-set ${account.id}`)
    return key
  }

  async signedIn(account: Account): Promise<boolean> { return this.vault.has(account.id, API_KEY) }

  async setApiKey(account: Account, key: string): Promise<void> {
    await this.vault.set(account.id, API_KEY, key.trim())
    this.#mcp.delete(account.id)
    this.#catalog.delete(account.id)
    await this.refreshRedactor()
  }

  // ------------------------------------------------------------------ actions (MCP) and REST

  mcp(account: Account): McpClient {
    let client = this.#mcp.get(account.id)
    if (!client) {
      client = new McpClient(this.mcpUrl, { authorization: async () => `Bearer ${await this.apiKey(account)}`, clientName: PLUGIN_ID, clientVersion: VERSION, service: SERVICE })
      this.#mcp.set(account.id, client)
    }
    return client
  }

  async actions(account: Account, fresh = false): Promise<McpToolInfo[]> {
    const cached = this.#catalog.get(account.id)
    if (cached && !fresh && Date.now() - cached.at < CATALOG_TTL) return cached.tools
    const tools = await this.mcp(account).listTools()
    this.#catalog.set(account.id, { tools, at: Date.now() })
    return tools
  }

  /** Calls the REST API (paths like /v2/pods). Throws with RunPod's message on errors. */
  async rest<T = unknown>(account: Account, method: string, path: string, init: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.apiUrl}${path.startsWith("/") ? path : `/${path}`}`)
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: { authorization: `Bearer ${await this.apiKey(account)}`, accept: "application/json", ...(init.body !== undefined && { "content-type": "application/json" }) },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : undefined
    if (!response.ok) throw new Error(`RunPod ${method.toUpperCase()} ${url.pathname} → ${response.status}: ${typeof data === "object" ? JSON.stringify(data).slice(0, 1200) : String(data ?? "").slice(0, 400)}`)
    return data as T
  }

  async pods(account: Account): Promise<PodRecord[]> {
    const pods: PodRecord[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const data = await this.rest<{ pods?: PodRecord[]; pagination?: { hasNextPage?: boolean; nextCursor?: string | null } }>(account, "GET", "/v2/pods", { query: { limit: 500, ...(cursor && { cursor }) } })
      pods.push(...(data.pods ?? []))
      if (!data.pagination?.hasNextPage || !data.pagination.nextCursor) break
      cursor = data.pagination.nextCursor
    }
    return pods
  }

  /** Account balance and spend limit through the GraphQL API (best effort). */
  async balance(account: Account): Promise<{ balance?: number; spendLimit?: number; perHour?: number }> {
    try {
      const response = await fetch(`${this.apiUrl}/graphql`, {
        method: "POST", headers: { authorization: `Bearer ${await this.apiKey(account)}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "query { myself { clientBalance currentSpendPerHr spendLimit } }" }),
      })
      const data = await response.json() as { data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number; spendLimit?: number } } }
      const me = data.data?.myself
      return { ...(typeof me?.clientBalance === "number" && { balance: me.clientBalance }), ...(typeof me?.spendLimit === "number" && { spendLimit: me.spendLimit }), ...(typeof me?.currentSpendPerHr === "number" && { perHour: me.currentSpendPerHr }) }
    } catch { return {} }
  }

  // ------------------------------------------------------------------ SSH key

  /** The account's plugin SSH key (generated on first use); returns the public key line. */
  async sshPublicKey(account: Account): Promise<string> {
    let key = await this.vault.get(account.id, SSH_KEY)
    if (!key) {
      const dir = await mkdtemp(join(tmpdir(), "ocrp-"))
      try {
        await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `oc-runpod:${account.id}`, "-f", join(dir, "key")])
        key = await readFile(join(dir, "key"), "utf8")
      } finally { await rm(dir, { recursive: true, force: true }) }
      await this.vault.set(account.id, SSH_KEY, key)
      await this.refreshRedactor()
    }
    return publicKeyOf(key, `oc-runpod:${account.id}`)
  }

  /** Adds the plugin's key to the account's RunPod SSH keys, keeping every other key. Returns whether it changed. */
  async registerSshKey(account: Account): Promise<boolean> {
    const mine = await this.sshPublicKey(account)
    const current = (await this.rest<{ keys?: string[] }>(account, "GET", "/v2/user/ssh-keys").catch(() => undefined))?.keys
      ?? JSON.parse((await this.mcp(account).call("get-ssh-keys", {})).text || "{}").keys ?? []
    const body = mine.split(" ").slice(0, 2).join(" ")
    if (current.some((line: string) => line.split(" ").slice(0, 2).join(" ") === body)) return false
    const result = await this.mcp(account).call("update-ssh-keys", { body: { keys: [...current, mine] } })
    if (result.isError) throw new Error(`Could not add the SSH key: ${result.text.slice(0, 400)}`)
    return true
  }

  // ------------------------------------------------------------------ discovery and sign-in

  async rediscover(account: Account): Promise<Discovery> {
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    try {
      const client = this.mcp(account)
      const info = await client.initialize()
      const tools = await this.actions(account, true)
      const [pods, money, keys] = await Promise.all([
        this.pods(account),
        this.balance(account),
        client.call("get-ssh-keys", {}).then(result => JSON.parse(result.text || "{}").keys as string[] | undefined).catch(() => undefined),
      ])
      const stored = await this.vault.get(account.id, SSH_KEY)
      const mine = stored ? publicKeyOf(stored).split(" ").slice(0, 2).join(" ") : undefined
      discovery = {
        ...(money.balance !== undefined && { balance: Math.round(money.balance * 100) / 100 }), ...(money.spendLimit !== undefined && { spendLimit: money.spendLimit }),
        pods: pods.length, running: pods.filter(pod => pod.status === "RUNNING").map(summarize), actions: tools.length,
        ...(info.instructions && { instructions: info.instructions.slice(0, 20_000) }),
        ...(keys && { sshKey: mine && keys.some(line => line.startsWith(mine)) ? "registered" as const : "missing" as const }),
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      discovery = { ...(previous ?? {}), error: (error as Error).message.slice(0, 500), checkedAt: new Date().toISOString() }
    }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  async startSignIn(account: Account): Promise<SignInState> {
    if (account.auth !== "browser") throw new Error(`${account.id} uses an API key you enter; browser sign-in is for auth=browser`)
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.flow.cancel()
    const flow = await startBrowserSignIn(this.mcpUrl, { clientName: "OpenCode (oc-runpod)", service: SERVICE, scopes: () => [] })
    const state: SignInState = { account: account.id, url: flow.url, expiresAt: flow.expiresAt, status: "waiting", flow }
    this.signIns.set(account.id, state)
    flow.done
      .then(async ({ grant }) => { await this.setApiKey(account, grant.accessToken); await this.rediscover(account); state.status = "done" })
      .catch(error => { if (state.status === "waiting") { state.status = "failed"; state.error = (error as Error).message } })
    return state
  }

  async signOut(account: Account): Promise<void> {
    await this.vault.delete(account.id, API_KEY)
    await this.store.setDiscovery(account.id, undefined)
    this.#mcp.delete(account.id)
    this.#catalog.delete(account.id)
    await this.refreshRedactor()
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }
  async refreshRedactor(): Promise<void> {
    this.redactor.replaceAll((await this.vault.values()).filter(item => (SECRET_NAMES as readonly string[]).includes(item.name)).map(item => [`${item.entity}/${item.name}`, item.value] as const))
  }

  dispose(): void { for (const state of this.signIns.values()) state.flow.cancel() }
}

/** Public key line of an OpenSSH ed25519 private key (parsed directly; no ssh-keygen needed). */
export function publicKeyOf(privateKey: string, comment?: string): string {
  const body = Buffer.from(privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64")
  // openssh-key-v1\0, ciphername, kdfname, kdfoptions, nkeys(uint32), then the public key blob.
  let offset = 15
  const string = () => { const length = body.readUInt32BE(offset); const value = body.subarray(offset + 4, offset + 4 + length); offset += 4 + length; return value }
  string(); string(); string()
  offset += 4
  const blob = string()
  const type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString()
  const comm = comment ?? ""
  return `${type} ${blob.toString("base64")}${comm ? ` ${comm}` : ""}`
}
