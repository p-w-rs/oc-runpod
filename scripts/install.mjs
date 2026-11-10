// Adds this plugin to the global OpenCode config (comment-preserving, with a backup).
//   (default)    build a verified immutable snapshot under $XDG_DATA_HOME/oc-runpod/releases and activate it
//   --dev        point OpenCode at this checkout instead
//   --rollback   switch back to the previously active snapshot (verified first)
//   --uninstall  remove only this plugin's entry; data, vault and snapshots are kept
//   --status     show what is installed and whether the active snapshot is intact (changes nothing)
// Plugin options already in the config entry are always kept.
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { applyEdits, modify, parse } from "jsonc-parser"

const NAME = "oc-runpod"
const MANIFEST = ".oc-release.json"
const KEEP = 3
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const releasesDir = () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), NAME, "releases")
const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
const statePath = () => join(releasesDir(), "installation.json")
const sha256 = data => createHash("sha256").update(data).digest("hex")

const run = (cmd, argv, cwd) => {
  const result = spawnSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (result.error || result.status !== 0) throw result.error || new Error(`${cmd} ${argv[0]} failed (${result.status}): ${result.stderr.trim().slice(-2000)}`)
  return result.stdout
}

async function walk(base, directory = "") {
  const result = []
  for (const entry of (await readdir(join(base, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walk(base, path))
    else if (entry.isFile() && path !== MANIFEST) result.push(path)
  }
  return result
}

/** Checks every file of a snapshot against its manifest. Throws if anything was added, removed or changed. */
export async function verifyRelease(target) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(target, MANIFEST), "utf8")) }
  catch (error) { throw new Error(`${target} is not a complete ${NAME} snapshot (${error.code ?? error.message})`) }
  if (manifest.name !== NAME || !manifest.files || !manifest.files["plugin/index.ts"] || !manifest.files["dist/gui-experimental.cjs"]) {
    throw new Error(`${target}: snapshot manifest is incomplete`)
  }
  const actual = await walk(target)
  const expected = Object.keys(manifest.files)
  const extra = actual.filter(file => !(file in manifest.files))
  const missing = expected.filter(file => !actual.includes(file))
  if (extra.length || missing.length) throw new Error(`${target} was modified (${[...missing.map(f => `missing ${f}`), ...extra.map(f => `added ${f}`)].slice(0, 5).join(", ")})`)
  for (const file of expected) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Invalid path in snapshot manifest")
    if (sha256(await readFile(join(target, file))) !== manifest.files[file]) throw new Error(`${target} was modified (${file})`)
  }
  return manifest
}

