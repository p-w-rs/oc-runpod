import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-runpod-accounts/1"

/** RunPod's hosted agent interface (MCP). Overridable for tests. */
export const DEFAULT_MCP = "https://mcp.runpod.io/"
/** REST v2 base (paths include /v2). */
export const DEFAULT_API = "https://api.runpod.io"

/**
 * How an account signs in.
 * - browser: "Sign in with Runpod" in the browser; RunPod creates an API key for the account/team selected in the console.
 * - apikey: an API key the user creates in the console (Settings → API keys) and enters.
 * Either way the stored credential is a RunPod API key.
 */
export type Auth = "browser" | "apikey"

/** A RunPod account or team. One login can reach several (personal + teams); each is its own account here. */
export interface Account {
  readonly id: string
  readonly label?: string
  readonly auth: Auth
  /** Name of the RunPod account/team as shown in the console's account menu, e.g. "ASI R&D Team". A reminder for sign-in. */
  readonly team?: string
  readonly notes?: string
  readonly updatedAt: string
}

export interface PodSummary {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly costPerHr?: number
  readonly gpu?: string
  readonly startedAt?: string
}

/** What the plugin learned about an account. Rediscovered; never exported. */
export interface Discovery {
  readonly balance?: number
  readonly spendLimit?: number
  readonly pods?: number
  /** Running pods, for the idle reminder in the agent's inventory. */
  readonly running?: readonly PodSummary[]
  readonly actions?: number
  readonly instructions?: string
  /** Whether the plugin's SSH key is in the account's key list. */
  readonly sshKey?: "registered" | "missing"
  readonly checkedAt?: string
  readonly error?: string
}

export const AREAS = ["pods", "serverless", "storage", "account", "other"] as const
export type Area = (typeof AREAS)[number]
/** spend: creates or starts something billable. */
export const VERBS = ["read", "write", "spend", "delete", "admin"] as const
export type Verb = (typeof VERBS)[number]
export const CAPABILITIES = [
  ...AREAS.flatMap(area => VERBS.map(verb => `${area}-${verb}` as const)),
  "ssh", "manage", "remove",
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Starting point only; users change it in the table. Costs, deletes, admin and unknown writes ask. */
export function defaultEffect(capability: string): "allow" | "ask" {
  return /-(spend|delete|admin)$/.test(capability) || ["other-write", "remove"].includes(capability) ? "ask" : "allow"
}

/** Vault secret names (entity = account id). */
export const API_KEY = "api-key"
/** The plugin's own SSH key for this account (OpenSSH private key). */
export const SSH_KEY = "ssh-key"
export const SECRET_NAMES = [API_KEY, SSH_KEY] as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return value as string
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  return validName("account", id)
}

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!["id", "label", "auth", "team", "notes", "updatedAt"].includes(key)) fail(`Unknown account field ${JSON.stringify(key)}`)
  const id = validAccountId(raw.id)
  const auth = (raw.auth ?? "browser") as Auth
  if (!["browser", "apikey"].includes(auth)) fail("auth must be browser or apikey")
  const label = text(raw.label, "label", 120)
  const team = text(raw.team, "team", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return { id, auth, ...(label && { label }), ...(team && { team }), ...(notes && { notes }), updatedAt: now.toISOString() }
}

export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

/** Looks like a RunPod API key. */
export const looksLikeApiKey = (value: string) => /^rpa_[A-Za-z0-9]{20,}$/.test(value.trim())

// ------------------------------------------------------------------ action classification

/** Sends data to RunPod about the conversation rather than managing infrastructure. */
const FEEDBACK = new Set(["report_feedback", "save_to_journal", "read_journal", "ask_question", "report_how_user_found_runpod"])
/** Reference and catalog lookups (no account data changes). */
const LOOKUP = /^(list-guides|read-guide|lookup-concept|search-concepts|search-docs|describe-tool|get-capacity|list-hub-repos|list-public-endpoints|list-public-templates)$/

function area(name: string): Area {
  if (/pod|cluster|gpu-type|cpu-type|data-center|capacity/.test(name)) return "pods"
  if (/endpoint|job|worker|serverless|hub-repo/.test(name)) return "serverless"
  if (/volume/.test(name)) return "storage"
  if (/template|registr|secret|ssh-key|organization|cost-center|billing|audit|delegation/.test(name)) return "account"
  return "other"
}

export interface ActionAnnotations { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean }

/** Permission an action needs, from its name, the server's hints and (for pod-action) its arguments. */
export function classifyAction(name: string, annotations: ActionAnnotations = {}, args: Record<string, unknown> = {}): Capability {
  if (FEEDBACK.has(name)) return name === "read_journal" ? "other-read" : "other-write"
  if (LOOKUP.test(name)) return name === "list-public-endpoints" || name === "list-public-templates" || name === "list-hub-repos" || name === "get-capacity" ? `${area(name)}-read` : "other-read"
  const where = area(name)
  if (name === "pod-action") {
    const action = String((args.body as { action?: unknown } | undefined)?.action ?? args.action ?? "")
    return action === "start" ? "pods-spend" : action === "terminate" ? "pods-delete" : "pods-write"
  }
  if (annotations.readOnlyHint === true || /^(get|list|stream)-/.test(name) || name === "endpoint-health" || name === "get-job-status") return `${where}-read`
  if (/^(delete|purge|remove|revoke|detach)-/.test(name)) return `${where}-delete`
  if (/^create-(pod|cluster|endpoint|network-volume|global-volume)$|^deploy-hub-repo$/.test(name)) return `${where}-spend`
  if (/organization|cost-center|^update-ssh-keys$|^create-delegation$|^create-secret$|^update-secret$/.test(name)) return `${where}-admin`
  return `${where}-write`
}

/** SSH host alias for a pod, e.g. "rp-team-my-pod". */
export function podAlias(account: string, pod: { id: string; name?: string }): string {
  const slug = (pod.name ?? pod.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || pod.id
  return `rp-${account.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slug}`
}

/** Permission a REST call needs (paths like /v2/pods/abc/action). */
export function classifyRest(method: string, path: string, body?: unknown): Capability {
  const m = method.toUpperCase(), p = path.split("?")[0]!.replace(/\/+$/, "")
  const where: Area = /\/(pods|clusters|catalog)/.test(p) ? "pods" : /\/serverless/.test(p) ? "serverless" : /volume/.test(p) ? "storage" : /\/(templates|registries|secrets|user|organization|cost-centers|billing|audit|delegations)/.test(p) ? "account" : "other"
  if (m === "GET" || m === "HEAD") return `${where}-read`
  if (m === "DELETE") return `${where}-delete`
  if (/\/pods\/[^/]+\/action$/.test(p)) {
    const action = (body as { action?: string } | undefined)?.action
    return action === "start" ? "pods-spend" : action === "terminate" ? "pods-delete" : "pods-write"
  }
  if (m === "POST" && /^\/v2\/(pods|clusters|serverless|network-volumes|global-volumes)$/.test(p)) return `${where}-spend`
  if (/ssh-keys|organization|cost-centers|secrets/.test(p)) return `${where}-admin`
  return `${where}-write`
}
