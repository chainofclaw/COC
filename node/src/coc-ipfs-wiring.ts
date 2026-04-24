/**
 * COC IPFS wiring — glue between the blockstore, the DHT, and the wire
 * connection manager so that:
 *
 *   - `IpfsBlockstore.get` on a local miss queries `DhtNetwork.findProviders`
 *     for candidates, pulls from them in parallel via
 *     `WireConnectionManager.requestBlockFromAny`, and caches the result.
 *     This is Phase C1.3's "content survives the origin node dying" bit.
 *
 *   - `WireServer.onBlockRequest` handler reads from the local blockstore
 *     (pull side) or writes into it (push side). Phase C1.4's push
 *     replication flows through the same path.
 *
 *   - After `IpfsBlockstore.put` completes, the local node self-announces
 *     into the DHT (Phase C1.4) so peers can find this CID via
 *     `findProviders`. Active replication (`pushToK`) is added in C1.4.
 *
 * The glue lives in its own file so `ipfs-blockstore.ts` stays free of
 * wire / DHT dependencies — easier to unit-test the blockstore in
 * isolation, and keeps the dependency graph acyclic (blockstore depends
 * on nothing network-related; the wiring depends on all three).
 */

import type { IpfsBlockstore, IpfsBlockstoreHooks, OnPutOptions } from "./ipfs-blockstore.ts"
import type { DhtNetwork } from "./dht-network.ts"
import type { WireConnectionManager } from "./wire-connection-manager.ts"
import type { CidString } from "./ipfs-types.ts"
import { keccak256, toUtf8Bytes } from "ethers"
import { createLogger } from "./logger.ts"

/**
 * Map an arbitrary CID string (IPFS "QmXxx", raw 0x-hex, base32, etc.)
 * into the peer-ID keyspace that DhtNetwork.routingTable.findClosest
 * operates on. Without this projection, calling findClosest(cid) throws
 * from xorDistance's hex decode when the CID isn't pure hex. Using
 * keccak256 both normalizes the format and preserves locality: peers
 * that happen to be close to the hashed CID in XOR distance get first
 * crack at replication, giving the network the Kademlia-style "content
 * lives near nodes whose ID is close to the content key" property.
 */
function cidToRoutingKey(cid: string): string {
  return cid.startsWith("0x") && /^[0-9a-fA-F]+$/.test(cid.slice(2))
    ? cid.toLowerCase()
    : keccak256(toUtf8Bytes(cid)).toLowerCase()
}

const log = createLogger("coc-ipfs-wiring")

// Default provider fan-out ceiling for a single GET. We try at most this
// many peers before giving up; the DHT can claim far more (up to 64 per
// CID, see MAX_PROVIDERS_PER_CID), but chasing them all would amplify
// traffic without improving first-hit latency. 3 matches the default
// replication factor so in a healthy cluster we hit one of the known
// replicas on the first try.
const DEFAULT_FETCH_PROVIDER_FAN_OUT = 3
const DEFAULT_FETCH_TIMEOUT_MS = 5000
const DEFAULT_PUSH_TIMEOUT_MS = 10_000

// Replication factor for push-to-K on local PUT. A freshly-stored block is
// proactively pushed to this many of its K-closest peers so the data
// survives the origin going down. Clamped at runtime to
// `min(replicationFactor, peerCount - 1)`; peerCount < 2 ⇒ skip + warn
// once per minute. Configurable via `NodeConfig.ipfsReplicationFactor`.
const DEFAULT_REPLICATION_FACTOR = 3
// How often to emit the "peerCount < 2, skipping replication" warning.
const LOW_PEER_WARN_INTERVAL_MS = 60_000

export interface CocIpfsWiringConfig {
  localNodeId: string
  blockstore: IpfsBlockstore
  dht: DhtNetwork
  connMgr: WireConnectionManager
  /** Max DHT providers to race on a single pull. Default 3. */
  fetchProviderFanOut?: number
  /** Per-peer block-fetch timeout. Default 5000 ms. */
  fetchTimeoutMs?: number
  /**
   * Target replica count for push-to-K on local PUT. Defaults to 3. The
   * effective K is clamped at runtime to `min(this, peerCount - 1)` so
   * small clusters (e.g. 3-node devnet) still function without the
   * replication path perpetually warning about missing replicas.
   */
  replicationFactor?: number
  /** Per-peer push timeout. Default 10 s (bigger frames than pulls). */
  pushTimeoutMs?: number
}

/** Returned from pushToK so C3.1's PUT handler can wait on a specific count. */
export interface PushToKResult {
  cid: string
  /** K after clamping to peer availability. */
  attempted: number
  /** Peer ids that acked with `found:true`. */
  succeeded: string[]
  /** Peer ids that were tried but refused / timed out. */
  failed: string[]
  /** True iff we bailed out because the cluster is effectively alone. */
  skippedLowPeers: boolean
}

