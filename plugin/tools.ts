import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { McpToolInfo } from "oc-secure-kit"
import { API_KEY, classifyAction, classifyRest, mergeAccount, podAlias, normalizeAccount, validAccountId, type Account, type Discovery } from "./model.js"
import { keyBody, SSH_CONFIG_VAR, STATE_HELP, type PodDirectory } from "./podssh.js"
import { costPerHr, publicKeyOf, type RunpodService } from "./service.js"

export const TOOL_NAMES = [
  "runpod_list", "runpod_find_actions", "runpod_run", "runpod_rest", "runpod_ssh_setup",
  "runpod_account_upsert", "runpod_account_remove", "runpod_signin", "runpod_refresh", "runpod_request_key",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

const MAX_OUTPUT = 60_000
const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const ACCOUNT = { type: "string", description: "Account id or team name (optional when there is only one account)" }

export const USAGE = [
  "Load the 'runpod' skill before non-trivial RunPod work (pods, GPUs, serverless, volumes, SSH).",
  "Manage: runpod_find_actions (keyword, then names=[...] for parameters) → runpod_run. runpod_rest for any REST v2 path.",
  `Work inside a running pod with your shell: ssh -F "$${SSH_CONFIG_VAR}" <alias> 'cmd'; rsync -e "ssh -F '$${SSH_CONFIG_VAR}'" src <alias>:dst. Aliases are listed below; runpod_ssh_setup fixes pods that are not ready.`,
  "Pods cost money while running: state the hourly price before creating or starting one, and stop pods you started when the work is done.",
].join("\n")

const hours = (since?: string) => since ? Math.max(0, (Date.now() - Date.parse(since)) / 3_600_000) : undefined
const money = (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString("en-US")}`

function describe(account: Account, discovery: Discovery | undefined): string[] {
  const head = `  ${account.id}${account.team ? ` (${account.team})` : ""}: ${discovery?.checkedAt ? `balance ${discovery.balance !== undefined ? money(discovery.balance) : "?"}, ${discovery.pods ?? "?"} pods` : "not signed in"}${account.label ? ` — ${account.label}` : ""}${discovery?.sshKey === "missing" ? "; plugin SSH key not registered (runpod_ssh_setup)" : ""}${discovery?.error ? ` [problem: ${discovery.error.slice(0, 140)}]` : ""}`
  const running = (discovery?.running ?? []).map(pod => {
    const up = hours(pod.startedAt)
    return `    running: ${pod.name} (${pod.id}${pod.gpu ? `, ${pod.gpu}` : ""}${pod.costPerHr !== undefined ? `, ${money(pod.costPerHr)}/hr` : ""}${up !== undefined ? `, up ${up < 1 ? `${Math.round(up * 60)}m` : `${up.toFixed(1)}h`}` : ""}) ssh alias ${podAlias(account.id, pod)}`
  })
  return [head, ...running.slice(0, 15), ...(running.length > 15 ? [`    …and ${running.length - 15} more running`] : [])]
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>): string {
  if (!accounts.length) return "No RunPod accounts are configured yet. Create one with runpod_account_upsert, then runpod_signin."
  const burn = accounts.reduce((sum, account) => sum + (discovery[account.id]?.running ?? []).reduce((s, pod) => s + (pod.costPerHr ?? 0), 0), 0)
  return ["RunPod accounts (each is a personal account or a team):", ...accounts.flatMap(account => describe(account, discovery[account.id])),
    ...(burn > 0 ? [`  Running pods cost ${money(burn)}/hr in total (as of the last check). Stop pods you started once their work is done.`] : [])].join("\n")
}

export function searchActions(tools: readonly McpToolInfo[], query: string): McpToolInfo[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1).map(word => word.replace(/s$/, ""))
  if (!words.length) return [...tools]
  const phrase = query.toLowerCase().trim()
  const score = (tool: McpToolInfo) => {
    const name = tool.name.toLowerCase(), text = `${name} ${(tool.description ?? "").toLowerCase()}`
    return words.reduce((sum, word) => sum + (name.includes(word) ? 3 : text.includes(word) ? 1 : 0), 0) + (words.length > 1 && text.includes(phrase) ? 4 : 0)
  }
  return tools.map(tool => [tool, score(tool)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([tool]) => tool)
}

const clip = (text: string) => text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} characters; narrow the request (limit, a single id)]` : text
const summarize = (value: unknown) => { const text = JSON.stringify(value); return text.length > 400 ? `${text.slice(0, 400)}…` : text }
/** Pod env values can hold secrets; the agent sees names only. */
function hideEnv(text: string): string {
  try {
    const data = JSON.parse(text)
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit)
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) =>
        key === "env" && inner && typeof inner === "object" && !Array.isArray(inner) ? [key, Object.fromEntries(Object.keys(inner).map(name => [name, "(hidden)"]))] : [key, visit(inner)]))
      return value
    }
    return JSON.stringify(visit(data), null, 2)
  } catch { return text }
}

