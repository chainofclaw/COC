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

import type { IpfsBlockstore, IpfsBlockstoreHooks } from "./ipfs-blockstore.ts"
import type { DhtNetwork } from "./dht-network.ts"
import type { WireConnectionManager } from "./wire-connection-manager.ts"
import type { CidString } from "./ipfs-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("coc-ipfs-wiring")

// Default provider fan-out ceiling for a single GET. We try at most this
// many peers before giving up; the DHT can claim far more (up to 64 per
// CID, see MAX_PROVIDERS_PER_CID), but chasing them all would amplify
// traffic without improving first-hit latency. 3 matches the default
// replication factor so in a healthy cluster we hit one of the known
// replicas on the first try.
const DEFAULT_FETCH_PROVIDER_FAN_OUT = 3
const DEFAULT_FETCH_TIMEOUT_MS = 5000

export interface CocIpfsWiringConfig {
  localNodeId: string
  blockstore: IpfsBlockstore
  dht: DhtNetwork
  connMgr: WireConnectionManager
  /** Max DHT providers to race on a single pull. Default 3. */
  fetchProviderFanOut?: number
  /** Per-peer block-fetch timeout. Default 5000 ms. */
  fetchTimeoutMs?: number
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
} {
  const fanOut = cfg.fetchProviderFanOut ?? DEFAULT_FETCH_PROVIDER_FAN_OUT
  const timeoutMs = cfg.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS

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

  const onPut = (cid: CidString, _bytes: Uint8Array): void => {
    // C1.4 adds pushToK here. For C1.3 we do the cheap half: advertise
    // that the local node now holds this CID so other peers' fetchRemote
    // can find us. Without this, a node that caches a fetched block
    // would still be invisible to the DHT as a provider until the next
    // re-announce tick (C3.2), leading to needlessly repeated pulls
    // against the original provider.
    cfg.dht.putProvider(cid, cfg.localNodeId)
  }

  // Wire-server pull/push handler. Pull: look up locally and return bytes
  // or null on miss. Push: the server has already verified keccak256 of
  // the bytes matches the claimed CID, so we just need to persist. Empty
  // Uint8Array on success so the client's pushBlock wrapper resolves true.
  const onBlockRequest = async (
    cid: string,
    push: boolean,
    bytes?: Uint8Array,
  ): Promise<Uint8Array | null> => {
    if (push) {
      if (!bytes) return null
      try {
        await cfg.blockstore.put({ cid, bytes })
        // put() already fires the onPut hook, so we've self-announced.
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

  return { blockstoreHooks: { fetchRemote, onPut }, onBlockRequest }
}