/**
 * Build the hook set that drives the blockstore's fetchRemote / onPut paths,
 * plus the wire-server callback that answers peer BlockRequest frames.
 *
 * Usage (conceptually — actual boot lives in node/src/index.ts):
 *
 *     const wiring = buildCocIpfsWiring({ localNodeId, blockstore, dht, connMgr })
 *     blockstore.setHooks(wiring.blockstoreHooks)
 *     wireServer = new WireServer({
 *       ...,
 *       onBlockRequest: wiring.onBlockRequest,
 *     })
 *
 * `setHooks` may be called multiple times safely — each call replaces
 * individual hooks without reconfiguring the blockstore's backing store.
 */
export function buildCocIpfsWiring(cfg: CocIpfsWiringConfig): {
  blockstoreHooks: IpfsBlockstoreHooks
  onBlockRequest: (cid: string, push: boolean, bytes?: Uint8Array) => Promise<Uint8Array | null>
  /**
   * Manually trigger replication for a CID already in the local blockstore.
   * `onPut` fires pushToK automatically for local PUTs; this helper is
   * exposed so C3.1's PUT handler can await replicas, and C3.3's repair
   * loop can top up under-replicated CIDs on demand.
   */
  pushToK: (cid: string, bytes: Uint8Array) => Promise<PushToKResult>
  /**
   * Phase C3.1: return the PushToKResult for a recently-PUT CID, or null
   * if the CID hasn't been PUT locally within the last ~30 s (memory
   * cap) or no replication path exists. Lets the HTTP `/api/v0/add`
   * handler add an `X-COC-Replicas-Warning` header when the number
   * of successful replicas is below `cfg.ipfs.minReplicas`.
   */
  awaitReplicationResult: (cid: string, timeoutMs?: number) => Promise<PushToKResult | null>
} {
  const fanOut = cfg.fetchProviderFanOut ?? DEFAULT_FETCH_PROVIDER_FAN_OUT
  const timeoutMs = cfg.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const replicationFactor = cfg.replicationFactor ?? DEFAULT_REPLICATION_FACTOR
  const pushTimeoutMs = cfg.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS
  // Rate-limit the "alone in network" warning so an idle single-node
  // devnet doesn't spam its log every PUT.
  let lastLowPeerWarnMs = 0

  // Phase C3.2: attach the blockstore's pin list as the DHT's re-announce
  // source so the periodic republish loop bumps TTLs for every CID the
  // local node still holds. Without this, a long-lived node's own
  // provider records expire after 24 h and peers stop routing GETs here
  // even though the bytes are still on disk. Attaching is idempotent;
  // DhtNetwork.setReannouncePinSource just overwrites the previous ref.
  cfg.dht.setReannouncePinSource(() => cfg.blockstore.listPins())

  const fetchRemote = async (cid: CidString): Promise<Uint8Array | null> => {
    const providers = cfg.dht.findProviders(cid, fanOut)
    if (providers.length === 0) {
      log.debug("fetchRemote: no providers", { cid })
      return null
    }
    const bytes = await cfg.connMgr.requestBlockFromAny(providers, cid, {
      concurrency: fanOut,
      timeoutMs,
    })
    if (bytes) {
      log.info("fetchRemote: got bytes from peer", { cid, bytesLen: bytes.length, providersTried: providers.length })
    } else {
      log.debug("fetchRemote: all providers miss", { cid, providersTried: providers.length })
    }
    return bytes
  }

  const pushToK = async (cid: string, bytes: Uint8Array): Promise<PushToKResult> => {
    // findClosest on the routing table is O(peers). Caps at K-bucket size
    // (20) per bucket so the walk is cheap even at high peer counts. We
    // ask for `replicationFactor + 1` so we can skip the local node if
    // it lands in its own table — defensive, since DhtNetwork.announce()
    // intentionally self-FindNodes and some implementations may mirror
    // us back.
    const candidates = cfg.dht.routingTable.findClosest(cidToRoutingKey(cid), replicationFactor + 1)
    const targets = candidates
      .map((p) => p.id)
      .filter((id) => id.toLowerCase() !== cfg.localNodeId.toLowerCase())
      .slice(0, replicationFactor)

    // Clamp: if we have fewer potential peers than the replication target,
    // accept the deficit rather than block the PUT. We also skip entirely
    // when the network is effectively empty (nobody to replicate to),
    // emitting a once-per-minute warn so operators see the symptom without
    // log spam.
    if (targets.length === 0) {
      const now = Date.now()
      if (now - lastLowPeerWarnMs >= LOW_PEER_WARN_INTERVAL_MS) {
        log.warn("pushToK: no peers available, skipping replication", {
          cid,
          replicationFactor,
          peersInTable: candidates.length,
        })
        lastLowPeerWarnMs = now
      }
      return { cid, attempted: 0, succeeded: [], failed: [], skippedLowPeers: true }
    }

    // Fire in parallel. Per-peer push uses `WireConnectionManager.findByNodeId
    // + WireClient.pushBlock`, which returns `boolean`. The bytes ride base64
    // in a single frame (Phase C1.2's design note on pushBlock).
    const results = await Promise.all(targets.map(async (peerId) => {
      const client = cfg.connMgr.findByNodeId(peerId)
      if (!client) {
        return { peerId, ok: false }
      }
      let ok = false
      try {
        ok = await client.pushBlock(cid, bytes, pushTimeoutMs)
      } catch (err) {
        log.debug("pushToK: peer pushBlock threw", { peerId, cid, error: String(err) })
      }
      return { peerId, ok }
    }))

    const succeeded = results.filter((r) => r.ok).map((r) => r.peerId)
    const failed = results.filter((r) => !r.ok).map((r) => r.peerId)
    if (failed.length > 0) {
      log.info("pushToK: partial replication", {
        cid,
        attempted: targets.length,
        succeeded: succeeded.length,
        failed: failed.length,
      })
    } else {
      log.debug("pushToK: full replication", { cid, attempted: targets.length })
    }
    return { cid, attempted: targets.length, succeeded, failed, skippedLowPeers: false }
  }

  // Phase C3.1: track in-flight per-CID pushToK promises so the HTTP
  // PUT handler can await them and surface replica shortfalls in the
  // response. Keys are lowercased CID strings; entries self-evict ~30 s
  // after the promise settles so the map doesn't grow unbounded across
  // the lifetime of a long-running process.
  const inFlightPushes = new Map<string, Promise<PushToKResult>>()
  const PUSH_RESULT_RETENTION_MS = 30_000

  const onPut = (cid: CidString, bytes: Uint8Array, opts?: OnPutOptions): void => {
    // Always self-announce. Cheap (in-memory DHT map) and buys the
    // snowball-provider effect C1.3 depends on.
    cfg.dht.putProvider(cid, cfg.localNodeId)

    // Only fire pushToK for local PUTs. A cache-back from remote fetch
    // (source: "remote-cache") must NOT push, or every GET would amplify
    // into K pushes and cascade exponentially. Discovery-based diffusion
    // via putProvider above is sufficient in that case.
    const source = opts?.source ?? "local"
    if (source !== "local") return

    // Fire-and-forget for latency, but retain the promise in
    // inFlightPushes so C3.1's awaitReplicationResult can look it up.
    const key = cid.toLowerCase()
    const p = pushToK(cid, bytes).catch((err) => {
      log.warn("pushToK unexpected throw", { cid, error: String(err) })
      // Surface a fake result rather than rejecting; callers only care
      // about how many replicas landed, not whether the push threw.
      return { cid, attempted: 0, succeeded: [], failed: [], skippedLowPeers: true } as PushToKResult
    })
    inFlightPushes.set(key, p)
    void p.finally(() => {
      setTimeout(() => inFlightPushes.delete(key), PUSH_RESULT_RETENTION_MS).unref?.()
    })
  }

  const awaitReplicationResult = async (cid: string, timeoutMs = 10_000): Promise<PushToKResult | null> => {
    const p = inFlightPushes.get(cid.toLowerCase())
    if (!p) return null
    // Race the stored promise against a timeout so a slow peer can't
    // pin the HTTP handler. Returning null lets the caller treat the
    // CID as "replication status unknown" — they emit a best-effort
    // warning header but still return 200 to the uploader.
    return await Promise.race<PushToKResult | null>([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
    ])
  }

  // Wire-server pull/push handler. Pull: look up locally and return bytes
  // or null on miss. Push: the server has already verified keccak256 of
  // the bytes matches the claimed CID (wire-server.ts Phase C1.2) so we
  // just need to persist. Using `putFromPeer` tags the onPut hook with
  // `source: "remote-cache"` so the replicator doesn't cascade the push
  // further — the upstream PUT already fanned out to its own K peers,
  // and re-fanning from every recipient would cause exponential traffic.
  const onBlockRequest = async (
    cid: string,
    push: boolean,
    bytes?: Uint8Array,
  ): Promise<Uint8Array | null> => {
    if (push) {
      if (!bytes) return null
      try {
        await cfg.blockstore.putFromPeer({ cid, bytes })
        return new Uint8Array(0)
      } catch (err) {
        log.warn("onBlockRequest push: store failed", { cid, error: String(err) })
        return null
      }
    }
    // Pull
    try {
      const block = await cfg.blockstore.get(cid)
      return block.bytes
    } catch {
      return null
    }
  }

  return { blockstoreHooks: { fetchRemote, onPut }, onBlockRequest, pushToK, awaitReplicationResult }
}
