// Test helper: a fake RunPod — "Sign in with Runpod" (OAuth with dynamic registration + PKCE, issuing an API key, no
// refresh), the MCP endpoint, REST v2 pods, GraphQL `myself`, and pods whose direct SSH points at a local test sshd.
import { createHash, randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { TestSshd } from "./testsshd.js"

export interface FakePod {
  id: string; name: string; status: string; cost: number; gpu?: { id: string; count: number }
  ports: string[]; env: Record<string, string>; startedAt?: string
}

export interface FakeRunpod {
  readonly base: string
  readonly mcpUrl: string
  /** API keys issued per account (an account = personal or team context). */
  readonly accounts: Map<string, { balance: number; sshKeys: string[]; pods: FakePod[] }>
  /** What the browser does: open the authorization URL and approve for the selected account. */
  approve(authorizeUrl: string, account?: string): Promise<void>
  /** Issues a key directly (as if created in the console). */
  keyFor(account: string): string
  readonly calls: { name: string; args: Record<string, unknown> }[]
  readonly rest: { method: string; path: string }[]
  stop(): Promise<void>
}

export async function startFakeRunpod(options: { sshd?: TestSshd } = {}): Promise<FakeRunpod> {
  const accounts: FakeRunpod["accounts"] = new Map<string, { balance: number; sshKeys: string[]; pods: FakePod[] }>([
    ["personal", { balance: 5.61, sshKeys: [], pods: [] }],
    ["team", { balance: 4403.81, sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIColleagueKeyColleagueKeyColleagueKey00 colleague@acme.example"], pods: [
      { id: "teampod00001", name: "colleague-run", status: "RUNNING", cost: 0.08, ports: ["22/tcp"], env: { HF_TOKEN: "hf_secretvalue123456" }, startedAt: new Date(Date.now() - 3_600_000).toISOString() },
      { id: "teampod00002", name: "s2vla-us-w1", status: "EXITED", cost: 0, gpu: { id: "NVIDIA RTX PRO 6000", count: 1 }, ports: ["8888/http"], env: {} },
    ] }],
  ])
  const keys = new Map<string, string>()
  const clients = new Set<string>()
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string; account: string }>()
  const sessions = new Set<string>()
  const calls: FakeRunpod["calls"] = []
  const restLog: FakeRunpod["rest"] = []
  let pending = "personal"
  let base = ""
  let next = 1
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)) }
  const read = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString() }
  const keyFor = (account: string) => { const key = `rpa_${randomBytes(20).toString("hex").toUpperCase()}`; keys.set(key, account); return key }
  const who = (req: IncomingMessage) => keys.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "")
  /** The sshd only knows one authorized_keys file: running pods' PUBLIC_KEY lines go there. */
  const syncSshd = async () => {
    if (!options.sshd) return
    const lines = [...accounts.values()].flatMap(account => account.pods.filter(pod => pod.status === "RUNNING" && pod.ports.includes("22/tcp")).flatMap(pod => (pod.env.PUBLIC_KEY ?? "").split("\n")))
    const original = (await readFile(`${options.sshd.dir}/client_key.pub`, "utf8")).trim()
    await writeFile(options.sshd.authorizedKeys, [original, ...lines.filter(Boolean)].join("\n") + "\n", { mode: 0o600 })
  }
  const view = (pod: FakePod) => ({
    id: pod.id, name: pod.name, status: pod.status, cost: pod.cost, ...(pod.gpu && { gpu: pod.gpu }), ports: pod.ports, env: pod.env,
    ...(pod.startedAt && { startedAt: pod.startedAt }),
    ssh: {
      proxy: { host: "ssh.runpod.io", port: 22, username: `${pod.id}-6441`, command: `ssh ${pod.id}-6441@ssh.runpod.io` },
      direct: pod.status === "RUNNING" && pod.ports.includes("22/tcp") && options.sshd ? { host: "127.0.0.1", port: options.sshd.port, username: options.sshd.user, command: "ssh" } : null,
    },
  })
  const tools = [
    { name: "list-pods", description: "List pods.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
    { name: "get-pod", description: "Get a pod.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "create-pod", description: "Rent a GPU/CPU pod. BILLABLE. Call describe-tool for the full argument schema before the first use.", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: { body: { type: "object" } }, required: ["body"] } },
    { name: "pod-action", description: "Start, stop, restart or terminate a pod.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "object" } }, required: ["id", "body"] } },
    { name: "list-gpu-types", description: "List GPU types and prices.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
    { name: "get-ssh-keys", description: "List registered SSH public keys.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
    { name: "update-ssh-keys", description: "Replace registered SSH public keys.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { body: { type: "object" } }, required: ["body"] } },
    { name: "delete-network-volume", description: "Delete a network volume.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "describe-tool", description: "Return one tool's full definition.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  ]
  const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] })
  const error = (status: number, detail: string) => ({ ...text({ status, detail }), isError: true })
  const createPod = async (account: string, body: Record<string, any>): Promise<FakePod> => {
    const data = accounts.get(account)!
    const pod: FakePod = {
      id: `newpod${String(next++).padStart(6, "0")}`, name: body.name, status: "RUNNING", cost: body.gpu ? 0.79 : 0.06,
      ...(body.gpu && { gpu: { id: body.gpu.id, count: body.gpu.count ?? 1 } }), ports: body.ports ?? [],
      env: { ...(body.env ?? {}), ...(body.startSsh && data.sshKeys.length && !body.env?.PUBLIC_KEY && { PUBLIC_KEY: data.sshKeys.join("\n") }) },
      startedAt: new Date().toISOString(),
    }
    data.pods.unshift(pod)
    await syncSshd()
    return pod
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    const path = url.pathname
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp/") return send(res, 200, { resource: `${base}/mcp/`, authorization_servers: [base], bearer_methods_supported: ["header"] })
    if (path === "/.well-known/oauth-authorization-server") return send(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"] })
    if (path === "/register") {
      const body = JSON.parse(await read(req))
      const id = `mcp-${randomBytes(4).toString("hex")}`; clients.add(id)
      return send(res, 201, { client_id: id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"] })
    }
    if (path === "/authorize") {
      const p = url.searchParams
      if (!clients.has(p.get("client_id")!) || p.get("code_challenge_method") !== "S256") return send(res, 400, { error: "invalid_request" })
      const code = randomBytes(8).toString("hex")
      codes.set(code, { clientId: p.get("client_id")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, account: pending })
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` }); res.end(); return
    }
    if (path === "/token") {
      const form = new URLSearchParams(await read(req))
      const entry = codes.get(form.get("code") ?? "")
      if (form.get("grant_type") !== "authorization_code" || !entry || entry.clientId !== form.get("client_id") || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) return send(res, 400, { error: "invalid_grant" })
      codes.delete(form.get("code")!)
      return send(res, 200, { access_token: keyFor(entry.account), token_type: "Bearer" })
    }
    const account = who(req)
    if (path === "/mcp/") {
      if (!account) return send(res, 401, { error: "invalid_token" })
      const message = JSON.parse(await read(req))
      if (message.method === "initialize") { const id = randomBytes(6).toString("hex"); sessions.add(id); return send(res, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "runpod-mcp", version: "4.10" }, instructions: "These tools cover the Runpod v2 REST surface. State the hourly price before creating anything billable. They do not do SSH sessions or file transfer." } }, { "mcp-session-id": id }) }
      if (!sessions.has(String(req.headers["mcp-session-id"]))) return send(res, 404, { error: "session not found" })
      if (!("id" in message)) { res.writeHead(202); res.end(); return }
      let result: unknown
      const data = accounts.get(account)!
      if (message.method === "tools/list") result = { tools }
      else {
        const { name, arguments: args } = message.params
        calls.push({ name, args })
        const pod = data.pods.find(item => item.id === args.id)
        if (name === "list-pods") result = text({ pods: data.pods.map(view), pagination: { hasNextPage: false, nextCursor: null } })
        else if (name === "get-pod") result = pod ? text(view(pod)) : error(404, "pod not found")
        else if (name === "create-pod") result = text(view(await createPod(account, args.body)))
        else if (name === "pod-action") {
          if (!pod) result = error(404, "pod not found")
          else {
            const action = args.body?.action
            if (action === "terminate") data.pods.splice(data.pods.indexOf(pod), 1)
            else { pod.status = action === "stop" ? "EXITED" : "RUNNING"; if (action === "start") pod.startedAt = new Date().toISOString() }
            await syncSshd()
            result = text({ id: pod.id, status: pod.status })
          }
        } else if (name === "list-gpu-types") result = text({ gpuTypes: [{ id: "NVIDIA RTX PRO 6000", securePrice: 1.79 }, { id: "NVIDIA H100 80GB HBM3", securePrice: 2.69 }] })
        else if (name === "get-ssh-keys") result = text({ keys: data.sshKeys })
        else if (name === "update-ssh-keys") { data.sshKeys = [...args.body.keys]; result = text({ keys: data.sshKeys }) }
        else if (name === "describe-tool") result = text({ name: args.name, inputSchema: args.name === "create-pod" ? { type: "object", properties: { body: { type: "object", required: ["name", "image"], properties: { name: { type: "string" }, image: { type: "string" }, gpu: { type: "object" }, cpu: { type: "object" }, ports: { type: "array" }, startSsh: { type: "boolean" }, env: { type: "object" } } } }, required: ["body"] } : tools.find(tool => tool.name === args.name)?.inputSchema })
        else result = text({ ok: true })
      }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`); return
    }
    if (path === "/graphql") {
      if (!account) return send(res, 200, { errors: [{ message: "Unauthorized" }] })
      return send(res, 200, { data: { myself: { clientBalance: accounts.get(account)!.balance, currentSpendPerHr: 0.08, spendLimit: 80 } } })
    }
    if (path.startsWith("/v2/")) {
      restLog.push({ method: req.method!, path })
      if (!account) return send(res, 401, { error: "Invalid Authorization header" })
      const data = accounts.get(account)!
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : JSON.parse((await read(req)) || "{}")
      if (path === "/v2/pods" && req.method === "GET") return send(res, 200, { pods: data.pods.map(view), pagination: { hasNextPage: false, nextCursor: null } })
      if (path === "/v2/pods" && req.method === "POST") return send(res, 201, view(await createPod(account, body)))
      const one = /^\/v2\/pods\/([^/]+)(\/action)?$/.exec(path)
      const pod = one && data.pods.find(item => item.id === one[1])
      if (one && !pod) return send(res, 404, { detail: "pod not found" })
      if (pod && one![2] && req.method === "POST") { pod.status = body.action === "stop" ? "EXITED" : "RUNNING"; await syncSshd(); return send(res, 200, view(pod)) }
      if (pod && req.method === "GET") return send(res, 200, view(pod))
      if (pod && req.method === "PATCH") { Object.assign(pod, body.ports && { ports: body.ports }, body.env && { env: body.env }); pod.status = "RUNNING"; await syncSshd(); return send(res, 200, view(pod)) }
      if (pod && req.method === "DELETE") { data.pods.splice(data.pods.indexOf(pod), 1); res.writeHead(204); res.end(); return }
      return send(res, 404, { detail: "not found" })
    }
    send(res, 404, { detail: "not found" })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base, mcpUrl: `${base}/mcp/`, accounts, calls, rest: restLog, keyFor,
    async approve(authorizeUrl, account = "personal") {
      pending = account
      const redirect = await fetch(authorizeUrl, { redirect: "manual" })
      const location = redirect.headers.get("location")
      if (!location) throw new Error(`authorize failed: ${redirect.status} ${await redirect.text()}`)
      await fetch(location)
    },
    async stop() { await new Promise(resolve => server.close(resolve)) },
  }
}
