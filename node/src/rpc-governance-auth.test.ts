/**
 * Security regression: governance-mutating RPC methods (coc_submitProposal,
 * coc_voteProposal) must be gated to loopback / Bearer-auth callers.
 *
 * Bug: the only guard was `proposer/voterId === localNodeId`. The node's id
 * is public (coc_nodeInfo, P2P handshakes), so that check authenticates
 * nothing — any remote RPC client could submit validator-governance
 * proposals and cast the node's stake-weighted vote (a vote crossing the
 * threshold mutates the validator set via executeProposal).
 *
 * Fix: both methods now require `opts.callerAuthorized` (loopback OR a
 * validated global RPC auth token), checked before any other handling.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { handleRpcMethod } from "./rpc.ts"
import type { P2PNode } from "./p2p.ts"

const CHAIN_ID = 18780

async function makeChain() {
  const evm = await EvmChain.create(CHAIN_ID)
  const dataDir = "/tmp/coc-gov-auth-test-" + Date.now() + "-" + Math.random().toString(36).slice(2)
  const chain = new ChainEngine(
    { dataDir, nodeId: "n1", validators: ["n1"], finalityDepth: 3, maxTxPerBlock: 50, minGasPriceWei: 1n },
    evm,
  )
  const p2p = { receiveTx: async () => {}, getStats: () => ({}), getPeers: () => [] } as unknown as P2PNode
  return { evm, chain, p2p }
}

const isUnauthorized = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: number }).code === -32003

test("coc_submitProposal rejects an unauthorized caller", async () => {
  const { evm, chain, p2p } = await makeChain()
  await assert.rejects(
    () => handleRpcMethod(
      "coc_submitProposal",
      [{ type: "add_validator", targetId: "victim", proposer: "n1" }],
      CHAIN_ID, evm, chain, p2p, undefined,
      { callerAuthorized: false, nodeId: "n1" },
    ),
    isUnauthorized,
    "remote (non-loopback, no token) caller must be rejected with -32003",
  )
})

test("coc_voteProposal rejects an unauthorized caller", async () => {
  const { evm, chain, p2p } = await makeChain()
  await assert.rejects(
    () => handleRpcMethod(
      "coc_voteProposal",
      [{ proposalId: "p1", voterId: "n1", approve: true }],
      CHAIN_ID, evm, chain, p2p, undefined,
      { callerAuthorized: false, nodeId: "n1" },
    ),
    isUnauthorized,
    "remote caller must not be able to cast the node's governance vote",
  )
})

test("governance RPC default-denies when authorization is absent", async () => {
  const { evm, chain, p2p } = await makeChain()
  // opts omitted entirely — callerAuthorized undefined → must default-deny.
  await assert.rejects(
    () => handleRpcMethod(
      "coc_voteProposal",
      [{ proposalId: "p1", voterId: "n1", approve: true }],
      CHAIN_ID, evm, chain, p2p,
    ),
    isUnauthorized,
    "missing authorization must default-deny, not fail open",
  )
})

test("an authorized caller passes the gate (no -32003)", async () => {
  const { evm, chain, p2p } = await makeChain()
  // callerAuthorized:true — the auth gate must let it through. The test
  // chain has no governance module, so it then fails with -32601, NOT -32003.
  let code: number | undefined
  try {
    await handleRpcMethod(
      "coc_voteProposal",
      [{ proposalId: "p1", voterId: "n1", approve: true }],
      CHAIN_ID, evm, chain, p2p, undefined,
      { callerAuthorized: true, nodeId: "n1" },
    )
  } catch (err) {
    code = (err as { code?: number }).code
  }
  assert.notEqual(code, -32003, "an authorized caller must clear the auth gate")
})
