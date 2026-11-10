// Installer end to end in an isolated XDG home: install, idempotent reinstall, options kept, tamper detection,
// rollback, uninstall. Builds a real snapshot (npm pack + npm ci from the local cache).
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parse } from "jsonc-parser"

const root = resolve(import.meta.dirname, "..")
const home = await mkdtemp(join(tmpdir(), "ocm-install-"))
after(async () => { await rm(home, { recursive: true, force: true }) })
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") }
const configPath = join(home, "config", "opencode", "opencode.jsonc")
const releases = join(home, "data", "oc-runpod", "releases")

const install = (...args: string[]) => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "install.mjs"), ...args], { cwd: root, env, encoding: "utf8" })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const entries = async () => (parse(await readFile(configPath, "utf8")) as { plugins: unknown[] }).plugins
const state = async () => JSON.parse(await readFile(join(releases, "installation.json"), "utf8"))

test("install, keep options and comments, detect tampering, roll back, uninstall", { timeout: 300_000 }, async () => {
  await mkdir(join(home, "config", "opencode"), { recursive: true })
  await writeFile(configPath, `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/some/other/plugin", { "package": "${root}", "options": { "dataDirectory": "/tmp/x" } }]
}
`)
  // 1. Fresh snapshot replaces the development link and keeps its options.
  const first = install()
  assert.equal(first.code, 0, first.out)
  const snapshot = (await state()).current as string
  assert.ok(snapshot.startsWith(releases), snapshot)
  assert.deepEqual(await entries(), ["/some/other/plugin", { package: snapshot, options: { dataDirectory: "/tmp/x" } }])
  assert.match(await readFile(configPath, "utf8"), /\/\/ my settings/)
  assert.ok((await readdir(join(home, "config", "opencode"))).some(name => name.endsWith(".bak")), "backup made")
  assert.match(install("--status").out, /Verified: \d+ files intact/)

  // 2. Reinstalling the same source is a no-op.
  assert.match(install().out, /already active/)

  // 3. A modified snapshot is detected and never activated.
  await appendFile(join(snapshot, "plugin", "index.ts"), "\n// tampered\n")
  const status = install("--status")
  assert.equal(status.code, 1)
  assert.match(status.out, /PROBLEM: .*was modified \(plugin\/index\.ts\)/)
  assert.match(install().out, /exists with different contents|was modified/)
  await writeFile(join(snapshot, "plugin", "index.ts"), (await readFile(join(snapshot, "plugin", "index.ts"), "utf8")).replace("\n// tampered\n", ""))

  // 4. Dev link, then roll back to the snapshot.
  assert.equal(install("--dev").code, 0)
  assert.equal(((await entries())[1] as { package: string }).package, root)
  const back = install("--rollback")
  assert.equal(back.code, 0, back.out)
  assert.match(back.out, /rolled back/)
  assert.equal(((await entries())[1] as { package: string }).package, snapshot)

  // 5. Uninstall removes only our entry; reinstall-by-rollback works after it.
  const removed = install("--uninstall")
  assert.match(removed.out, /removed from/)
  assert.deepEqual(await entries(), ["/some/other/plugin"])
  assert.ok((await readdir(releases)).includes(snapshot.split("/").pop()!), "snapshot kept")
  const restored = install("--rollback")
  assert.equal(restored.code, 0, restored.out)
  assert.equal(((await entries())[1] as string), snapshot)
})
