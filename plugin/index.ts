import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { installRedaction, PermissionBridge, pluginDataDir, SECURE_KIT_VERSION, sessionRoots, ShellSupplier, type PermissionHost } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import { defaultEffect, type Discovery } from "./model.js"
import { PodDirectory, sshTip } from "./podssh.js"
import { RunpodRpc } from "./rpc.js"
import { PLUGIN_ID, RunpodService } from "./service.js"
import { createTools, TOOL_NAMES } from "./tools.js"

export { PLUGIN_ID, SECURE_KIT_VERSION }

export interface RunpodOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-runpod`. */
  readonly dataDirectory?: string
  /** RunPod MCP URL; default https://mcp.runpod.io/. For tests. */
  readonly mcpUrl?: string
  /** RunPod API base; default https://api.runpod.io. For tests. */
  readonly apiUrl?: string
}

export function parseOptions(raw: unknown): RunpodOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  for (const key of ["dataDirectory", "mcpUrl", "apiUrl"]) if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${PLUGIN_ID}: ${key} must be a string`)
  for (const key of ["mcpUrl", "apiUrl"]) if (options[key] !== undefined && !/^https?:\/\//.test(options[key] as string)) throw new Error(`${PLUGIN_ID}: ${key} must be an http(s) URL`)
  return Object.fromEntries(["dataDirectory", "mcpUrl", "apiUrl"].filter(key => options[key] !== undefined).map(key => [key, options[key]])) as RunpodOptions
}

const SKILL = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url))
const warn = (message: string, error?: unknown) =>
  console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)

/** The bundled know-how plus RunPod's own guidance for agents, once an account has signed in. */
export function skillContent(base: string, discovery: Record<string, Discovery>): string {
  const instructions = Object.values(discovery).find(item => item.instructions)?.instructions
  return instructions ? `${base.trimEnd()}\n\n## RunPod's own guidance for agents (from the RunPod server)\n\nThese describe RunPod's actions (call them through runpod_run). Ignore its remarks that SSH and file transfer are unavailable: this plugin provides them (see above).\n\n${instructions.replace(/^#{1,2} /gm, "### ")}\n` : base
}

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const options = parseOptions(ctx.options)
        const service = await RunpodService.open(pluginDataDir(PLUGIN_ID, options.dataDirectory), {
          ...(options.mcpUrl && { mcpUrl: options.mcpUrl }), ...(options.apiUrl && { apiUrl: options.apiUrl }),
        })
        registrations.push({ dispose: () => service.dispose() })
        const root = sessionRoots(async sessionID => (await ctx.session.get({ sessionID: sessionID as never })).parentID ?? undefined)
        const bridge = new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, root })
        registrations.push(await bridge.install(ctx.permission as unknown as PermissionHost))
        registrations.push(bridge.followReplies(ctx.event as never, error => warn("could not save Allow always", error)))
        service.attach(bridge)
        const pods = new PodDirectory(service)

        const tools = createTools(service, pods)
        registrations.push(await ctx.tool.transform(editor => {
          for (const tool of tools) {
            editor.add({
              name: tool.name, description: tool.description(), input: tool.input as never, options: { codemode: false },
              execute: async (input, context) => {
                try { return await tool.execute(input, context) }
                finally { await service.syncRedactor().catch(error => warn("redactor refresh failed", error)) }
              },
            })
          }
        }))
        registrations.push(await installRedaction(ctx.tool as never, service.redactor, new Set<string>(TOOL_NAMES), error => warn("redaction skipped", error)))

        // ssh/rsync into pods with the agent's own shell: only commands that reference $RUNPOD_SSH_CONFIG are touched.
        const shell = new ShellSupplier({ plugin: PLUGIN_ID, redactor: service.redactor, warn, prepare: (command, caller) => pods.prepareCommand(command, caller), annotate: sshTip })
        registrations.push({ dispose: () => shell.dispose() })
        registrations.push(await ctx.tool.hook("execute.before", event => shell.before(event)))
        registrations.push(await ctx.shell.hook("create.before", event => shell.create(event)))
        registrations.push(await ctx.tool.hook("execute.after", event => shell.after(event as never)))

        let skillReady = false
        try {
          const base = await readFile(SKILL, "utf8")
          const description = /^description:\s*(.+)$/m.exec(base)?.[1] ?? "RunPod know-how"
          registrations.push(await ctx.skill.transform(editor => {
            editor.add({ id: "runpod" as never, name: "runpod" as never, description, path: SKILL as never, content: skillContent(base, service.store.cached().discovery) })
          }))
          skillReady = true
        } catch (error) { warn("skill not registered", error) }

        let reloading: Promise<void> | undefined
        registrations.push({ dispose: service.store.onChange(() => {
          reloading ??= Promise.resolve()
            .then(() => Promise.all([ctx.tool.reload(), skillReady ? ctx.skill.reload() : undefined]))
            .then(() => {}).catch(error => warn("tool reload failed", error)).finally(() => { reloading = undefined })
        }) })

        // Keep the inventory's running pods current (the idle reminder), without blocking anything.
        const timer = setInterval(() => {
          void service.store.list().then(accounts => Promise.all(accounts.map(async account => { if (await service.signedIn(account)) await service.rediscover(account) }))).catch(() => {})
        }, 10 * 60_000)
        timer.unref?.()
        registrations.push({ dispose: () => clearInterval(timer) })

        const admin = createAdmin({
          service, root,
          agents: async () => ((await ctx.agent.list()).data ?? []).filter(agent => !agent.hidden).map(agent => ({ id: agent.id as string, name: agent.name, mode: agent.mode })),
        })
        const handlers = Object.fromEntries(Object.keys(RunpodRpc.methods).map(name => [name, async (input: unknown) => (admin as Record<string, (input: never) => Promise<unknown>>)[name]!(input as never)]))
        registrations.push(await ctx.rpc.register(RunpodRpc, handlers as never))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
