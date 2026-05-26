/**
 * pose-challenge-validator.test.ts — #747 (#667 F4, audit follow-up 2026-05-26).
 *
 * Covers:
 *  - v1-shape passthrough in lenient mode (backwards-compat)
 *  - v1 rejected in `requireVerified` mode
 *  - v2 happy path: deterministic challengeId + EIP-712 sig accepted
 *  - tampered challengeId rejected (caller substitutes a different value)
 *  - tampered querySpec rejected (hash mismatch)
 *  - tampered challengerSig rejected (recover mismatch)
 *  - issuedAtMs drift window
 *  - schema validation (deterministic 400s, no echo)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import { validatePoseChallengePayload } from "./pose-challenge-validator.ts";
import { CHALLENGE_TYPES, buildDomain, toEthersDomain } from "../../node/src/crypto/eip712-types.ts";
import { keccak256Hex } from "../../services/relayer/keccak256.ts";
import { stableStringify, u64Bytes, hex32Bytes, hexSizedBytes } from "../../services/common/encoding.ts";

const CHAIN_ID = 88780n;
const VERIFYING_CONTRACT = "0x256eb949c50d5f2af8699191b1bc043203263549";

async function buildSignedChallenge(opts?: {
  privateKey?: string;
  issuedAtMs?: number;
}) {
  const wallet = new Wallet(opts?.privateKey ?? "0x" + "1".repeat(64));
  const challengerAddr = wallet.address.toLowerCase();
  const challengerId = `0x${"00".repeat(12)}${challengerAddr.slice(2)}`;
  const nodeId = "0x" + "ab".repeat(32);
  const nonce = "0x" + "cd".repeat(16);
  const epochId = 100n;
  const challengeNonce = 42n;
  const issuedAtMs = BigInt(opts?.issuedAtMs ?? Date.now());
  const deadlineMs = 6000n;
  const typeCode = "U";
  const querySpec = { kind: "uptime", blockNumber: 1234 };
  const querySpecHash = `0x${keccak256Hex(Buffer.from(stableStringify(querySpec), "utf8"))}`;

  const digest = Buffer.concat([
    u64Bytes(epochId),
    hex32Bytes(nodeId as `0x${string}`),
    Buffer.from(typeCode, "utf8"),
    hexSizedBytes(nonce as `0x${string}`, 16),
    hex32Bytes(challengerId as `0x${string}`),
    u64Bytes(challengeNonce),
  ]);
  const challengeId = `0x${keccak256Hex(digest)}`;

  const challengeData = {
    challengeId,
    epochId,
    nodeId,
    challengeType: 0, // U
    nonce,
    challengeNonce,
    querySpecHash,
    issuedAtMs,
    deadlineMs,
    challengerId,
  };
  const domain = toEthersDomain(buildDomain(CHAIN_ID, VERIFYING_CONTRACT));
  const challengerSig = await wallet.signTypedData(domain, CHALLENGE_TYPES, challengeData);

  return {
    version: 2 as const,
    challengeId,
    epochId: epochId.toString(),
    nodeId,
    challengeType: typeCode,
    nonce,
    challengeNonce: challengeNonce.toString(),
    querySpec,
    querySpecHash,
    issuedAtMs: issuedAtMs.toString(),
    deadlineMs: deadlineMs.toString(),
    challengerId,
    challengerSig,
    _challengerAddress: challengerAddr,
  };
}

test("#747: v1 payload (no challengerSig) accepted in lenient mode", () => {
  const r = validatePoseChallengePayload(
    { challengeId: "abc-123", challengeType: "U", nodeId: "0x0" },
    { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.challenge.version, 1);
    assert.equal(r.challenge.challengeId, "abc-123");
  }
});

test("#747: v1 payload rejected in requireVerified mode", () => {
  const r = validatePoseChallengePayload(
    { challengeId: "abc-123" },
    { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT, requireVerified: true },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.match(r.error, /verified v2 challenge required/);
  }
});

test("#747: v2 happy path — derived challengeId + valid sig accepted", async () => {
  const c = await buildSignedChallenge({});
  const r = validatePoseChallengePayload(c, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.challenge.version, 2);
    assert.equal(r.challenge.challengerAddress, c._challengerAddress);
  }
});

test("#747: tampered challengeId rejected (deterministic derivation mismatch)", async () => {
  const c = await buildSignedChallenge({});
  const tampered = { ...c, challengeId: "0x" + "ff".repeat(32) };
  const r = validatePoseChallengePayload(tampered, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /does not match deterministic derivation/);
});

test("#747: tampered querySpec (hash mismatch) rejected", async () => {
  const c = await buildSignedChallenge({});
  const tampered = { ...c, querySpec: { kind: "uptime", blockNumber: 9999 } };
  const r = validatePoseChallengePayload(tampered, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /querySpec does not hash to querySpecHash/);
});

test("#747: tampered challengerSig rejected (recover mismatch)", async () => {
  const c = await buildSignedChallenge({});
  const otherWallet = new Wallet("0x" + "00".repeat(31) + "ab");
  // Sign with the wrong key but claim the original challengerId.
  const domain = toEthersDomain(buildDomain(CHAIN_ID, VERIFYING_CONTRACT));
  const challengeData = {
    challengeId: c.challengeId,
    epochId: BigInt(c.epochId),
    nodeId: c.nodeId,
    challengeType: 0,
    nonce: c.nonce,
    challengeNonce: BigInt(c.challengeNonce),
    querySpecHash: c.querySpecHash,
    issuedAtMs: BigInt(c.issuedAtMs),
    deadlineMs: BigInt(c.deadlineMs),
    challengerId: c.challengerId,
  };
  const wrongSig = await otherWallet.signTypedData(domain, CHALLENGE_TYPES, challengeData);
  const tampered = { ...c, challengerSig: wrongSig };
  const r = validatePoseChallengePayload(tampered, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /does not recover to challengerId/);
});

test("#747: malformed challengerSig returns 400 without ethers leak", async () => {
  const c = await buildSignedChallenge({});
  const r = validatePoseChallengePayload(
    { ...c, challengerSig: "0x" + "00".repeat(65) },
    { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /malformed or does not recover/);
    assert.doesNotMatch(r.error, /TypeError|stack/);
  }
});

test("#747: issuedAtMs out of drift window rejected", async () => {
  const now = 1_700_000_000_000;
  const c = await buildSignedChallenge({ issuedAtMs: now - 10 * 60_000 }); // 10 minutes ago
  const r = validatePoseChallengePayload(c, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    maxIssuedAtDriftMs: 60_000,
    nowMs: () => now,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /drift/);
});

test("#747: issuedAtMs at drift boundary accepted", async () => {
  const now = 1_700_000_000_000;
  const c = await buildSignedChallenge({ issuedAtMs: now - 60_000 });
  const r = validatePoseChallengePayload(c, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    maxIssuedAtDriftMs: 60_000,
    nowMs: () => now,
  });
  assert.equal(r.ok, true);
});

test("#747: malformed v2 shape (missing fields) returns deterministic 400", () => {
  // Has version:2 but missing required v2 fields.
  const r = validatePoseChallengePayload(
    { version: 2, challengeId: "abc" },
    { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    // The error must be schema-class, not echo the bogus "abc".
    assert.doesNotMatch(r.error, /abc/);
  }
});

test("#747: pre-mined attack reproduction — caller cannot swap nodeId under same sig", async () => {
  // Attacker generates a valid signed challenge for target node A, then
  // tries to submit it claiming target node B. Since nodeId is in the
  // signed digest, ecrecover succeeds against the WRONG challengerId-
  // claimed value but the derived challengeId no longer matches — the
  // first guard fires.
  const c = await buildSignedChallenge({});
  const tampered = { ...c, nodeId: "0x" + "99".repeat(32) };
  const r = validatePoseChallengePayload(tampered, {
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /does not match deterministic derivation/);
});

test("#747: invalid epochId / challengeNonce shapes rejected", async () => {
  const c = await buildSignedChallenge({});
  for (const bad of ["abc", -1, 1.5, {}, null]) {
    const r = validatePoseChallengePayload(
      { ...c, epochId: bad as any },
      { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT },
    );
    assert.equal(r.ok, false, `epochId=${JSON.stringify(bad)} must reject`);
  }
});

test("#747: invalid challengeType normalisation rejected", async () => {
  const c = await buildSignedChallenge({});
  const r = validatePoseChallengePayload(
    { ...c, challengeType: "Garbage" },
    { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /U\/S\/R/);
});
