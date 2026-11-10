---
name: runpod
description: Work effectively on RunPod through the oc-runpod tools — choosing GPUs and prices, creating, starting, stopping and terminating pods, SSH and rsync into pods, network volumes, serverless endpoints and jobs, templates, billing, and keeping costs down. Load before non-trivial RunPod work.
---

# Working on RunPod

## Tools

- `runpod_list` — accounts (personal and teams), balance, running pods with $/hr, uptime and their SSH alias.
- `runpod_find_actions` → `runpod_run` — RunPod's ~120 actions. Read parameters with `names=[...]` before the first
  call; bodies are nested (e.g. `create-pod` takes `{body: {name, image, gpu: {id, count}, ...}}`).
- `runpod_rest` — any REST v2 endpoint (`/v2/pods`, `/v2/catalog/gpus`, …) when no action fits.
- `runpod_ssh_setup` — makes SSH work (account key; per pod: exposes 22/tcp and adds the key, which restarts it).
- Several accounts: pass `account` (e.g. `personal`, `team`). Resources live in one account; a pod in the team account
  is invisible from the personal one. When unclear which to use, ask.

## Money comes first

- Pods bill per second while RUNNING (GPU + container disk); stopped pods still bill for their volume disk.
  Network volumes bill monthly while they exist. Serverless bills per second of worker time (idle workers with
  `workers.min > 0` bill continuously).
- **Before creating or starting anything billable, state the price** (`list-gpu-types` / `get-capacity` give $/hr)
  and the expected duration. Creating and starting usually ask the user.
- **Stop what you started** when the work is done (`pod-action` `{action: "stop"}`). Never stop, terminate or delete
  pods you did not create in this conversation unless the user names them — team pods belong to colleagues.
- Terminate deletes the pod and its disks (not network volumes). Prefer stop unless asked.

## Creating a pod (typical)

1. Pick the GPU: `list-gpu-types` / `get-capacity` (stock by data center). Secure cloud is more reliable than
   community cloud.
2. `create-pod` with `name`, `image` (e.g. `runpod/pytorch:<tag>`), `gpu: {id, count}` or `cpu: {id, vcpuCount}`,
   `ports: ["22/tcp", "8888/http"]`, **`startSsh: true`** (puts the account's SSH keys, including the plugin's, on
   the pod), optional `mounts` for a network volume (data that must survive the pod) and `env`.
3. Wait for `RUNNING` (`get-pod`), then use SSH.

## SSH and files (your own shell)

```sh
ssh -F "$RUNPOD_SSH_CONFIG" rp-team-my-pod 'nvidia-smi && cd /workspace && ls'
rsync -az -e "ssh -F '$RUNPOD_SSH_CONFIG'" ./data/ rp-team-my-pod:/workspace/data/
scp -F "$RUNPOD_SSH_CONFIG" rp-team-my-pod:/workspace/out.log .
```

- Aliases are `rp-<account>-<pod name>` (see `runpod_list`). The config holds only the pods a command names; their
  current address is looked up each time (addresses change when pods restart).
- Long jobs: run them detached (`nohup … > /workspace/run.log 2>&1 &` or `tmux`) and poll the log; a dropped SSH
  connection must not kill training.
- Put results in `/workspace` (the volume): the container disk is reset when a pod is restarted or updated.
- Not ready? `runpod_list` shows why: not running, no port 22 (`runpod_ssh_setup pod=…`), or created before the
  plugin's key existed (`runpod_ssh_setup pod=…`, restarts the pod — ask first if it holds work).
- RunPod's relay (`ssh.runpod.io`) is interactive-only and does not run commands or transfers; the plugin uses the
  pod's direct address instead.

## Serverless

Endpoints run a worker image; jobs go through `run-endpoint` (async, then `get-job-status` with `wait`) or
`runsync-endpoint` (short jobs on a warm endpoint). Check `endpoint-health` and worker states when jobs queue.
Cold starts take minutes. Keep `workers.min` at 0 unless the user wants warm workers.

## Errors

401 = key invalid or deleted (sign in again); 403 = the key's account lacks permission; 422 = request shape (read
the schema again); "no instances available" = that GPU is out of stock (another data center, GPU type or cloud).
