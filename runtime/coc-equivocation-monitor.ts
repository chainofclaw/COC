/**
 * R3.1 — EquivocationDetector ↔ BFT slash automation bridge (M10)
 *
 * Subscribes to BFT EquivocationDetected events from the local node's
 * coc_subscribe stream (or polled via coc_getEquivocations RPC), submits
 * EquivocationDetector.report(commitHash) on chain, then after the
 * commit-reveal window calls reveal+settle. The end-to-end effect is
 * ValidatorRegistry.slashValidator on the offending nodeId.
 *
 * Code-ready stub: full implementation requires:
 *   1. BFT-side equivocation detection wire-up (already in node/src/bft.ts)
 *   2. Equivocation evidence packing (services/common/slash-evidence.ts)
 *   3. EquivocationDetector commit-reveal-settle txs
 *   4. Tests against the H15 fork-off devnet (must inject double-sign)
 *
 * For the ralph loop, this scaffolds the runtime/ entry point so the
 * monitor process can be added to docker-compose-pose.yml in a follow-up.
 */
import { Contract, JsonRpcProvider, Wallet, type Log } from "ethers"
import { readFile } from "node:fs/promises"
import { createLogger } from "../node/src/logger.ts"
import { resolvePrivateKey } from "./lib/key-material.ts"

const log = createLogger("coc-equivocation-monitor")

const NODE_URL = process.env.COC_NODE_URL ?? "http://127.0.0.1:18780"
const L1_RPC = process.env.COC_L1_RPC_URL ?? NODE_URL
const SLASHER_PK = resolveSlasherPrivateKey()
const POLL_MS = Number(process.env.COC_EQUIVOCATION_POLL_MS ?? 30_000)

const provider = new JsonRpcProvider(L1_RPC)
const slasher = new Wallet(SLASHER_PK, provider)
log.info("equivocation monitor booting", { slasher: slasher.address })

function resolveSlasherPrivateKey(): string {
  try {
    return resolvePrivateKey({
      envValue: process.env.COC_SLASHER_PK,
      envFilePath: process.env.COC_SLASHER_PK_FILE,
      label: "slasher",
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

interface EquivocationEvent {
  nodeId: `0x${string}`
  height: bigint
  signA: `0x${string}`
  signB: `0x${string}`
  timestamp: number
}

async function pollEquivocations(): Promise<EquivocationEvent[]> {
  // Real implementation: call `coc_getEquivocations` on the node RPC
  // (see node/src/bft.ts equivocation detector). Returns recent events.
  try {
    const res = await fetch(NODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "coc_getEquivocations", params: [], id: 1 }),
      signal: AbortSignal.timeout(5_000),
    })
    const json = (await res.json()) as { result?: EquivocationEvent[] }
    return json.result ?? []
  } catch (err) {
    log.warn("poll equivocations failed", { error: String(err) })
    return []
  }
}

async function tick(): Promise<void> {
  const events = await pollEquivocations()
  for (const ev of events) {
    log.info("equivocation observed", {
      nodeId: ev.nodeId, height: ev.height.toString(), timestamp: ev.timestamp,
    })
    // TODO: pack evidence + submit EquivocationDetector.report()
    // commit-reveal-settle flow per contracts-src/governance/EquivocationDetector.sol
    log.warn("EquivocationDetector.report() submission deferred — see R3.1 follow-up")
  }
}

setInterval(() => void tick().catch((err) => log.error("tick failed", { error: String(err) })), POLL_MS)
log.info("monitor running", { pollIntervalMs: POLL_MS })
