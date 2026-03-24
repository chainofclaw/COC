// IPFS HTTP API client for COC backup extension
// Wraps the COC node's IPFS HTTP API subset

import type { SnapshotManifest } from "./types.ts"

const IPFS_TIMEOUT_MS = 30_000
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024 // 10 MB

function validateCid(cid: string): void {
  if (!cid || /[\/\\.\s]/.test(cid) || cid.length > 512) {
    throw new Error(`Invalid CID format: ${cid.slice(0, 50)}`)
  }
}

export class IpfsClient {
  private readonly baseUrl: string

  constructor(ipfsUrl: string) {
    this.baseUrl = ipfsUrl.replace(/\/$/, "")
  }

  /** Upload a file to IPFS, returns CID string */
  async add(data: Uint8Array): Promise<string> {
    const formData = new FormData()
    formData.append("file", new Blob([data]))

    const res = await fetch(`${this.baseUrl}/api/v0/add`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(IPFS_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`IPFS add failed: ${res.status} ${await res.text()}`)
    }
    const json = (await res.json()) as { Hash: string; Size: string }
    return json.Hash
  }

  /** Upload JSON object to IPFS, returns CID string */
  async addJson(obj: unknown): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(obj, null, 2))
    return this.add(data)
  }

  /** Upload a manifest to IPFS */
  async addManifest(manifest: SnapshotManifest): Promise<string> {
    return this.addJson(manifest)
  }

  /** Retrieve raw bytes from IPFS by CID */
  async cat(cid: string): Promise<Uint8Array> {
    validateCid(cid)
    const res = await fetch(`${this.baseUrl}/ipfs/${cid}`, {
      signal: AbortSignal.timeout(IPFS_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`IPFS cat failed for ${cid}: ${res.status} ${await res.text()}`)
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  /** Retrieve JSON object from IPFS by CID */
  async catJson<T = unknown>(cid: string): Promise<T> {
    const data = await this.cat(cid)
    const text = new TextDecoder().decode(data)
    return JSON.parse(text) as T
  }

  /** Retrieve a manifest from IPFS (with size cap) */
  async catManifest(cid: string): Promise<SnapshotManifest> {
    validateCid(cid)
    const data = await this.cat(cid)
    if (data.length > MAX_MANIFEST_BYTES) {
      throw new Error(`Manifest too large: ${data.length} bytes (max ${MAX_MANIFEST_BYTES})`)
    }
    const text = new TextDecoder().decode(data)
    const manifest = JSON.parse(text) as SnapshotManifest
    if (typeof manifest.version !== "number" || typeof manifest.agentId !== "string" || typeof manifest.files !== "object") {
      throw new Error("Invalid manifest structure: missing required fields")
    }
    return manifest
  }

  /** Check if IPFS node is reachable */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v0/id`, { method: "POST", signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** MFS mkdir — create directory in mutable file system */
  async mfsMkdir(path: string): Promise<void> {
    const params = new URLSearchParams({ arg: path, parents: "true" })
    const res = await fetch(`${this.baseUrl}/api/v0/files/mkdir?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(IPFS_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`IPFS mfs mkdir failed: ${res.status} ${await res.text()}`)
    }
  }

  /** MFS cp — copy CID into MFS path */
  async mfsCp(cid: string, destPath: string): Promise<void> {
    const params = new URLSearchParams({ arg: [`/ipfs/${cid}`, destPath] as unknown as string })
    // MFS cp takes two args
    const res = await fetch(
      `${this.baseUrl}/api/v0/files/cp?arg=/ipfs/${cid}&arg=${encodeURIComponent(destPath)}`,
      { method: "POST", signal: AbortSignal.timeout(IPFS_TIMEOUT_MS) },
    )
    if (!res.ok) {
      throw new Error(`IPFS mfs cp failed: ${res.status} ${await res.text()}`)
    }
  }
}
