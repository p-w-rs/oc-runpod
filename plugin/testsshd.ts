// Test helper: a throwaway sshd on 127.0.0.1 running as the current user (public-key login only).
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

async function which(name: string): Promise<string> {
  return (await exec("sh", ["-c", `command -v ${name}`])).stdout.trim()
}

export interface TestSshd {
  readonly port: number
  readonly user: string
  readonly dir: string
  readonly authorizedKeys: string
  /** HOME of ssh sessions (a temp directory). */
  readonly home: string
  /** A client key already authorized; `passphrase` protects it. */
  readonly clientKey: string
  readonly passphrase: string
  stop(): Promise<void>
}

export async function startSshd(): Promise<TestSshd> {
  const dir = await mkdtemp(join(tmpdir(), "ocrp-sshd-"))
  const sshd = await which("sshd")
  const port = await freePort()
  const user = userInfo().username
  const passphrase = "client-key-passphrase"
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host_key")])
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-f", join(dir, "client_key")])
  // Sessions get a throwaway HOME, so remote commands like "~/.ssh/authorized_keys" never touch the real account.
  const home = join(dir, "home")
  await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 })
  const authorizedKeys = join(home, ".ssh", "authorized_keys")
  await writeFile(authorizedKeys, await readFile(join(dir, "client_key.pub"), "utf8"), { mode: 0o600 })
  const libexec = join(dirname(dirname(sshd)), "libexec")
  await writeFile(join(dir, "sshd_config"), [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${join(dir, "host_key")}`, `PidFile ${join(dir, "sshd.pid")}`,
    `AuthorizedKeysFile ${authorizedKeys}`, `SetEnv HOME=${home}`, "StrictModes no", "UsePAM no", "PasswordAuthentication no",
    "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", `AllowUsers ${user}`, "LogLevel ERROR",
    `SshdSessionPath ${join(libexec, "sshd-session")}`, `SshdAuthPath ${join(libexec, "sshd-auth")}`,
    `Subsystem sftp ${join(libexec, "sftp-server")}`,
  ].join("\n") + "\n")
  const child: ChildProcess = spawn(sshd, ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] })
  let log = ""
  child.stderr!.on("data", chunk => { log += chunk })
  // Wait until it accepts connections.
  const deadline = Date.now() + 10_000
  for (;;) {
    try { await exec("ssh-keyscan", ["-p", String(port), "-T", "1", "127.0.0.1"]); break }
    catch {
      if (child.exitCode !== null || Date.now() > deadline) { child.kill(); throw new Error(`sshd did not start: ${log}`) }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  return {
    port, user, dir, authorizedKeys, home, clientKey: join(dir, "client_key"), passphrase,
    async stop() { child.kill(); await rm(dir, { recursive: true, force: true }) },
  }
}
