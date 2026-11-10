// Enter a RunPod API key for an account (Settings → API keys in the RunPod console). Read with echo off, or from stdin.
//   pixi run key-set <account>
import { createInterface } from "node:readline"
import { pluginDataDir } from "oc-secure-kit"
import { looksLikeApiKey, normalizeAccount } from "../plugin/model.ts"
import { RunpodService } from "../plugin/service.ts"

const [id] = process.argv.slice(2)
if (!id) { console.error("Usage: pixi run key-set <account>"); process.exit(2) }
const service = await RunpodService.open(pluginDataDir("oc-runpod", process.env.OC_RUNPOD_DATA_DIR || undefined))
const account = (await service.store.get(id)) ?? await service.store.put(normalizeAccount({ id, auth: "apikey" }))
function readHidden(prompt) {
  if (!process.stdin.isTTY) return new Promise(resolve => { let data = ""; process.stdin.on("data", c => { data += c }); process.stdin.on("end", () => resolve(data.trim())) })
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = text => { if (!muted) process.stdout.write(text) }
    rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()) })
    muted = true
  })
}
const key = await readHidden(`RunPod API key for ${id}: `)
if (!key) { console.error("Empty; nothing stored."); process.exit(1) }
if (!looksLikeApiKey(key)) console.error("Note: RunPod API keys usually start with rpa_. Storing it anyway.")
await service.setApiKey(account, key)
const d = await service.rediscover(account)
console.log(d.error ? `Stored, but RunPod said: ${d.error}` : `Stored. Balance $${d.balance ?? "?"}, ${d.pods ?? "?"} pods.`)
service.dispose()