export function createTools(service: RunpodService, pods: PodDirectory): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })
  /** After changes to pods, refresh what the inventory shows. */
  const changed = (account: Account) => { pods.invalidate(account.id); void service.rediscover(account).catch(() => {}) }

  return [
    {
      name: "runpod_list",
      description: () => {
        const { accounts, discovery } = service.store.cached()
        return `${inventory(accounts, discovery)}\n${USAGE}\nCall this tool for live details and what you may do (allow / ask = the user is prompted / deny).`
      },
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }, context) => {
        const settings = await service.store.settings()
        const chosen = input.account ? [await service.pick(input.account)] : await service.store.list()
        const accounts = await Promise.all(chosen.map(async account => {
          const signedIn = await service.signedIn(account)
          const discovery = signedIn ? await service.rediscover(account) : await service.store.discovery(account.id)
          const live = signedIn ? await pods.pods(account, true).catch(() => []) : []
          const running = await Promise.all(live.filter(pod => pod.status === "RUNNING").map(async pod => {
            const ssh = await pods.describe(account, pod)
            return { id: pod.id, name: pod.name, gpu: pod.gpu?.id ? `${pod.gpu.count ?? 1}× ${pod.gpu.id}` : "CPU", costPerHr: costPerHr(pod), startedAt: pod.startedAt, ssh: { alias: ssh.alias, state: ssh.state, ...(ssh.state !== "ready" && { fix: STATE_HELP[ssh.state] }) } }
          }))
          const may = Object.fromEntries(await Promise.all(["pods-read", "pods-write", "pods-spend", "pods-delete", "serverless-spend", "storage-spend", "ssh"].map(async capability =>
            [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const)))
          const signIn = service.signIns.get(account.id)
          return {
            id: account.id, ...(account.team && { team: account.team }), ...(account.label && { label: account.label }), auth: account.auth, signedIn,
            ...(discovery?.balance !== undefined && { balance: discovery.balance }), pods: live.length || discovery?.pods || 0,
            stoppedPods: live.filter(pod => pod.status !== "RUNNING").length, running, ...(discovery?.sshKey && { pluginSshKey: discovery.sshKey }),
            ...(signIn?.status === "waiting" && { signIn: `waiting for the user: ${signIn.url}` }), ...(discovery?.error && { problem: discovery.error }),
            ...(settings.defaultAccount === account.id && { default: true }), youMay: may,
          }
        }))
        return json({ accounts, usage: USAGE })
      },
    },
    {
      name: "runpod_find_actions",
      description: () => "Find RunPod actions by keyword, e.g. 'create pod', 'gpu types', 'serverless endpoint', 'network volume', 'billing', 'logs'. Returns names, permission kind and summaries; pass names=[...] for exact parameters (some are only available that way) before runpod_run.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, query: { type: "string", maxLength: 200 }, names: { type: "array", items: { type: "string" }, maxItems: 20 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      execute: async (input: { account?: string; query?: string; names?: string[]; limit?: number }) => {
        const account = await service.pick(input.account)
        const tools = await service.actions(account)
        if (input.names?.length) {
          return json({ account: account.id, actions: await Promise.all(input.names.map(async name => {
            const tool = tools.find(item => item.name === name)
            if (!tool) return { name, missing: true }
            let parameters = tool.inputSchema
            // Some actions list a stub schema and serve the full one on demand.
            if (JSON.stringify(parameters ?? {}).length < 120 && tools.some(item => item.name === "describe-tool")) {
              const full = await service.mcp(account).call("describe-tool", { name }).catch(() => undefined)
              try { if (full && !full.isError) parameters = (JSON.parse(full.text) as { inputSchema?: unknown }).inputSchema ?? JSON.parse(full.text) } catch {}
            }
            return { name: tool.name, kind: classifyAction(tool.name, tool.annotations as never), description: tool.description, parameters }
          })) })
        }
        const matches = searchActions(tools, input.query ?? "").slice(0, input.limit ?? 25)
        return json({
          account: account.id, total: tools.length,
          actions: matches.map(tool => ({ name: tool.name, kind: classifyAction(tool.name, tool.annotations as never), summary: (tool.description ?? "").replace(/\s+/g, " ").slice(0, 240) })),
          next: "Call runpod_find_actions names=[...] for parameters, then runpod_run.",
        })
      },
    },
    {
      name: "runpod_run",
      description: () => "Run a RunPod action found with runpod_find_actions, e.g. action='list-gpu-types' arguments={}, action='pod-action' arguments={id:'abc', body:{action:'stop'}}. Creating or starting billable resources, deleting and admin changes may ask the user first.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, action: { type: "string", minLength: 1, maxLength: 120 }, arguments: { type: "object", additionalProperties: true } },
        required: ["action"], additionalProperties: false,
      },
      execute: async (input: { account?: string; action: string; arguments?: Record<string, unknown> }, context) => {
        const account = await service.pick(input.account)
        const tools = await service.actions(account)
        const tool = tools.find(item => item.name === input.action)
        if (!tool) {
          const near = searchActions(tools, input.action.replace(/[-_]/g, " ")).slice(0, 5).map(item => item.name)
          throw new Error(`No action ${JSON.stringify(input.action)}.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use runpod_find_actions.`)
        }
        const args = input.arguments ?? {}
        await check(context, classifyAction(tool.name, tool.annotations as never, args), account.id, { action: tool.name, arguments: summarize(args), account: account.team ?? account.id })
        const result = await service.mcp(account).call(tool.name, args)
        if (/pod|cluster/.test(tool.name) && tool.annotations?.readOnlyHint !== true) changed(account)
        if (result.isError) throw new Error(`${tool.name} failed: ${clip(hideEnv(result.text))}`)
        return { content: clip(hideEnv(result.text) || "(no output)") }
      },
    },
    {
      name: "runpod_rest",
      description: () => "Call any RunPod REST v2 endpoint (base https://api.runpod.io, paths start with /v2), e.g. GET /v2/pods, GET /v2/catalog/gpus, POST /v2/pods/{id}/action {action:'stop'}. Use when no action fits.",
      input: {
        type: "object",
        properties: {
          account: ACCOUNT, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string", minLength: 1, maxLength: 2000 },
          query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } }, body: {},
        },
        required: ["method", "path"], additionalProperties: false,
      },
      execute: async (input: { account?: string; method: string; path: string; query?: Record<string, unknown>; body?: unknown }, context) => {
        const account = await service.pick(input.account)
        if (/^https?:/.test(input.path) || !input.path.startsWith("/")) throw new Error("path must start with /, e.g. /v2/pods")
        await check(context, classifyRest(input.method, input.path, input.body), account.id, { request: `${input.method} ${input.path}`, ...(input.body !== undefined && { body: summarize(input.body) }), account: account.team ?? account.id })
        const data = await service.rest(account, input.method, input.path, { ...(input.query && { query: input.query }), ...(input.body !== undefined && { body: input.body }) })
        if (input.method !== "GET" && /pods|clusters/.test(input.path)) changed(account)
        return { content: clip(hideEnv(JSON.stringify(data ?? { ok: true }, null, 2))) }
      },
    },
    {
      name: "runpod_ssh_setup",
      description: () => `Prepare SSH into pods. Without pod: adds the plugin's SSH key to the account's RunPod SSH keys (keeps every other key), so pods created afterwards with startSsh accept it. With pod: also makes that pod reachable (exposes 22/tcp and adds the key to its PUBLIC_KEY), which RESTARTS the pod — files outside its volume are lost. Then use: ssh -F "$${SSH_CONFIG_VAR}" <alias>.`,
      input: { type: "object", properties: { account: ACCOUNT, pod: { type: "string", description: "Pod id, name or alias (optional)" } }, additionalProperties: false },
      execute: async (input: { account?: string; pod?: string }, context) => {
        const account = await service.pick(input.account)
        const key = await service.sshPublicKey(account)
        const current = JSON.parse((await service.mcp(account).call("get-ssh-keys", {})).text || "{}").keys as string[] | undefined ?? []
        let registered = false
        if (!current.some(line => keyBody(line) === keyBody(key))) {
          await check(context, "account-admin", account.id, { operation: "add the plugin's SSH key to the account's SSH keys (other keys are kept)", account: account.team ?? account.id })
          registered = await service.registerSshKey(account)
        }
        const result: Record<string, unknown> = { account: account.id, accountKey: registered ? "added" : "already registered" }
        if (input.pod) {
          const pod = await pods.find(account, input.pod)
          const detail = await service.rest<{ env?: Record<string, string>; ports?: string[] }>(account, "GET", `/v2/pods/${pod.id}`)
          const ports = detail.ports ?? []
          const keys = detail.env?.PUBLIC_KEY ?? ""
          const needsKey = !keys.includes(keyBody(key).split(" ")[1]!)
          const needsPort = !ports.includes("22/tcp")
          if (needsKey || needsPort) {
            await check(context, "pods-admin", account.id, { operation: `make pod ${pod.name ?? pod.id} reachable over SSH (restarts it; files outside its volume are lost)`, pod: pod.id })
            await service.rest(account, "PATCH", `/v2/pods/${pod.id}`, { body: {
              ...(needsPort && { ports: [...ports, "22/tcp"] }),
              ...(needsKey && { env: { ...(detail.env ?? {}), PUBLIC_KEY: [keys.trim(), key].filter(Boolean).join("\n") } }),
            } })
            pods.invalidate(account.id)
            result.pod = { id: pod.id, changed: [needsPort && "exposed 22/tcp", needsKey && "added the plugin key"].filter(Boolean), note: "The pod restarts; it may take a minute before SSH works." }
          } else result.pod = { id: pod.id, changed: [], note: "Already set up." }
          const ssh = await pods.describe(account, await pods.find(account, pod.id))
          result.alias = ssh.alias
          result.use = `ssh -F "$${SSH_CONFIG_VAR}" ${ssh.alias} 'nvidia-smi'`
        }
        changed(account)
        return json(result)
      },
    },
    {
      name: "runpod_account_upsert",
      description: () => "Create or update a RunPod account (fields merge; null clears). One per RunPod account or team you can switch to in the console. team: its name in the console's account menu. auth: browser (sign in; recommended) or apikey (the user enters a key). Never pass keys here.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Name chosen by the user, e.g. personal or team" },
          rename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
          auth: { type: "string", enum: ["browser", "apikey"] }, team: { type: ["string", "null"] },
          label: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
        },
        required: ["id"], additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) { await service.vault.renameEntity(id, target); await service.policy.renameEntity(id, target) }
        const signedIn = await service.signedIn(saved)
        return json({ saved, signedIn, ...(!signedIn && { next: saved.auth === "browser" ? `sign in: runpod_signin account=${saved.id}` : `ask for the key: runpod_request_key account=${saved.id}` }) })
      },
    },
    {
      name: "runpod_account_remove",
      description: () => "Delete a RunPod account from this plugin with its stored key and permission settings. Asks the user by default. Does not change anything in RunPod (the API key stays valid until deleted in the console).",
      input: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
      execute: async (input: { account: string }, context) => {
        const account = await service.pick(input.account)
        await check(context, "remove", account.id)
        service.signIns.get(account.id)?.flow.cancel()
        service.signIns.delete(account.id)
        await service.store.remove(account.id)
        await service.vault.deleteEntity(account.id)
        await service.policy.removeEntity(account.id)
        return json({ removed: account.id, note: "Its RunPod API key still exists; delete it in the RunPod console (Settings → API keys) if no longer needed." })
      },
    },
    {
      name: "runpod_signin",
      description: () => "Start the browser sign-in to RunPod for an account (auth=browser). Returns a link and steps for the user; it completes in the background once they authorize. wait blocks up to that many seconds.",
      input: { type: "object", properties: { account: ACCOUNT, wait: { type: "integer", minimum: 0, maximum: 600 } }, additionalProperties: false },
      execute: async (input: { account?: string; wait?: number }, context) => {
        const account = await service.pick(input.account)
        await check(context, "manage", account.id, { operation: "sign in" })
        const state = await service.startSignIn(account)
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (state.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = state.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, status: state.status,
          ...(state.status === "waiting" && { tellUser: `1) In the RunPod console (console.runpod.io), open the account menu (top right) and select ${account.team ? `"${account.team}"` : "the account or team this should use"}. 2) Open this link on this computer and click Authorize: ${state.url}  — or click Sign in in OpenCode's RunPod view. RunPod creates an API key for that account/team.` }),
          ...(state.error && { error: state.error }),
          ...(discovery && { balance: discovery.balance, pods: discovery.pods, running: discovery.running?.length ?? 0, ...(discovery.error && { problem: discovery.error }), check: "Confirm with the user that this is the intended account/team (balance and pods above)." }),
        })
      },
    },
    {
      name: "runpod_refresh",
      description: () => "Check an account again: balance, pods, running pods, SSH key (after the user signed in or something changed).",
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }) => {
        const account = await service.pick(input.account)
        pods.invalidate(account.id)
        const { instructions: _, ...discovery } = await service.rediscover(account)
        return json({ account: account.id, ...discovery })
      },
    },
    {
      name: "runpod_request_key",
      description: () => "Ask the user to enter a RunPod API key for an account (auth=apikey). They enter it outside the chat; you only learn whether it is set.",
      input: { type: "object", properties: { account: ACCOUNT, purpose: { type: "string", maxLength: 300 } }, additionalProperties: false },
      execute: async (input: { account?: string; purpose?: string }) => {
        const account = await service.pick(input.account)
        return json({
          status: (await service.vault.has(account.id, API_KEY)) ? "set (the user may replace it)" : "unset",
          tellUser: `Please create an API key in the RunPod console${account.team ? ` while "${account.team}" is selected` : ""} (Settings → API keys) and enter it in OpenCode's RunPod view (Settings → RunPod → ${account.id} → Enter key), or in a terminal in the oc-runpod folder: pixi run key-set ${account.id}${input.purpose ? ` — for: ${input.purpose}` : ""}`,
        })
      },
    },
  ]
}

export { publicKeyOf }