/** Packs this checkout, installs its locked runtime dependencies, checks they load, and records every file's hash. */
export async function deploy() {
  try { await stat(join(root, "dist", "gui-experimental.cjs")) }
  catch { throw new Error("The GUI bundle is not built (dist/gui-experimental.cjs). Run: pixi run --locked build") }
  const scratch = join(root, ".local", "pack")
  await mkdir(scratch, { recursive: true })
  for (const old of await readdir(scratch)) if (old.endsWith(".tgz")) await unlink(join(scratch, old))
  const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", scratch, "--cache", join(root, ".local", "npm-cache")], root))
  const tarball = join(scratch, info.filename)
  const fingerprint = sha256(Buffer.concat([await readFile(tarball), Buffer.from(`${process.platform}-${process.arch}`)]))
  const directory = releasesDir()
  const target = join(directory, `${info.version}-${fingerprint.slice(0, 12)}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const existing = await verifyRelease(target)
    if (existing.fingerprint === fingerprint) return target
    throw new Error(`${target} exists with different contents; remove it after checking it is not in use`)
  } catch (error) { if (!/is not a complete/.test(error.message)) throw error }
  try { await stat(target); throw new Error(`${target} exists but is incomplete. If no install is running, remove it and retry.`) }
  catch (error) { if (error.code !== "ENOENT") throw error }

  const staging = join(directory, `.staging-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    run("tar", ["-xzf", tarball, "-C", staging, "--strip-components=1"], root)
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(root, ".local", "npm-cache")], staging)
    // Runtime dependencies must resolve from the snapshot itself.
    const check = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const kit = await import('oc-secure-kit'); const j = await import('jsonc-parser'); if (!kit.SECURE_KIT_VERSION || !j.parse) process.exit(3); console.log(kit.SECURE_KIT_VERSION)"],
      { cwd: staging, encoding: "utf8" })
    if (check.status !== 0) throw new Error(`Snapshot dependencies do not load: ${check.stderr.trim().slice(-1000)}`)
    const files = {}
    for (const file of await walk(staging)) files[file] = sha256(await readFile(join(staging, file)))
    const manifest = { name: NAME, version: info.version, fingerprint, secureKit: check.stdout.trim(), platform: `${process.platform}-${process.arch}`, created: new Date().toISOString(), files }
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
    await rename(staging, target)
    return target
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function readState() {
  try { return JSON.parse(await readFile(statePath(), "utf8")) }
  catch (error) { if (error.code === "ENOENT") return {}; throw error }
}
async function writeState(state) {
  await mkdir(releasesDir(), { recursive: true, mode: 0o700 })
  const temporary = `${statePath()}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await rename(temporary, statePath())
}

/** Removes old snapshots, keeping the newest few plus the current and previous ones. Never touches anything else. */
async function prune(state) {
  const keep = new Set([state.current, state.previous].filter(Boolean))
  const snapshots = []
  for (const entry of await readdir(releasesDir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const path = join(releasesDir(), entry.name)
    try { snapshots.push({ path, created: Date.parse(JSON.parse(await readFile(join(path, MANIFEST), "utf8")).created) }) } catch {}
  }
  snapshots.sort((a, b) => b.created - a.created)
  const removed = []
  for (const [index, snapshot] of snapshots.entries()) {
    if (index < KEEP || keep.has(snapshot.path)) continue
    await rm(snapshot.path, { recursive: true, force: true })
    removed.push(snapshot.path)
  }
  return removed
}

/** Points the config's entry for this plugin at `target` (or removes it). Keeps options, comments and other plugins. */
async function updateConfig(target) {
  const directory = configDir()
  await mkdir(directory, { recursive: true })
  let path = join(directory, "opencode.jsonc")
  let source
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try { source = await readFile(join(directory, name), "utf8"); path = join(directory, name); break }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
  const existed = source !== undefined
  source ??= '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
  const errors = []
  const config = parse(source, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid config: ${path}`)
  const plugins = config.plugins ?? []
  if (!Array.isArray(plugins)) throw new Error(`Expected a V2 plugins array in ${path}; refusing to rewrite it.`)
  const entryPath = entry => typeof entry === "string" ? entry : entry?.package
  const owned = plugins.flatMap((entry, index) => {
    const p = entryPath(entry)
    return typeof p === "string" && (p === root || p.startsWith(`${releasesDir()}/`)) ? [index] : []
  })
  const done = target === undefined ? owned.length === 0 : owned.length === 1 && entryPath(plugins[owned[0]]) === target
  if (!done) {
    const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
    let updated = source
    if (!Array.isArray(config.plugins)) updated = applyEdits(updated, modify(updated, ["plugins"], [target], format))
    else if (owned.length === 1 && target !== undefined) {
      const first = owned[0]
      updated = applyEdits(updated, modify(updated, typeof plugins[first] === "string" ? ["plugins", first] : ["plugins", first, "package"], target, format))
    } else if (!owned.length) updated = applyEdits(updated, modify(updated, ["plugins", plugins.length], target, format))
    else {
      // jsonc-parser 3.3.1 corrupts single-line arrays when removing an object element, so removals rewrite the
      // whole array (comments inside the plugins array are lost; everything else is kept).
      const next = plugins.flatMap((entry, index) => {
        if (!owned.includes(index)) return [entry]
        if (target === undefined || index !== owned[0]) return []
        return [typeof entry === "string" ? target : { ...entry, package: target }]
      })
      updated = applyEdits(updated, modify(updated, ["plugins"], next, format))
    }
    const check = []
    const reparsed = parse(updated, check, { allowTrailingComma: true })
    if (check.length || JSON.stringify(reparsed.plugins.map(entryPath)) !== JSON.stringify(
      target === undefined ? plugins.filter((_, i) => !owned.includes(i)).map(entryPath)
        : owned.length ? plugins.flatMap((entry, i) => !owned.includes(i) ? [entryPath(entry)] : i === owned[0] ? [target] : [])
        : [...plugins.map(entryPath), target])) {
      throw new Error(`Refusing to write ${path}: the edited config did not come out as expected. Nothing was changed.`)
    }
    if (existed) {
      if (await readFile(path, "utf8") !== source) throw new Error("OpenCode configuration changed during installation; retry.")
      const backup = `${path}.${NAME}-${Date.now()}.bak`
      await copyFile(path, backup)
      await chmod(backup, 0o600)
    }
    const temporary = `${path}.${NAME}-${process.pid}.tmp`
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  }
  const active = owned.length ? entryPath(plugins[owned[0]]) : undefined
  return { path, changed: !done, active }
}

