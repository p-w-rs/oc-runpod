import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { startFakeRunpod, type FakeRunpod } from "./testrunpod.js"
import { startSshd, type TestSshd } from "./testsshd.js"

const dirs: string[] = []
let fake: FakeRunpod
let sshd: TestSshd
before(async () => { sshd = await startSshd(); fake = await startFakeRunpod({ sshd }) })
after(async () => { await fake.stop(); await sshd.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ocrp-"))
  dirs.push(dir)
  const hooks = { evaluate: [] as any[], before: [] as any[], after: [] as any[], shell: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const skillTransforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string; content: string }[] = []
  const prompts: { action: string; resources: string[]; metadata?: Record<string, unknown> }[] = []
  let rpc: any
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const rebuildSkills = () => { skills.length = 0; for (const transform of skillTransforms) transform({ add: (skill: any) => skills.push(skill) }) }
  const ctx = {
    options: { dataDirectory: dir, mcpUrl: fake.mcpUrl, apiUrl: fake.base, ...options },
    session: { get: async () => ({ parentID: undefined }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, resources: input.resources, metadata: input.metadata }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (name: string, callback: any) => registration(name === "execute.before" ? hooks.before : hooks.after, callback),
    },
    shell: { hook: async (_: string, callback: any) => registration(hooks.shell, callback) },
    skill: {
      transform: async (callback: any) => { skillTransforms.push(callback); rebuildSkills(); return { dispose: async () => { skillTransforms.splice(skillTransforms.indexOf(callback), 1); rebuildSkills() } } },
      reload: async () => rebuildSkills(),
    },
    event: { subscribe: () => (async function* () {})() },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", hidden: false }] }) },
    rpc: { register: async (_: unknown, handlers: any) => { rpc = handlers; return { dispose: async () => { rpc = undefined } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const context = (agent: string) => ({ sessionID: "s", agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} })
  const finish = async (event: any) => { for (const hook of hooks.after) await hook(event); return event }
  const call = async (name: string, input: unknown, agent = "build") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = context(agent)
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    await finish(event)
    if (event.status === "error") throw event.error
    const text = event.result.content
    try { return JSON.parse(text) } catch { return text }
  }
  /** Runs a command through the native shell path: execute.before, shell create.before, a real sh, execute.after. */
  const shell = async (command: string, agent = "build") => {
    const c = context(agent)
    const input = { command, description: "test" }
    for (const hook of hooks.before) await hook({ tool: "shell", ...c, input })
    const create = { command, cwd: dir, timeout: 60_000, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
    for (const hook of hooks.shell) await hook(create)
    const { exit, output } = await new Promise<{ exit: number; output: string }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd: dir, env: { ...process.env, ...create.env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
      child.on("error", reject)
      child.on("close", code => resolve({ exit: code ?? -1, output }))
    })
    const event = await finish({ tool: "shell", id: c.id, input, status: "completed", result: { output: { exit, truncated: false, output, status: "completed" }, content: [{ type: "text", text: output }], metadata: { exit } } })
    return { exit, text: event.result.content[0].text as string, env: create.env }
  }
  const signIn = async (id: string, as: string, team?: string) => {
    await call("runpod_account_upsert", { id, ...(team && { team }) })
    const started = await call("runpod_signin", { account: id })
    await fake.approve(/(http\S+\/authorize\S+)/.exec(started.tellUser)![1]!, as)
    for (let i = 0; i < 500; i++) { const list = await rpc.state({}); if (list.accounts.find((a: { id: string; balance?: number }) => a.id === id)?.balance !== undefined) return; await new Promise(r => setTimeout(r, 30)) }
    throw new Error("sign-in did not settle")
  }
  return { dir, tools, skills, prompts, call, shell, signIn, cleanup, rpc: () => rpc, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }) }
}

test("identity, tools, skill, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 10)
  assert.equal(h.skills[0]!.id, "runpod")
  assert.match(h.skills[0]!.content, /Money comes first/)
  assert.match(h.tools.get("runpod_list")!.description, /No RunPod accounts are configured yet/)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  const broken = await host("approve", { apiUrl: "ftp://x" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ mcpUrl: 3 }), /string/)
})

