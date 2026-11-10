// Replaces the vendored secure-kit tarball and repins package.json to it.
// Usage: pixi run vendor-kit <path/to/oc-secure-kit-X.Y.Z.tgz>
import { createHash } from "node:crypto"
import { copyFile, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = process.argv[2]
if (!source || !/^oc-secure-kit-\d+\.\d+\.\d+(-[\w.]+)?\.tgz$/.test(basename(source))) {
  throw new Error("Usage: pixi run vendor-kit <path/to/oc-secure-kit-X.Y.Z.tgz>")
}
const name = basename(source)
const vendor = join(root, "vendor")
await copyFile(resolve(source), join(vendor, name))
for (const old of await readdir(vendor)) if (old.startsWith("oc-secure-kit-") && old !== name) await unlink(join(vendor, old))

const sha256 = createHash("sha256").update(await readFile(join(vendor, name))).digest("hex")
await writeFile(join(vendor, "SHA256SUMS"), `${sha256}  ${name}\n`)

const manifestPath = join(root, "package.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
manifest.dependencies["oc-secure-kit"] = `file:vendor/${name}`
const temporary = `${manifestPath}.${process.pid}.tmp`
await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n")
await rename(temporary, manifestPath)
console.log(`Vendored ${name} (sha256 ${sha256}). Now run: pixi run deps-update`)
