/**
 * pose-witness-verifier.test.ts — #667 (audit follow-up, 2026-05-26)
 *
 * Covers the three Push-verification checks in verifyPushedReceipt:
 *  (1) keccak256(stableStringify(body)) == responseBodyHash
 *  (2) ecrecover(RECEIPT digest, nodeSig) == nodeOperator(poseNodeId)
 *  (3) freshness window on responseAtMs
 *
 * Plus the rollout configuration corners: missing reader, malformed sig,
 * mismatched operator, stale receipt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import { verifyPushedReceipt, stableStringify } from "./pose-witness-verifier.ts";
import { RECEIPT_TYPES, buildDomain, toEthersDomain } from "../../node/src/crypto/eip712-types.ts";
import { keccak256Hex } from "../../services/relayer/keccak256.ts";
import type { ContractReader } from "./contract-reader.ts";
import type { Hex32 } from "../../services/common/pose-types.ts";

// Test fixture — a minimal ContractReader that returns a configured
// operator address (or throws). Keep deps minimal so this file is a unit
// test, not an integration test against a live RPC.
function fakeReader(opts: {
  operator: string;
  throwOn?: boolean;
}): ContractReader {
  return {
    async getNodeOperator(nodeId: Hex32): Promise<string> {
      if (opts.throwOn) throw new Error("simulated RPC failure");
      return opts.operator;
    },
  } as unknown as ContractReader;
}

const CHAIN_ID = 88780n;
const VERIFYING_CONTRACT = "0x1111111111111111111111111111111111111111";

async function buildSignedReceipt(opts: {
  privateKey?: string;
  body?: Record<string, unknown>;
  responseAtMs?: number;
  challengeId?: string;
  tipHash?: string;
  tipHeight?: bigint;
}) {
  const wallet = new Wallet(opts.privateKey ?? "0x" + "1".repeat(64));
  const body = opts.body ?? { ok: true, blockNumber: 42 };
  const bodyHash = `0x${keccak256Hex(Buffer.from(stableStringify(body), "utf8"))}`;
  const challengeId = opts.challengeId ?? "0x" + "a".repeat(64);
  const tipHash = opts.tipHash ?? "0x" + "c".repeat(64);
  const tipHeight = opts.tipHeight ?? 100n;
  const responseAtMs = opts.responseAtMs ?? Date.now();
  // Node IDs in v2 are 32-byte poseNodeId (keccak of pubkey). For the
  // signature mechanics it just needs to be a 32-byte hex; the value
  // itself doesn't have to be derived from this wallet's pubkey since
  // the on-chain lookup (mocked here) is what ties nodeId → operator.
  const nodeId = "0x" + "b".repeat(64);
  const domain = toEthersDomain(buildDomain(CHAIN_ID, VERIFYING_CONTRACT));
  const payload = {
    challengeId,
    nodeId,
    responseAtMs: BigInt(responseAtMs),
    responseBodyHash: bodyHash,
    tipHash,
    tipHeight,
  };
  const nodeSig = await wallet.signTypedData(domain, RECEIPT_TYPES, payload);
  return {
    operator: wallet.address.toLowerCase(),
    challengeId,
    nodeId,
    body,
    bodyHash,
    responseAtMs,
    tipHash,
    tipHeight,
    nodeSig,
  };
}

test("verifyPushedReceipt: happy path — all three checks pass", async () => {
  const r = await buildSignedReceipt({});
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      contractReader: fakeReader({ operator: r.operator }),
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recoveredOperator, r.operator);
  }
});

test("verifyPushedReceipt: rejects when responseBody does not hash to declared hash", async () => {
  const r = await buildSignedReceipt({});
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: { ...r.body, tampered: true }, // body mutated after sign
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      contractReader: fakeReader({ operator: r.operator }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /does not hash/);
  }
});

test("verifyPushedReceipt: rejects when nodeSig recovers to a different address than the registered operator", async () => {
  const r = await buildSignedReceipt({});
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      // On-chain lookup returns a different operator than the sigantore.
      contractReader: fakeReader({ operator: "0x" + "9".repeat(40) }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /does not recover to the registered nodeOperator/);
  }
});

test("verifyPushedReceipt: rejects when nodeId is unregistered (operator returns zero address)", async () => {
  const r = await buildSignedReceipt({});
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      contractReader: fakeReader({ operator: "0x0000000000000000000000000000000000000000" }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /is not registered/);
  }
});

test("verifyPushedReceipt: F2 freshness — rejects stale receipt outside window", async () => {
  const now = 1_000_000_000_000;
  const r = await buildSignedReceipt({ responseAtMs: now - 5 * 60_000 }); // 5 minutes ago
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      freshnessWindowMs: 60_000,
      nowMs: () => now,
      contractReader: fakeReader({ operator: r.operator }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /freshness window/);
  }
});

test("verifyPushedReceipt: F2 freshness — also rejects future-dated receipt (clock-drag attack)", async () => {
  const now = 1_000_000_000_000;
  const r = await buildSignedReceipt({ responseAtMs: now + 5 * 60_000 }); // 5 minutes ahead
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      freshnessWindowMs: 60_000,
      nowMs: () => now,
      contractReader: fakeReader({ operator: r.operator }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /freshness window/);
});

test("verifyPushedReceipt: F2 freshness — accepts receipt at window boundary", async () => {
  const now = 1_000_000_000_000;
  const r = await buildSignedReceipt({ responseAtMs: now - 60_000 }); // exactly at boundary
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      freshnessWindowMs: 60_000,
      nowMs: () => now,
      contractReader: fakeReader({ operator: r.operator }),
    },
  );
  assert.equal(result.ok, true);
});

test("verifyPushedReceipt: malformed nodeSig returns 400 without leaking ethers internals", async () => {
  const r = await buildSignedReceipt({});
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: "0x" + "00".repeat(65),
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      contractReader: fakeReader({ operator: r.operator }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.error, /TypeError|SyntaxError|stack/);
  }
});

test("verifyPushedReceipt: contractReader RPC failure surfaces 502 (fail-closed)", async () => {
  const r = await buildSignedReceipt({});
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      contractReader: fakeReader({ operator: r.operator, throwOn: true }),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 502);
    assert.match(result.error, /operator lookup failed/);
  }
});

test("verifyPushedReceipt: rejects self-signed forged receipt from attacker EOA", async () => {
  // This is the Sybil scenario this fix is meant to prevent.
  // Attacker generates a fresh EOA, self-signs a receipt for an arbitrary
  // body claiming to be the prover, and pushes it to the witness.
  // The witness's on-chain lookup of nodeOperator(nodeId) returns the
  // REAL operator (not the attacker), so ecrecover mismatch → reject.
  const attacker = new Wallet("0x" + "0".repeat(62) + "ab");
  const r = await buildSignedReceipt({ privateKey: attacker.privateKey });
  const result = await verifyPushedReceipt(
    {
      challengeId: r.challengeId,
      nodeId: r.nodeId,
      responseBodyHash: r.bodyHash,
      responseBody: r.body,
      responseAtMs: r.responseAtMs,
      nodeSig: r.nodeSig,
      tipHash: r.tipHash,
      tipHeight: r.tipHeight,
    },
    {
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      contractReader: fakeReader({ operator: "0x1234567890123456789012345678901234567890" }),
    },
  );
  // Attacker's sig recovers to attacker.address, not the real operator.
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /does not recover/);
});