test("sign in to two contexts (personal and team) from one login; the inventory shows each", async () => {
  const h = await host()
  await h.signIn("personal", "personal")
  await h.signIn("team", "team", "ASI R&D Team")
  const list = await h.call("runpod_list", {})
  const team = list.accounts.find((a: { id: string }) => a.id === "team")
  assert.equal(team.balance, 4403.81)
  assert.equal(team.running[0].name, "colleague-run")
  assert.equal(team.running[0].ssh.alias, "rp-team-colleague-run")
  assert.equal(list.accounts.find((a: { id: string }) => a.id === "personal").pods, 0)
  await new Promise(r => setTimeout(r, 30))
  const description = h.tools.get("runpod_list")!.description
  assert.match(description, /team \(ASI R&D Team\): balance \$4,404, 2 pods/)
  assert.match(description, /running: colleague-run \(teampod00001, \$0\.08\/hr, up 1\.0h\) ssh alias rp-team-colleague-run/)
  assert.match(description, /Running pods cost \$0\.08\/hr in total/)
  const key = (await (await h.vault()).get("team", "api-key"))!
  assert.match(key, /^rpa_/)
  assert.ok(!JSON.stringify(list).includes(key), "keys never reach the agent")
  assert.match(h.skills[0]!.content, /RunPod's own guidance[\s\S]*Ignore its remarks that SSH/)
  await assert.rejects(h.call("runpod_find_actions", { query: "pods" }), /Several RunPod accounts exist .*team = ASI R&D Team/)
})

test("costs and deletes ask; reads and stops do not; pod env values are hidden", async () => {
  const h = await host()
  await h.signIn("team", "team")
  const found = await h.call("runpod_find_actions", { names: ["create-pod"] })
  assert.deepEqual(found.actions[0].parameters.properties.body.required, ["name", "image"], "full schema fetched on demand")
  const pods = await h.call("runpod_run", { action: "list-pods", arguments: {} })
  assert.equal(pods.pods[0].env.HF_TOKEN, "(hidden)")
  assert.doesNotMatch(JSON.stringify(pods), /hf_secretvalue/)
  assert.deepEqual(h.prompts, [])
  await h.call("runpod_run", { action: "create-pod", arguments: { body: { name: "agent-pod", image: "runpod/base", cpu: { id: "cpu3c", vcpuCount: 2 }, ports: ["22/tcp"], startSsh: true } } })
  await h.call("runpod_run", { action: "pod-action", arguments: { id: "teampod00002", body: { action: "start" } } })
  await h.call("runpod_run", { action: "pod-action", arguments: { id: "teampod00002", body: { action: "stop" } } })
  await h.call("runpod_rest", { method: "DELETE", path: "/v2/pods/teampod00002" })
  assert.deepEqual((h.prompts as { action: string }[]).map(p => p.action), ["oc-runpod.pods-spend", "oc-runpod.pods-spend", "oc-runpod.pods-delete"])
  await (await h.policy()).setCells([{ entity: "team", row: { agent: "plan" }, capability: "pods-write", effect: "deny" }])
  await assert.rejects(h.call("runpod_run", { action: "pod-action", arguments: { id: "x", body: { action: "stop" } } }, "plan"), /Denied by the oc-runpod permissions table \(pods-write on team\)/)
  const rejecting = await host("reject")
  await rejecting.signIn("team", "team")
  await assert.rejects(rejecting.call("runpod_run", { action: "create-pod", arguments: { body: { name: "x", image: "y" } } }), /rejected by user/)
})

test("SSH into a pod with the agent's own ssh and rsync; plain commands untouched", async () => {
  const h = await host()
  await h.signIn("team", "team")
  // Register the plugin's key (asks: admin on the team account), keeping the colleague's key.
  const setup = await h.call("runpod_ssh_setup", { account: "team" })
  assert.equal(setup.accountKey, "added")
  assert.equal(fake.accounts.get("team")!.sshKeys.length, 2)
  assert.match(fake.accounts.get("team")!.sshKeys[0]!, /colleague@acme/)
  assert.deepEqual(h.prompts.map(p => p.action), ["oc-runpod.account-admin"])
  // A new pod with startSsh gets the account's keys, including the plugin's.
  await h.call("runpod_run", { action: "create-pod", arguments: { body: { name: "train-1", image: "runpod/pytorch", gpu: { id: "NVIDIA RTX PRO 6000", count: 1 }, ports: ["22/tcp"], startSsh: true } } })
  const list = await h.call("runpod_list", { account: "team" })
  const pod = list.accounts[0].running.find((p: { name: string }) => p.name === "train-1")
  assert.deepEqual(pod.ssh, { alias: "rp-team-train-1", state: "ready" })
  const ran = await h.shell(`ssh -F "$RUNPOD_SSH_CONFIG" rp-team-train-1 'echo POD_OK'`)
  assert.equal(ran.exit, 0, ran.text)
  assert.match(ran.text, /POD_OK/)
  await writeFile(join(h.dir, "data.txt"), "payload\n")
  const synced = await h.shell(`rsync -a -e "ssh -F '$RUNPOD_SSH_CONFIG'" data.txt rp-team-train-1:${sshd.home}/data.txt && ssh -F "$RUNPOD_SSH_CONFIG" rp-team-train-1 cat ${sshd.home}/data.txt`)
  assert.equal(synced.exit, 0, synced.text)
  assert.match(synced.text, /payload/)
  const key = (await (await h.vault()).get("team", "ssh-key"))!
  assert.ok(!synced.text.includes(key.split("\n")[1]!), "the key never shows up in output")
  const plain = await h.shell("echo hello")
  assert.deepEqual(plain.env, {}, "commands that do not reference the config get nothing")
  // A pod without port 22: explained, and runpod_ssh_setup fixes it (restart asks).
  const stopped = await h.shell(`ssh -F "$RUNPOD_SSH_CONFIG" rp-team-colleague-run true`)
  assert.match(stopped.text, /rp-team-colleague-run was created without the plugin's SSH key/)
  h.prompts.length = 0
  const fixed = await h.call("runpod_ssh_setup", { account: "team", pod: "colleague-run" })
  assert.deepEqual(fixed.pod.changed, ["added the plugin key"])
  assert.deepEqual(h.prompts.map(p => p.action), ["oc-runpod.pods-admin"])
  assert.equal(fake.accounts.get("team")!.pods.find(p => p.id === "teampod00001")!.env.HF_TOKEN, "hf_secretvalue123456", "other env values kept")
  const after = await h.shell(`ssh -F "$RUNPOD_SSH_CONFIG" rp-team-colleague-run 'echo FIXED'`)
  assert.match(after.text, /FIXED/)
  // Denied SSH: the config stays empty and the reason is noted.
  await (await h.policy()).setCells([{ entity: "team", row: { agent: "plan" }, capability: "ssh", effect: "deny" }])
  const denied = await h.shell(`ssh -F "$RUNPOD_SSH_CONFIG" rp-team-train-1 true`, "plan")
  assert.notEqual(denied.exit, 0)
  assert.match(denied.text, /SSH to team's pods was not allowed/)
  const known = await readFile(join(h.dir, "known_hosts"), "utf8")
  assert.match(known, /runpod-newpod/, "host keys pinned per pod")
})

test("API-key accounts, GUI admin, export and import", async () => {
  const h = await host()
  await h.rpc().createAccount({ id: "ci", auth: "apikey", team: "ASI R&D Team" })
  const asked = await h.call("runpod_request_key", { account: "ci" })
  assert.match(asked.tellUser, /pixi run key-set ci/)
  const set = await h.rpc().setKey({ id: "ci", key: fake.keyFor("team") })
  assert.equal(set.balance, 4403.81)
  const state = await h.rpc().state({ sessionID: "s" })
  assert.equal(state.accounts[0].team, "ASI R&D Team")
  assert.equal(state.accounts[0].sshKey, "missing")
  await h.rpc().registerSshKey({ id: "ci" })
  assert.equal((await h.rpc().state({})).accounts[0].sshKey, "registered")
  await h.rpc().setCells({ changes: [{ entity: "ci", capability: "pods-spend", effect: "deny", agent: "*" }] })
  const exported = await h.rpc().exportBundle({ passphrase: "export passphrase 1" })
  const other = await host()
  await other.rpc().applyImport({ content: exported.content, passphrase: "export passphrase 1", mode: "merge" })
  for (let i = 0; i < 100 && (await other.rpc().state({})).accounts[0]?.balance === undefined; i++) await new Promise(r => setTimeout(r, 30))
  const imported = await other.rpc().state({})
  assert.equal(imported.accounts[0].balance, 4403.81, "the imported key works on the new install")
  assert.equal(imported.cells.ci["*"]["pods-spend"], "deny")
  await h.rpc().signOut({ id: "ci" })
  await assert.rejects(h.call("runpod_run", { action: "list-pods", arguments: {} }), /no API key yet/)
})
