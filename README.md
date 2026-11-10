# oc-runpod

[RunPod](https://runpod.io) for OpenCode agents: GPU and CPU pods, serverless
endpoints and jobs, network volumes, templates and billing — plus **SSH and
rsync into running pods with the agent's own shell**. Spending is guarded: by
default anything that starts billing, deletes, or changes admin settings asks
first, and the agent always sees which pods are running and what they cost.
macOS and Linux; OpenCode 2.2.6+ and Pixi.

## Accounts and sign-in

One RunPod login can switch between a personal account and teams (the account
menu in the console). Each of those is its own account here, e.g. `personal`
and `team`.

| `auth` | How |
|---|---|
| `browser` (default) | "Sign in with Runpod": select the account/team in the console's account menu first, then authorize. RunPod creates an API key for that account/team. |
| `apikey` | Create a key in the console (Settings → API keys) and enter it in the GUI or with `pixi run key-set <account>`. |

Keys never expire on their own; they are stored encrypted and never shown to the
agent. Removing an account here does not delete the key in RunPod.

## What agents get

| Tool | |
|---|---|
| `runpod_list` | Accounts, balances, running pods with $/hr, uptime and SSH alias; also in the tool description, so agents remember to stop pods |
| `runpod_find_actions` / `runpod_run` | RunPod's ~120 actions (pods, GPUs, serverless, volumes, templates, billing, logs) |
| `runpod_rest` | Any REST v2 endpoint |
| `runpod_ssh_setup` | Adds the plugin's SSH key to an account (keeping other keys) and, per pod, exposes 22/tcp and adds the key (restarts the pod) |
| `runpod_account_upsert` / `_remove`, `runpod_signin`, `runpod_refresh`, `runpod_request_key` | Setup |

SSH uses the pod's direct address (RunPod's `ssh.runpod.io` relay is
interactive-only). In the agent's shell:

```sh
ssh -F "$RUNPOD_SSH_CONFIG" rp-team-train-1 'nvidia-smi'
rsync -az -e "ssh -F '$RUNPOD_SSH_CONFIG'" ./data/ rp-team-train-1:/workspace/data/
```

Only commands that reference `$RUNPOD_SSH_CONFIG` are touched; the config holds
just the pods named, with their current address, the plugin's key and per-pod
host keys. The `runpod` skill covers prices, creating pods, volumes, SSH habits
(detached jobs, `/workspace`), serverless and errors, plus RunPod's own guidance.

## Permissions

Per account, for pods, serverless, storage, templates/keys/billing and other
actions: read, change, **create/start (costs)**, delete, admin; plus SSH into
pods and edit/remove account. Defaults: reads, changes (including stopping
pods) and SSH run; creating or starting billable resources, deleting, admin and
unknown writes ask. Every cell is editable in the GUI (`/runpod`, the
Review-pane **+** menu, or **Settings → RunPod**); **Allow always** on a prompt
writes allow. RunPod's own permissions still apply.

## Install

Requires [OpenCode](https://opencode.ai) 2.2.6+ (CLI or Desktop) and [Pixi](https://pixi.sh); macOS or Linux.

```sh
git clone https://github.com/p-w-rs/oc-runpod.git && cd oc-runpod
pixi run --locked install          # runs the tests, then installs a verified snapshot into your OpenCode config
```

Restart OpenCode (or `/reload`). Then open **Settings → RunPod** (or `/runpod` in a session) and add an account, or from a terminal: `pixi run signin personal`.
Agents can also set things up for you when you ask.

```sh
pixi run --locked install-status   # what is installed, and whether its files are intact
pixi run --locked rollback         # back to the previous snapshot
pixi run --locked uninstall        # removes only this plugin's entry; your data stays
```

Updating: `git pull && pixi run --locked install`. Accounts, sign-ins and permissions live in
`~/.local/share/oc-runpod` and survive updates; move them between computers with **Export** / **Import** in the view.

## Development

```sh
pixi run --locked test            # fake RunPod (sign-in, MCP, REST) + a real local sshd for ssh/rsync
pixi run --locked smoke-host      # real OpenCode 2.2.6 CLI, scripted model, fake RunPod and sshd
```
