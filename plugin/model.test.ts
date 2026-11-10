import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyAction, classifyRest, defaultEffect, normalizeAccount, podAlias } from "./model.js"
import { renderPodConfig, sshState } from "./podssh.js"
import { publicKeyOf } from "./service.js"
import { inventory } from "./tools.js"

test("accounts: defaults and validation", () => {
  assert.deepEqual(normalizeAccount({ id: "team", team: "ASI R&D Team" }, new Date(0)), { id: "team", auth: "browser", team: "ASI R&D Team", updatedAt: "1970-01-01T00:00:00.000Z" })
  assert.equal(normalizeAccount({ id: "k", auth: "apikey" }).auth, "apikey")
  assert.throws(() => normalizeAccount({ id: "k", auth: "password" }), /auth/)
  assert.throws(() => normalizeAccount({ id: "k", key: "rpa_x" }), /Unknown account field/)
})

test("actions: costs, deletes and admin are separated from reads and edits", () => {
  const ro = { readOnlyHint: true }
  const cases: [string, object, Record<string, unknown>, string][] = [
    ["list-pods", ro, {}, "pods-read"], ["get-capacity", ro, {}, "pods-read"], ["stream-pod-logs", ro, {}, "pods-read"],
    ["create-pod", {}, {}, "pods-spend"], ["create-cluster", {}, {}, "pods-spend"], ["update-pod", {}, {}, "pods-write"],
    ["pod-action", {}, { id: "p", body: { action: "start" } }, "pods-spend"], ["pod-action", {}, { id: "p", body: { action: "stop" } }, "pods-write"],
    ["pod-action", {}, { id: "p", body: { action: "terminate" } }, "pods-delete"], ["delete-pod", {}, {}, "pods-delete"],
    ["create-endpoint", {}, {}, "serverless-spend"], ["deploy-hub-repo", {}, {}, "serverless-spend"], ["run-endpoint", {}, {}, "serverless-write"],
    ["purge-endpoint-queue", {}, {}, "serverless-delete"], ["create-network-volume", {}, {}, "storage-spend"], ["delete-network-volume", {}, {}, "storage-delete"],
    ["list-registries", ro, {}, "account-read"], ["create-template", {}, {}, "account-write"], ["update-ssh-keys", {}, {}, "account-admin"],
    ["create-organization-invite", {}, {}, "account-admin"], ["list-billing", ro, {}, "account-read"],
    ["search-docs", ro, {}, "other-read"], ["describe-tool", ro, {}, "other-read"], ["report_feedback", {}, {}, "other-write"], ["brand-new-thing", {}, {}, "other-write"],
  ]
  for (const [name, annotations, args, expected] of cases) assert.equal(classifyAction(name, annotations, args), expected, name)
  assert.equal(classifyRest("GET", "/v2/pods"), "pods-read")
  assert.equal(classifyRest("POST", "/v2/pods"), "pods-spend")
  assert.equal(classifyRest("POST", "/v2/pods/abc/action", { action: "start" }), "pods-spend")
  assert.equal(classifyRest("POST", "/v2/pods/abc/action", { action: "stop" }), "pods-write")
  assert.equal(classifyRest("DELETE", "/v2/network-volumes/x"), "storage-delete")
  assert.equal(classifyRest("PUT", "/v2/user/ssh-keys"), "account-admin")
})

test("defaults: reads, edits and SSH allowed; costs, deletes, admin, unknown writes ask", () => {
  for (const capability of ["pods-read", "pods-write", "ssh", "manage"]) assert.equal(defaultEffect(capability), "allow")
  for (const capability of ["pods-spend", "pods-delete", "serverless-spend", "storage-spend", "account-admin", "other-write", "remove"]) assert.equal(defaultEffect(capability), "ask")
})

test("pod aliases, SSH readiness and config", () => {
  assert.equal(podAlias("team", { id: "abc", name: "S2VLA us_w1" }), "rp-team-s2vla-us-w1")
  assert.equal(podAlias("Team.B", { id: "abc123" }), "rp-team-b-abc123")
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPluginKeyPluginKeyPluginKeyPluginKey000 oc-runpod:team"
  const direct = { host: "1.2.3.4", port: 15776, username: "root" }
  assert.equal(sshState({ id: "p", status: "EXITED" }, key), "stopped")
  assert.equal(sshState({ id: "p", status: "RUNNING", ports: ["8888/http"], ssh: { direct: null } }, key), "no-port")
  assert.equal(sshState({ id: "p", status: "RUNNING", ports: ["22/tcp"], ssh: { direct: null }, startedAt: new Date(Date.now() - 3_600_000).toISOString() }, key), "no-ip")
  assert.equal(sshState({ id: "p", status: "RUNNING", ports: ["22/tcp"], ssh: { direct: null }, startedAt: new Date().toISOString() }, key), "unknown")
  assert.equal(sshState({ id: "p", status: "RUNNING", ssh: { direct }, env: { PUBLIC_KEY: "ssh-ed25519 OTHER x" } }, key), "no-key")
  assert.equal(sshState({ id: "p", status: "RUNNING", ssh: { direct }, env: { PUBLIC_KEY: `x\n${key}` } }, key), "ready")
  const config = renderPodConfig([{ account: "team", alias: "rp-team-a", pod: { id: "p1" }, state: "ready", ...direct, user: "root" }], { keysDir: "/run/keys", knownHosts: "/data/known_hosts" })
  assert.match(config, /Host rp-team-a\n  HostName 1\.2\.3\.4\n  Port 15776\n  User root\n  IdentityFile \/run\/keys\/team\n  IdentitiesOnly yes/)
  assert.match(config, /HostKeyAlias runpod-p1/)
  assert.match(config, /StrictHostKeyChecking accept-new/)
})

test("public key from a stored private key", async () => {
  const { execFileSync } = await import("node:child_process")
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ocrp-key-"))
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "c", "-f", join(dir, "k")])
    assert.equal(publicKeyOf(readFileSync(join(dir, "k"), "utf8"), "c"), readFileSync(join(dir, "k.pub"), "utf8").trim())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("inventory shows running pods with cost, uptime and alias (idle reminder)", () => {
  const text = inventory([{ id: "team", auth: "browser", team: "ASI R&D Team", updatedAt: "" }], {
    team: { balance: 4403.81, pods: 28, checkedAt: "x", running: [{ id: "abc", name: "train-1", status: "RUNNING", costPerHr: 1.79, gpu: "1× NVIDIA H100", startedAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString() }] },
  })
  assert.match(text, /team \(ASI R&D Team\): balance \$4,404, 28 pods/)
  assert.match(text, /running: train-1 \(abc, 1× NVIDIA H100, \$1\.79\/hr, up 2\.5h\) ssh alias rp-team-train-1/)
  assert.match(text, /Running pods cost \$1\.79\/hr in total/)
})
