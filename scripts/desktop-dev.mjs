// Development helper: runs the installed OpenCode Desktop with an ISOLATED profile (own HOME, config, data and service
// port) that loads this checkout, and drives it over Chrome DevTools. It never touches the user's own Desktop,
// profile or background service.
//   node scripts/desktop-dev.mjs start         create profile with sample data, launch, record .local/desktop/connection.json
//   node scripts/desktop-dev.mjs eval '<js>'   evaluate in the renderer, print JSON
//   node scripts/desktop-dev.mjs click '<text or aria-label>'
//   node scripts/desktop-dev.mjs shot <file.png>
//   node scripts/desktop-dev.mjs file '<css selector of input[type=file]>' <path>
//   node scripts/desktop-dev.mjs stop          stop only the owned Desktop and its service
import { execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { createServer as createHttp } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP = "/Applications/OpenCode.app/Contents/MacOS/OpenCode"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const stateDir = path.join(root, ".local", "desktop")
const connectionFile = path.join(stateDir, "connection.json")
const cli = path.join(root, ".local", "host", "node_modules", `@opencode/cli-${process.platform}-${process.arch}`, "bin", "opencode")
const [command, ...args] = process.argv.slice(2)

const envFor = profile => ({
  HOME: path.join(profile, "home"), TMPDIR: path.join(profile, "home"),
  PATH: [path.join(root, ".pixi/envs/default/bin"), "/usr/bin", "/bin"].join(":"),
  XDG_CONFIG_HOME: path.join(profile, "config"), XDG_DATA_HOME: path.join(profile, "data"),
  XDG_STATE_HOME: path.join(profile, "state"), XDG_CACHE_HOME: path.join(profile, "cache"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
  // Separate Electron userData, so this instance never hits the user's single-instance lock.
  OPENCODE_DESKTOP_TEST_ROOT: profile,
})
const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)) }) })

async function owned() {
  const connection = JSON.parse(await readFile(connectionFile, "utf8"))
  if (!connection.profile.startsWith(path.join(root, ".local", "desktop-profile-"))) throw new Error("Not an owned isolated profile")
  return connection
}

async function cdp() {
  const { port } = await owned()
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === "page")
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 30_000 })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  return { call, evaluate, close: () => ws.close() }
}

