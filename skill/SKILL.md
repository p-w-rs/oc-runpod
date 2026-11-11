---
name: runpod
description: Work effectively on RunPod through the oc-runpod tools — choosing GPUs and prices, creating, starting, stopping and terminating pods, SSH and rsync into pods, network volumes, serverless endpoints and jobs, templates, billing, and keeping costs down. Load before non-trivial RunPod work.
---

# Working on RunPod

## Tools

- `runpod_list` — accounts (personal and teams), balance, running pods with $/hr, uptime and their SSH alias.
- `runpod_find_actions` → `runpod_run` — RunPod's ~120 actions. Read parameters with `names=[...]` before the first
  call; some list only a stub — then run `describe-tool` for the full schema. Bodies are nested
  (`create-pod` takes `{body: {...}}`, `pod-action` takes `{id, body: {action}}`).
- `runpod_rest` — any REST v2 endpoint (`/v2/pods`, `/v2/catalog/gpus`, …) when no action fits.
- `runpod_ssh_setup` — makes SSH work (account key; per pod: exposes 22/tcp and adds the key, which restarts it).
- Several accounts: pass `account` (e.g. `personal`, `team`). Resources live in one account; a pod in the team account
  is invisible from the personal one. When unclear which to use, ask.
- Docs: `search-docs`, `read-guide`; `read_journal` shows this account's notes from earlier sessions.

Permissions (defaults): reads, changes, stopping/restarting pods and SSH run; creating or starting billable things
(`create-pod`, `create-endpoint`, volumes, `pod-action start`), deletes/terminate and admin (SSH keys, secrets,
organization) ask.

## Money comes first

- Pods bill per second while RUNNING (GPU + container disk); stopped pods still bill for their volume disk.
  Network volumes bill monthly while they exist. Serverless bills per second of worker time (idle workers with
  `workers.min > 0` bill continuously). Spending so far: `list-billing`.
- **Before creating or starting anything billable, state the price** (`list-gpu-types` gives $/hr; add
  `include: ["AVAILABILITY"], product: ["POD"]` for stock) and the expected duration.
- **Stop what you started** when the work is done (`pod-action` `{id, body: {action: "stop"}}`). Never stop, terminate
  or delete pods you did not create in this conversation unless the user names them — team pods belong to colleagues.
- Terminate (`pod-action terminate` or `delete-pod`) deletes the pod and its disks (not network volumes). Prefer stop
  unless asked. Invalid actions for the pod's state return 409 (RUNNING: stop/restart/terminate; EXITED: start/terminate).

## Creating a pod (typical)

1. Pick the GPU: `list-gpu-types` (ids like `"NVIDIA GeForce RTX 4090"`); `get-capacity` for stock by CUDA version.
   Secure cloud (default) is more reliable than community cloud and gives direct SSH addresses.
2. Make sure the plugin's key is registered: `runpod_list` / `runpod_refresh` shows the SSH key; if missing,
   `runpod_ssh_setup` (no pod) first — `startSsh` installs only keys registered at creation time.
3. `create-pod` body: `name`, `image` (e.g. `runpod/pytorch:<tag>`) or `templateId`, `gpu: {id, count}` or
   `cpu: {id, vcpuCount}`, `ports: ["22/tcp", "8888/http"]`, **`startSsh: true`**, `disk` (GB, container), `env`,
   optional `dataCenterIds`, and `mounts`: `{persistent: {size, path: "/workspace"}}` or
   `{network: [{volumeId, path}]}` (a network volume pins the pod to that volume's data center).
4. Wait for `RUNNING` (`get-pod`), then use SSH. Startup problems: `stream-pod-logs`.

## SSH and files (your own shell)

```sh
ssh -F "$RUNPOD_SSH_CONFIG" rp-team-my-pod 'nvidia-smi && cd /workspace && ls'
rsync -az -e "ssh -F '$RUNPOD_SSH_CONFIG'" ./data/ rp-team-my-pod:/workspace/data/
scp -F "$RUNPOD_SSH_CONFIG" rp-team-my-pod:/workspace/out.log .
```

- Aliases are `rp-<account>-<pod name>` (see `runpod_list`); write them literally in the command. The config holds
  only the pods a command names; their current address is looked up each time (addresses change on restart).
- Long jobs: run them detached (`nohup … > /workspace/run.log 2>&1 &` or `tmux`) and check the log later; a
  dropped SSH connection must not kill training.
- Put results on the mounted volume (usually `/workspace`): the container disk is reset when a pod is restarted or
  updated.
- Not ready? The command's note says why: not running, no port 22 or created without the plugin's key
  (`runpod_ssh_setup pod=…`, restarts the pod — ask first if it holds work), or no public address (community cloud).
- RunPod's relay (`ssh.runpod.io`) is interactive-only and does not run commands or transfers; the plugin uses the
  pod's direct address instead.

## Serverless

Endpoints run a worker image; jobs go through `run-endpoint` (async, then `get-job-status` with `wait` in ms, up to
45000) or `runsync-endpoint` (short jobs on a warm endpoint). Jobs stuck `IN_QUEUE`: `list-endpoint-workers` and
`stream-worker-logs` (a crash-looping worker can look RUNNING). Cold starts take minutes. Keep `workers.min` at 0
unless the user wants warm workers.

## Errors

401 = key invalid or deleted (sign in again); 403 = the key's account lacks permission; 409 = action not valid in the
pod's state; 422 = request shape (read the schema again); "no instances available" = that GPU is out of stock
(another data center, GPU type or cloud).
