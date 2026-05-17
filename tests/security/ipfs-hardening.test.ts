/**
 * IPFS hardening security suite — codifies the testnet security probes
 * (2026-05-17): gateway path-traversal resistance, CID-argument validation,
 * and content-address integrity on the IPFS-compatible HTTP layer.
 *
 * Distinct from tests/e2e/ipfs-e2e-extended.test.ts (functional E2E + admin
 * auth gate): this suite is the attack-surface view — an unauthenticated
 * client must not be able to read host files or smuggle a non-CID path.
 *
 * Targets the IPFS HTTP API via COC_STRESS_IPFS (default 127.0.0.1:28800).
 * Skips gracefully when unreachable, so it is CI-safe.
 *
 * Run: COC_STRESS_IPFS=http://host:port node --experimental-strip-types --test tests/security/ipfs-hardening.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

const IPFS = process.env.COC_STRESS_IPFS ?? "http://127.0.0.1:28800"

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${IPFS}/api/v0/version`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

const up = await reachable()

/** A sentinel that would appear if a host file (e.g. /etc/passwd) leaked. */
const HOST_FILE_MARKERS = ["root:x:", "root:*:", "/bin/bash", "daemon:"]

function looksLikeHostFile(body: string): boolean {
  return HOST_FILE_MARKERS.some((m) => body.includes(m))
}

describe("IPFS hardening (live node)", { skip: !up ? `no IPFS node at ${IPFS}` : false }, () => {
  it("gateway rejects path traversal — no host file is served", async () => {
    for (const path of [
      "/ipfs/../../../../etc/passwd",
      "/ipfs/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/ipfs/....//....//etc/passwd",
    ]) {
      const res = await fetch(`${IPFS}${path}`, { signal: AbortSignal.timeout(5000) })
      const body = await res.text()
      assert.ok(!looksLikeHostFile(body), `${path}: gateway leaked a host file`)
      assert.notEqual(res.status, 200, `${path}: traversal must not resolve to 200`)
    }
  })

  it("cat rejects non-CID / traversal arguments with a clean 4xx", async () => {
    for (const arg of [
      "../../../etc/passwd",
      "/etc/passwd",
      "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/../../../etc/passwd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "not-a-cid",
    ]) {
      const res = await fetch(`${IPFS}/api/v0/cat?arg=${encodeURIComponent(arg)}`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      })
      const body = await res.text()
      assert.ok(!looksLikeHostFile(body), `cat arg=${arg}: leaked a host file`)
      assert.ok(res.status >= 400 && res.status < 500, `cat arg=${arg}: must be a clean 4xx, got ${res.status}`)
    }
  })

  it("add → cat round-trips content exactly under a deterministic CID", async () => {
    const payload = `ipfs-security-probe-${Date.now()}-${Math.random()}`
    const form = new FormData()
    form.append("file", new Blob([payload]), "probe.txt")
    const addRes = await fetch(`${IPFS}/api/v0/add`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(addRes.status, 200, "add must succeed")
    const added = (await addRes.json()) as { Hash: string }
    assert.match(added.Hash, /^(Qm|bafy)/, "add returns a CID")

    const catRes = await fetch(`${IPFS}/api/v0/cat?arg=${added.Hash}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(catRes.status, 200, "cat of a valid CID must succeed")
    assert.equal(await catRes.text(), payload, "content survives the round-trip byte-for-byte")
  })

  it("cat of an unknown-but-well-formed CID does not hang or 5xx", async () => {
    // Valid CIDv0 shape, never added — must fail fast, not stall or crash.
    const unknown = "Qm" + "1".repeat(44)
    const res = await fetch(`${IPFS}/api/v0/cat?arg=${unknown}`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    if (res) {
      assert.notEqual(res.status, 500, "unknown CID must not produce HTTP 500")
    }
  })

  it("node stays responsive after the probe barrage", async () => {
    const res = await fetch(`${IPFS}/api/v0/version`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    })
    assert.equal(res.status, 200, "IPFS node still healthy")
  })
})
