import { createHash } from "node:crypto"
import { decryptBundle, diffRecords, encryptBundle, validName, type EntityPolicy, type SecretValue } from "oc-secure-kit"
import { CAPABILITIES, defaultEffect, mergeAccount, normalizeAccount, SECRET_NAMES, validAccountId, type Account } from "./model.js"
import type { AccountView, Effect, ImportPreview, StateView } from "./rpc.js"
import { PLUGIN_ID, type RunpodService } from "./service.js"

export const BUNDLE_VERSION = 1
interface BundlePayload { accounts: Record<string, Account>; defaultAccount?: string; permissions: Record<string, EntityPolicy>; secrets: SecretValue[] }

export interface AdminDeps {
  readonly service: RunpodService
  readonly agents: () => Promise<{ id: string; name: string; mode: string }[]>
  readonly root: (sessionID: string) => Promise<string>
  readonly cost?: { N: number; r: number; p: number }
}

/** Server side of the GUI: everything the agent may not do (permissions, sign-out, export/import). */
export function createAdmin(deps: AdminDeps) {
  const { service } = deps
  const requireAccount = async (id: string) => {
    const account = await service.store.get(id)
    if (!account) throw new Error(`No account ${id}`)
    return account
  }

  async function state(input: { sessionID?: string }): Promise<StateView> {
    const [accounts, settings, agents] = await Promise.all([service.store.list(), service.store.settings(), deps.agents().catch(() => [])])
    const doc = await service.policy.reload()
    const views: AccountView[] = await Promise.all(accounts.map(async account => {
      const discovery = await service.store.discovery(account.id)
      const signIn = service.signIns.get(account.id)
      return {
        id: account.id, auth: account.auth, ...(account.label && { label: account.label }), ...(account.team && { team: account.team }),
        ...(discovery?.balance !== undefined && { balance: discovery.balance }), ...(discovery?.pods !== undefined && { pods: discovery.pods }),
        ...(discovery?.running && { running: discovery.running }), ...(discovery?.sshKey && { sshKey: discovery.sshKey }),
        ...(discovery?.actions !== undefined && { actions: discovery.actions }), ...(discovery?.error && { error: discovery.error }),
        signedIn: await service.signedIn(account), isDefault: settings.defaultAccount === account.id,
        ...(signIn && signIn.status !== "done" && signIn.expiresAt > Date.now() - 60_000 && { signIn: { url: signIn.url, expiresAt: signIn.expiresAt, status: signIn.status, ...(signIn.error && { error: signIn.error }) } }),
      }
    }))
    let session: StateView["session"]
    if (input.sessionID) {
      const root = await deps.root(input.sessionID)
      session = { root, cells: (doc.sessions[root]?.entities ?? {}) as Record<string, Record<string, Effect>> }
    }
    const view = {
      revision: doc.revision, accounts: views, agents,
      defaults: Object.fromEntries(CAPABILITIES.map(capability => [capability, defaultEffect(capability)])),
      cells: Object.fromEntries(Object.entries(doc.entities).map(([entity, policy]) => [entity, policy.agents])) as StateView["cells"],
      ...(session && { session }),
    }
    return { ...view, fingerprint: createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 16) }
  }

  async function setCells(input: { expectedRevision?: number; sessionID?: string; changes: { entity: string; capability: string; effect: Effect | null; agent?: string; session?: boolean }[] }) {
    const ids = new Set((await service.store.list()).map(account => account.id))
    let root: string | undefined
    const changes = []
    for (const change of input.changes) {
      if (!ids.has(change.entity)) throw new Error(`Unknown account ${change.entity}`)
      if (!(CAPABILITIES as readonly string[]).includes(change.capability)) throw new Error(`Unknown permission ${change.capability}`)
      if (change.session) {
        if (!input.sessionID) throw new Error("A session is needed for the This session row")
        root ??= await deps.root(input.sessionID)
        changes.push({ entity: change.entity, capability: change.capability, effect: change.effect, row: { session: root } })
      } else {
        if (!change.agent) throw new Error("agent is required")
        changes.push({ entity: change.entity, capability: change.capability, effect: change.effect, row: { agent: change.agent } })
      }
    }
    await service.policy.setCells(changes, input.expectedRevision)
    return state({ ...(input.sessionID && { sessionID: input.sessionID }) })
  }

  async function createAccount(input: { id: string; auth?: "browser" | "apikey"; team?: string }) {
    validAccountId(input.id)
    if (await service.store.get(input.id)) throw new Error(`Account ${input.id} already exists`)
    const account = await service.store.put(normalizeAccount({ id: input.id, ...(input.auth && { auth: input.auth }), ...(input.team && { team: input.team }) }))
    return { created: account.id, auth: account.auth }
  }

  async function setTeam(input: { id: string; team: string | null }) {
    const account = await requireAccount(input.id)
    const saved = await service.store.put(normalizeAccount(mergeAccount(account, { team: input.team || null })))
    return { team: saved.team ?? null }
  }

  async function setKey(input: { id: string; key: string }) {
    const account = await requireAccount(input.id)
    await service.setApiKey(account, input.key)
    const discovery = await service.rediscover(account)
    return { balance: discovery.balance ?? null, pods: discovery.pods ?? null, ...(discovery.error && { error: discovery.error }) }
  }

  async function registerSshKey(input: { id: string }) {
    const account = await requireAccount(input.id)
    const added = await service.registerSshKey(account)
    await service.rediscover(account)
    return { added }
  }

  async function removeAccount(input: { id: string }) {
    const account = await requireAccount(input.id)
    service.signIns.get(account.id)?.flow.cancel()
    service.signIns.delete(account.id)
    await service.store.remove(account.id)
    await service.vault.deleteEntity(account.id)
    await service.policy.removeEntity(account.id)
    return { removed: account.id }
  }

  async function exportBundle(input: { passphrase: string }) {
    const { accounts, settings } = await service.store.exportAll()
    const ids = Object.keys(accounts)
    const payload: BundlePayload = {
      accounts, ...(settings.defaultAccount && { defaultAccount: settings.defaultAccount }),
      permissions: await service.policy.exportEntities(ids),
      secrets: (await service.vault.values()).filter(item => ids.includes(item.entity)),
    }
    const content = await encryptBundle({ plugin: PLUGIN_ID, schemaVersion: BUNDLE_VERSION, payload }, input.passphrase, deps.cost ? { cost: deps.cost } : {})
    return { name: `oc-runpod-${new Date().toISOString().slice(0, 10)}.ocbundle`, content, counts: { accounts: ids.length, secrets: payload.secrets.length } }
  }

  async function open(content: string, passphrase: string) {
    const { payload: raw, header } = await decryptBundle<BundlePayload>(content, passphrase, { plugin: PLUGIN_ID, currentVersion: BUNDLE_VERSION })
    if (!raw?.accounts || typeof raw.accounts !== "object") throw new Error("Invalid bundle contents")
    const accounts = Object.fromEntries(Object.values(raw.accounts).map(item => { const account = normalizeAccount(item, new Date(item.updatedAt ?? Date.now())); return [account.id, account] }))
    const permissions = (raw.permissions ?? {}) as Record<string, EntityPolicy>
    for (const entity of Object.keys(permissions)) if (!accounts[entity]) throw new Error(`Bundle has permissions for unknown ${entity}`)
    if (!Array.isArray(raw.secrets)) throw new Error("Invalid secrets")
    const secrets = raw.secrets.map(item => {
      if (!accounts[item?.entity] || !(SECRET_NAMES as readonly string[]).includes(item?.name) || typeof item.value !== "string" || !item.value) throw new Error(`Bundle has an unexpected secret for ${item?.entity}`)
      validName("account", item.entity)
      return { entity: item.entity, name: item.name, value: item.value }
    })
    return { payload: { accounts, ...(raw.defaultAccount && accounts[raw.defaultAccount] && { defaultAccount: raw.defaultAccount }), permissions, secrets }, createdAt: header.createdAt }
  }

  async function previewImport(input: { content: string; passphrase: string }): Promise<ImportPreview> {
    const { payload, createdAt } = await open(input.content, input.passphrase)
    const current = await service.store.exportAll()
    const strip = (items: Record<string, Account>) => Object.fromEntries(Object.entries(items).map(([id, { updatedAt: _, ...rest }]) => [id, rest]))
    return { createdAt, accounts: diffRecords(strip(current.accounts), strip(payload.accounts)), secrets: payload.secrets.length, permissionEntities: Object.keys(payload.permissions).length }
  }

  async function applyImport(input: { content: string; passphrase: string; mode: "merge" | "replace" }) {
    const { payload } = await open(input.content, input.passphrase)
    if (input.mode === "replace") for (const account of await service.store.list()) { await service.vault.deleteEntity(account.id); await service.policy.removeEntity(account.id) }
    await service.store.importAll({ accounts: payload.accounts, ...(payload.defaultAccount && { settings: { defaultAccount: payload.defaultAccount } }) }, input.mode === "replace")
    await service.vault.importValues(payload.secrets, [...new Set(payload.secrets.map(item => item.entity))])
    await service.policy.importEntities(payload.permissions)
    await service.refreshRedactor()
    for (const account of Object.values(payload.accounts)) void service.rediscover(account).catch(() => {})
    return { imported: { accounts: Object.keys(payload.accounts).length, secrets: payload.secrets.length }, mode: input.mode }
  }

  return {
    state, setCells, createAccount, setTeam, setKey, registerSshKey, removeAccount, exportBundle, previewImport, applyImport,
    signIn: async (input: { id: string }) => { const started = await service.startSignIn(await requireAccount(input.id)); return { url: started.url, expiresAt: started.expiresAt } },
    completeSignIn: async (input: { id: string; url: string }) => {
      const running = service.signIns.get(input.id)
      if (!running || running.status !== "waiting") throw new Error("No sign-in is waiting for this account; start it again")
      running.flow.complete(input.url)
      return { submitted: true }
    },
    cancelSignIn: async (input: { id: string }) => {
      const running = service.signIns.get(input.id)
      running?.flow.cancel()
      service.signIns.delete(input.id)
      return { cancelled: !!running }
    },
    refresh: async (input: { id: string }) => { const discovery = await service.rediscover(await requireAccount(input.id)); return { balance: discovery.balance ?? null, ...(discovery.error && { error: discovery.error }) } },
    signOut: async (input: { id: string }) => { await service.signOut(await requireAccount(input.id)); return { signedOut: input.id } },
    setDefault: async (input: { id: string | null }) => ({ defaultAccount: (await service.store.setSettings({ defaultAccount: input.id ?? undefined })).defaultAccount ?? null }),
  }
}
