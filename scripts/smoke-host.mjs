// End-to-end check against a real OpenCode CLI (pinned) in an isolated home, a scripted local model (not a real LLM)
// and a fake RunPod (sign-in issuing an API key, MCP, REST) whose pods' SSH is a local test sshd. Verifies: tools and
// the skill load, sign-in completes, the inventory reaches the model, a billable create goes through the permission
// prompt, the agent's own ssh reaches the pod through $RUNPOD_SSH_CONFIG, and keys never reach the model. --snapshot loads a verified installed snapshot instead of the checkout.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFakeRunpod } from "../plugin/testrunpod.ts"
import { startSshd } from "../plugin/testsshd.ts"

const OPENCODE_VERSION = "2.2.6"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cliPackage = `@opencode/cli-${process.platform}-${process.arch}`
const binary = path.join(root, ".local", "host", "node_modules", cliPackage, "bin", "opencode")
export async function ensureCli() {
  try { await access(binary); return binary } catch {}
  console.log(`Installing ${cliPackage}@${OPENCODE_VERSION} into .local/host ...`)
  await mkdir(path.join(root, ".local", "host"), { recursive: true })
  const result = spawnSync("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--prefix", path.join(root, ".local", "host"), "--cache", path.join(root, ".local", "npm-cache"), `${cliPackage}@${OPENCODE_VERSION}`], { stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Could not install ${cliPackage}@${OPENCODE_VERSION}`)
  return binary
}
if (process.argv.includes("--install-cli")) { await ensureCli(); process.exit(0) }
await ensureCli()

const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "oc-runpod-smoke-"))
const home = path.join(base, "home"), workspace = path.join(base, "workspace")
await mkdir(workspace, { recursive: true }); await mkdir(path.join(home, "config", "opencode"), { recursive: true })
const sshd = await startSshd()
const runpod = await startFakeRunpod({ sshd })

let pluginPath = root
if (process.argv.includes("--snapshot")) {
  process.env.XDG_DATA_HOME = path.join(home, "data")
  const { deploy, verifyRelease } = await import("./install.mjs")
  pluginPath = await deploy()
  await verifyRelease(pluginPath)
  console.log(`Using snapshot ${pluginPath}`)
}

const calls = [
  { name: "runpod_account_upsert", input: { id: "work", team: "Acme Team", label: "Work" } },
  { name: "runpod_signin", input: { account: "work" } },
  { name: "runpod_signin", input: { account: "work", wait: 30 } },
  { name: "runpod_ssh_setup", input: { account: "work" } },
  { name: "runpod_find_actions", input: { query: "gpu types" } },
  { name: "runpod_run", input: { action: "create-pod", arguments: { body: { name: "smoke-pod", image: "runpod/base", cpu: { id: "cpu3c", vcpuCount: 2 }, ports: ["22/tcp"], startSsh: true } } } },
  { name: "shell", input: { description: "SSH into the pod", command: `ssh -F "$RUNPOD_SSH_CONFIG" rp-work-smoke-pod 'echo SMOKE_SSH_OK'` } },
  { name: "shell", input: { description: "Plain command", command: "env | grep -c '^RUNPOD_SSH_CONFIG=' || true" } },
]
const toolResults = []
const descriptions = []
const prompts = []
let modelRequests = 0
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const part of req) chunks.push(part)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { res.writeHead(400); res.end(); return }
  const main = Array.isArray(body.tools) && body.tools.some(tool => tool.function?.name === "runpod_list")
  if (main) {
    modelRequests++
    descriptions.push(body.tools.find(tool => tool.function?.name === "runpod_list").function.description)
    prompts.push(JSON.stringify(body.messages ?? []))
    toolResults.length = 0
    for (const message of body.messages ?? []) if (message.role === "tool") toolResults.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
  }
  const call = main ? calls.shift() : undefined
  // The user opens the sign-in link the agent passed on, and approves.
  if (call?.name === "runpod_signin" && call.input.wait) {
    const link = /(http\S+\/authorize\?\S+?)(?:\s|"|\\)/.exec(toolResults.join("\n"))?.[1]
    if (link) setTimeout(() => runpod.approve(link, "team").catch(error => console.error("approve failed", error)), 500)
  }
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "probe", choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const chunk = (delta, finish_reason = null) => ({ id: `c${modelRequests}`, object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason }] })
  const events = call
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${modelRequests}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: main ? "OC_RUNPOD_SMOKE_COMPLETE" : "Smoke" }), chunk({}, "stop")]
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(home, "config", "opencode", "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json", model: "probe/probe",
  plugins: [{ package: pluginPath, options: { mcpUrl: runpod.mcpUrl, apiUrl: runpod.base } }],
  providers: { probe: {
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-not-a-secret" },
    models: { probe: { limit: { context: 32000, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } },
}))
const env = {
  HOME: home, TMPDIR: home, PATH: [path.join(root, ".pixi/envs/default/bin"), "/usr/bin", "/bin"].join(":"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
}
let stdout = "", stderr = ""
const child = spawn(binary, ["run", "--standalone", "--auto", "--format", "json", "--model", "probe/probe", "oc-runpod smoke"], { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.on("data", data => { stdout += data }); child.stderr.on("data", data => { stderr += data })
const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 150_000)
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) })
clearTimeout(timer); server.close(); await runpod.stop(); await sshd.stop()

const logs = path.join(root, ".local", "smoke-host.log")
await mkdir(path.dirname(logs), { recursive: true })
await writeFile(logs, `${stdout}\n----- stderr -----\n${stderr}`, { mode: 0o600 })
try {
  assert.equal(code, 0, `opencode exited ${code}; see ${logs}`)
  assert.equal(calls.length, 0, "every scripted call was made")
  assert.ok(stdout.includes("OC_RUNPOD_SMOKE_COMPLETE"), "run completed")
  assert.doesNotMatch(stderr, /\[oc-runpod\] (disabled|could not|tool reload failed|skill not registered)/, "no plugin warnings")
  assert.match(descriptions[0], /No RunPod accounts are configured yet/)
  assert.match(descriptions.at(-1), /work \(Acme Team\): balance \$4,404/, "inventory refreshed live")
  assert.match(descriptions.at(-1), /running: smoke-pod .* ssh alias rp-work-smoke-pod/, "new pod in the inventory")
  assert.match(prompts[0], /runpod/, "the runpod skill is offered")
  const all = toolResults.join("\n")
  assert.match(all, /"status": "done"/, "browser sign-in completed")
  assert.match(all, /list-gpu-types/)
  assert.ok(runpod.calls.some(call => call.name === "create-pod"), "billable create ran after the prompt was approved")
  assert.match(all, /SMOKE_SSH_OK/, "the agent's own ssh reached the pod")
  assert.match(toolResults.at(-1), /^0\b|"0\\n|\b0\n/, "a plain command gets nothing")
  const vault = await (await import("oc-secure-kit")).Vault.open({ dir: path.join(home, "data", "oc-runpod"), plugin: "oc-runpod" })
  const key = await vault.get("work", "api-key")
  assert.ok(key && !all.includes(key), "the API key never reaches the model")
  if (pluginPath !== root) await (await import("./install.mjs")).verifyRelease(pluginPath)
  console.log(`oc-runpod host smoke passed${pluginPath !== root ? " from a snapshot" : ""} (OpenCode ${OPENCODE_VERSION}, ${process.platform}-${process.arch}, ${modelRequests} model requests).`)
  await rm(base, { recursive: true, force: true })
} catch (error) {
  console.error(`Smoke failed. Scratch home kept at ${base}; logs at ${logs}`)
  throw error
}
