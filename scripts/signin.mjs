// Browser sign-in for a RunPod account or team from a terminal (the GUI and runpod_signin do the same).
//   pixi run signin <account> [--team "Team name"]
// Before signing in, select that account/team in the RunPod console's account menu. Never prints keys.
import { spawn } from "node:child_process"
import { pluginDataDir } from "oc-secure-kit"
import { mergeAccount, normalizeAccount } from "../plugin/model.ts"
import { RunpodService } from "../plugin/service.ts"

const args = process.argv.slice(2)
// Option values may arrive split on spaces (pixi passes arguments unquoted): take words up to the next --option.
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const rest = args.slice(i + 1); const end = rest.findIndex(arg => arg.startsWith("--")); return rest.slice(0, end < 0 ? undefined : end).join(" ") || undefined }
const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined
if (!id) { console.error('Usage: pixi run signin <account> [--team "Team name"]'); process.exit(2) }

const service = await RunpodService.open(pluginDataDir("oc-runpod", process.env.OC_RUNPOD_DATA_DIR || undefined), { ...(process.env.OC_RUNPOD_MCP_URL && { mcpUrl: process.env.OC_RUNPOD_MCP_URL }), ...(process.env.OC_RUNPOD_API_URL && { apiUrl: process.env.OC_RUNPOD_API_URL }) })
let account = await service.store.get(id)
if (!account || option("--team")) account = await service.store.put(normalizeAccount({ ...mergeAccount(account, {}), id, auth: "browser", ...(option("--team") && { team: option("--team") }) }))
const state = await service.startSignIn(account)
console.log(`\nIn the RunPod console, select ${account.team ? `"${account.team}"` : "the account or team this should use"} in the account menu (top right) first.\nThen sign in and click Authorize. If the browser does not open, visit:\n\n${state.url}\n`)
if (!process.env.OC_RUNPOD_NO_BROWSER) spawn(process.platform === "darwin" ? "open" : "xdg-open", [state.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
while (state.status === "waiting") await new Promise(resolve => setTimeout(resolve, 500))
if (state.status !== "done") { console.error(`Sign-in did not finish: ${state.error}`); process.exit(1) }
const d = await service.store.discovery(id)
console.log(`Signed in. Balance: ${d?.balance !== undefined ? `$${d.balance}` : "?"}. Pods: ${d?.pods ?? "?"} (${d?.running?.length ?? 0} running). Actions: ${d?.actions ?? 0}.`)
if (d?.error) console.log(`Problem: ${d.error}`)
service.dispose()
process.exit(d?.error ? 1 : 0)
