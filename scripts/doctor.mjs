// Reports whether this checkout is ready to load in OpenCode. Read-only.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const checks = []
const check = async (label, fn) => {
  try { checks.push([true, label, (await fn()) ?? ""]) } catch (error) { checks.push([false, label, error.message]) }
}

await check("platform", async () => {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error(`unsupported: ${process.platform}`)
  return `${process.platform}-${process.arch}, node ${process.versions.node}`
})
await check("vendored secure-kit checksum", async () => {
  const [line] = (await readFile(join(root, "vendor", "SHA256SUMS"), "utf8")).trim().split("\n")
  const [expected, name] = line.split(/\s+/)
  const actual = createHash("sha256").update(await readFile(join(root, "vendor", name))).digest("hex")
  if (actual !== expected) throw new Error(`${name} does not match SHA256SUMS`)
  return name
})
await check("GUI bundle built", async () => { await access(join(root, "dist", "gui-experimental.cjs")); return "dist/gui-experimental.cjs" })
await check("installed snapshot", async () => {
  const { releasesDir, verifyRelease } = await import("./install.mjs")
  let state = {}
  try { state = JSON.parse(await readFile(join(releasesDir(), "installation.json"), "utf8")) } catch {}
  if (!state.current) return "not installed (pixi run install)"
  if (state.dev) return `development link: ${state.current}`
  const manifest = await verifyRelease(state.current)
  return `${state.current} (${Object.keys(manifest.files).length} files intact)`
})

for (const [ok, label, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`)
process.exit(checks.every(([ok]) => ok) ? 0 : 1)