if (command === "start") {
  await mkdir(stateDir, { recursive: true })
  const profile = await mkdtemp(path.join(root, ".local", "desktop-profile-"))
  for (const dir of ["home", "config/opencode", "workspace"]) await mkdir(path.join(profile, dir), { recursive: true })
  // A scripted local model so sessions can be created without a real provider.
  const provider = createHttp(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    const chunk = (delta, finish_reason = null) => ({ id: "d", object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason }] })
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "d", object: "chat.completion", model: "probe", choices: [{ index: 0, message: { role: "assistant", content: "Desktop dev" }, finish_reason: "stop" }] })); return }
    // "RUN: <command>" in the latest user message makes the model call the native shell tool once.
    const last = (body.messages ?? []).at(-1)
    const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map(part => part?.text ?? "").join("\n")
    const run = last?.role === "user" && body.tools?.length ? /RUN: (.*)$/m.exec(text)?.[1] : undefined
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (run) {
      res.end([chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: run, description: "Desktop dev command" }) } }] }), chunk({}, "tool_calls")]
        .map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
      return
    }
    res.end([chunk({ role: "assistant", content: "Desktop dev reply." }), chunk({}, "stop")].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
  })
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  await writeFile(path.join(profile, "config/opencode/opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", model: "probe/probe", plugins: [root],
    providers: { probe: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic" }, models: { probe: { limit: { context: 32000, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } } } },
  }, null, 2))
  const env = envFor(profile)
  execFileSync(cli, ["service", "set", "port", String(await freePort())], { env, cwd: profile, stdio: "pipe" })
  // A fake RunPod so the GUI sign-in can be clicked through: its authorize page approves at once and redirects back.
  const { startFakeRunpod } = await import("../plugin/testrunpod.ts")
  const runpod = await startFakeRunpod()
  const configFile = path.join(profile, "config/opencode/opencode.json")
  const written = JSON.parse(await readFile(configFile, "utf8"))
  written.plugins = [{ package: root, options: { mcpUrl: runpod.mcpUrl, apiUrl: runpod.base } }]
  await writeFile(configFile, JSON.stringify(written, null, 2))
  await writeFile(path.join(stateDir, "fake-runpod.json"), JSON.stringify({ base: runpod.base }))
  const child = spawn(APP, ["--remote-debugging-port=0"], { env, cwd: path.join(profile, "workspace"), detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No DevTools endpoint within 30 s")), 30_000)
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
      if (logs.length < 1e6) logs += data
      const match = logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.once("exit", code => reject(new Error(`Desktop exited ${code}: ${logs.slice(-2000)}`)))
  })
  await writeFile(connectionFile, JSON.stringify({ profile, pid: child.pid, port, workspace: path.join(profile, "workspace"), runpod: runpod.base }, null, 2))
  console.log(JSON.stringify({ profile, pid: child.pid, port }))
  // Keep the scripted provider alive with the app; this process stays in the background until stop.
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {})
  child.once("exit", () => process.exit(0))
  await writeFile(path.join(stateDir, "driver.pid"), String(process.pid))
} else if (["eval", "click", "shot", "file", "type", "key"].includes(command)) {
  const page = await cdp()
  try {
    if (command === "eval") console.log(JSON.stringify(await page.evaluate(args[0]), null, 2))
    if (command === "click") {
      const point = await page.evaluate(`(() => { const want = ${JSON.stringify(args[0])}; const el = [...document.querySelectorAll('button,[role=menuitem],[role=tab],a,[role=option],label')].find(e => (e.getAttribute('aria-label') === want || e.innerText?.trim() === want || e.title === want) && e.getBoundingClientRect().width); if (!el) throw new Error('No visible element: ' + want); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      for (const type of ["mousePressed", "mouseReleased"]) await page.call("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 })
      console.log(`clicked ${args[0]}`)
    }
    if (command === "type") { await page.call("Input.insertText", { text: args[0] }); console.log("typed") }
    if (command === "key") {
      const [mods, key] = args[0].includes("+") ? [args[0].split("+").slice(0, -1), args[0].split("+").pop()] : [[], args[0]]
      const modifiers = (mods.includes("meta") ? 4 : 0) | (mods.includes("shift") ? 8 : 0) | (mods.includes("ctrl") ? 2 : 0) | (mods.includes("alt") ? 1 : 0)
      const code = key === "Enter" ? 13 : key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0)
      for (const type of ["keyDown", "keyUp"]) await page.call("Input.dispatchKeyEvent", { type, key, modifiers, windowsVirtualKeyCode: code, ...(key === "Enter" && type === "keyDown" && { text: "\r" }) })
      console.log(`pressed ${args[0]}`)
    }
    if (command === "file") {
      const { root: doc } = await page.call("DOM.getDocument", { depth: -1, pierce: true })
      const { nodeId } = await page.call("DOM.querySelector", { nodeId: doc.nodeId, selector: args[0] })
      if (!nodeId) throw new Error(`No element ${args[0]}`)
      await page.call("DOM.setFileInputFiles", { nodeId, files: [path.resolve(args[1])] })
      console.log(`set ${args[1]}`)
    }
    if (command === "shot") {
      const image = await page.call("Page.captureScreenshot", { format: "png" })
      await writeFile(args[0], Buffer.from(image.data, "base64"))
      console.log(args[0])
    }
  } finally { page.close() }
} else if (command === "stop") {
  const { pid, profile } = await owned()
  const seen = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim()
  if (seen !== `${APP} --remote-debugging-port=0`) throw new Error(`PID ${pid} is not the owned Desktop`)
  process.kill(-pid, "SIGTERM")
  try { execFileSync(cli, ["service", "stop"], { env: envFor(profile), cwd: profile, stdio: "pipe", timeout: 30_000 }) } catch {}
  try { const driver = Number(await readFile(path.join(stateDir, "driver.pid"), "utf8")); process.kill(driver, "SIGTERM") } catch {}
  console.log("Stopped the owned isolated Desktop and its service")
} else {
  console.error("Usage: desktop-dev.mjs start [--sample] | eval <js> | click <text> | shot <file> | stop")
  process.exit(2)
}