async function main(args) {
  const allowed = ["--dev", "--rollback", "--uninstall", "--status"]
  if (args.length > 1 || args.some(arg => !allowed.includes(arg))) throw new Error(`Usage: install.mjs [${allowed.join(" | ")}]`)
  const [mode = "install"] = args.map(arg => arg.slice(2))
  if (!["darwin", "linux"].includes(process.platform)) throw new Error(`${NAME} supports macOS and Linux only`)

  if (mode === "status") {
    const state = await readState()
    console.log(`Releases: ${releasesDir()}`)
    console.log(`Current:  ${state.current ?? "(none)"}${state.dev ? " (development link)" : ""}`)
    console.log(`Previous: ${state.previous ?? "(none)"}`)
    if (state.current && !state.dev) {
      try { const manifest = await verifyRelease(state.current); console.log(`Verified: ${Object.keys(manifest.files).length} files intact (version ${manifest.version}, secure-kit ${manifest.secureKit})`) }
      catch (error) { console.log(`PROBLEM:  ${error.message}`); process.exitCode = 1 }
    }
    return
  }

  await mkdir(configDir(), { recursive: true })
  const guard = join(configDir(), `.${NAME}-install.lock`)
  try { await writeFile(guard, String(process.pid), { flag: "wx", mode: 0o600 }) }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another ${NAME} install holds ${guard}. If a prior run crashed, confirm it stopped before removing the lock.`)
    throw error
  }
  try {
    const state = await readState()
    if (mode === "uninstall") {
      const result = await updateConfig(undefined)
      await writeState({ ...state, current: undefined, dev: undefined, previous: state.current ?? state.previous })
      console.log(`${NAME} ${result.changed ? "removed from" : "already absent from"} ${result.path}. Data, vault and snapshots were kept; reinstall or --rollback to return.`)
      return
    }
    let target
    if (mode === "dev") target = root
    else if (mode === "rollback") {
      if (!state.previous) throw new Error("No previous snapshot to roll back to")
      if (state.previous !== root) await verifyRelease(state.previous)
      target = state.previous
    } else target = await deploy()
    if (target !== root) await verifyRelease(target)
    const result = await updateConfig(target)
    const next = { current: target, dev: target === root || undefined, previous: state.current && state.current !== target ? state.current : state.previous }
    await writeState(next)
    const removed = await prune(next)
    console.log(`${NAME} ${result.changed ? (mode === "rollback" ? "rolled back" : "installed") : "already active"} in ${result.path}`)
    console.log(`Plugin:   ${target}${target === root ? " (development link)" : " (verified snapshot)"}`)
    if (next.previous) console.log(`Previous: ${next.previous} (pixi run rollback)`)
    if (removed.length) console.log(`Removed ${removed.length} old snapshot(s).`)
    console.log("OpenCode picks up config changes automatically; use /reload if needed.")
  } finally { await unlink(guard) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`${NAME}: ${error.message}`); process.exit(1) })
}
