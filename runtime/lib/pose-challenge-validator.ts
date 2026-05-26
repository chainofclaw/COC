/**
 * pose-challenge-validator.ts — #747 (#667 F4, audit follow-up 2026-05-26).
 *
 * Pre-fix `runtime/coc-node.ts:/pose/challenge` accepted an arbitrary
 * caller-supplied `challengeId` string. Combined with the witness path
 * never verifying the challenger's identity (#667 main issue), this
 * gave the challenger a free degree of freedom: pre-mine a pool of
 * challengeIds, rotate them through witness collection to maximise
 * `(challengeId, responseBodyHash)` collision opportunities for v1
 * fallback replay (#748).
 *
 * This module validates a v2-shape challenge payload by recomputing the
 * deterministic challengeId digest the same way services/challenger/
 * challenge-factory-v2.ts produces it, then verifying the EIP-712
 * CHALLENGE_TYPES signature recovers to `challengerId` derived as the
 * trailing 20 bytes of the bytes32 challenger identifier.
 *
 * Legacy v1 payloads (no `version: 2` field, no challengerSig) are
 * accepted in lenient mode so existing in-flight callers keep working
 * during the rollout; the gate is `COC_POSE_REQUIRE_VERIFIED_CHALLENGE=1`.
 *
 * Rejections all return deterministic error messages — never echo
 * client input (#322 class).
 */

import { verifyTypedData } from "ethers";
import { CHALLENGE_TYPES, buildDomain, toEthersDomain } from "../../node/src/crypto/eip712-types.ts";
import { keccak256Hex } from "../../services/relayer/keccak256.ts";
import { stableStringify, u64Bytes, hex32Bytes, hexSizedBytes } from "../../services/common/encoding.ts";
import { ChallengeType } from "../../services/common/pose-types.ts";

const HEX32_RE = /^0[xX][0-9a-fA-F]{64}$/;
const HEX16_RE = /^0[xX][0-9a-fA-F]{32}$/;
const SIG_HEX_RE = /^0[xX][0-9a-fA-F]{130}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

const TYPE_TO_CODE: Record<string, "U" | "S" | "R"> = {
  U: "U",
  S: "S",
  R: "R",
  Uptime: "U",
  Storage: "S",
  Relay: "R",
  "0": "U",
  "1": "S",
  "2": "R",
};

const TYPE_TO_INT: Record<"U" | "S" | "R", number> = { U: 0, S: 1, R: 2 };

export interface ValidatedChallenge {
  version: 1 | 2;
  challengeId: string;
  nodeId?: string;
  challengeType?: "U" | "S" | "R";
  querySpec?: Record<string, unknown>;
  challengerId?: string;
  challengerAddress?: string;
}

export interface ChallengeValidateOpts {
  chainId: bigint;
  verifyingContract: string;
  /** When true, v1-shape (no challengerSig) payloads are rejected. */
  requireVerified?: boolean;
  /** Maximum age tolerated for `issuedAtMs` drift. Default 5 minutes. */
  maxIssuedAtDriftMs?: number;
  /** For deterministic tests. */
  nowMs?: () => number;
}

export type ChallengeValidateResult =
  | { ok: true; challenge: ValidatedChallenge }
  | { ok: false; status: number; error: string };

export function validatePoseChallengePayload(
  payload: unknown,
  opts: ChallengeValidateOpts,
): ChallengeValidateResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  const p = payload as Record<string, unknown>;

  const hasV2Shape = p.version === 2 || typeof p.challengerSig === "string";

  // ── Legacy v1 payload ────────────────────────────────────────────
  if (!hasV2Shape) {
    if (opts.requireVerified) {
      return {
        ok: false,
        status: 400,
        error: "verified v2 challenge required (set version:2 + challengerSig + querySpecHash)",
      };
    }
    if (typeof p.challengeId !== "string" || p.challengeId.length === 0 || p.challengeId.length > 256) {
      return { ok: false, status: 400, error: "missing or invalid challengeId" };
    }
    return { ok: true, challenge: { version: 1, challengeId: p.challengeId } };
  }

  // ── v2 — full verification ───────────────────────────────────────
  if (typeof p.challengeId !== "string" || !HEX32_RE.test(p.challengeId)) {
    return { ok: false, status: 400, error: "challengeId must match 0x-prefixed 32-byte hex" };
  }
  if (typeof p.nodeId !== "string" || !HEX32_RE.test(p.nodeId)) {
    return { ok: false, status: 400, error: "nodeId must match 0x-prefixed 32-byte hex" };
  }
  if (typeof p.nonce !== "string" || !HEX16_RE.test(p.nonce)) {
    return { ok: false, status: 400, error: "nonce must match 0x-prefixed 16-byte hex" };
  }
  if (typeof p.querySpecHash !== "string" || !HEX32_RE.test(p.querySpecHash)) {
    return { ok: false, status: 400, error: "querySpecHash must match 0x-prefixed 32-byte hex" };
  }
  if (typeof p.challengerId !== "string" || !HEX32_RE.test(p.challengerId)) {
    return { ok: false, status: 400, error: "challengerId must match 0x-prefixed 32-byte hex" };
  }
  if (typeof p.challengerSig !== "string" || !SIG_HEX_RE.test(p.challengerSig)) {
    return { ok: false, status: 400, error: "challengerSig must match 0x-prefixed 65-byte hex" };
  }

  const epochId = coerceUint64(p.epochId);
  if (epochId === undefined) return { ok: false, status: 400, error: "epochId must be a non-negative uint64" };
  const challengeNonce = coerceUint64(p.challengeNonce);
  if (challengeNonce === undefined) return { ok: false, status: 400, error: "challengeNonce must be a non-negative uint64" };
  const issuedAtMs = coerceUint64(p.issuedAtMs);
  if (issuedAtMs === undefined) return { ok: false, status: 400, error: "issuedAtMs must be a non-negative uint64" };
  const deadlineMs = coerceUint64(p.deadlineMs);
  if (deadlineMs === undefined) return { ok: false, status: 400, error: "deadlineMs must be a non-negative uint64" };

  // challengeType normalisation: accept "U" / "S" / "R" / int / long name.
  const rawType = p.challengeType;
  const typeCode = TYPE_TO_CODE[String(rawType)];
  if (!typeCode) {
    return { ok: false, status: 400, error: "challengeType must be one of U/S/R" };
  }

  // ── Recompute the deterministic challengeId digest (must match
  //    services/challenger/challenge-factory-v2.ts:48). Mismatch =>
  //    caller is supplying a stolen / replayed / fabricated triple.
  const digest = Buffer.concat([
    u64Bytes(epochId),
    hex32Bytes(p.nodeId as `0x${string}`),
    Buffer.from(typeCode, "utf8"),
    hexSizedBytes(p.nonce as `0x${string}`, 16),
    hex32Bytes(p.challengerId as `0x${string}`),
    u64Bytes(challengeNonce),
  ]);
  const expectedChallengeId = `0x${keccak256Hex(digest)}`.toLowerCase();
  if (expectedChallengeId !== (p.challengeId as string).toLowerCase()) {
    return {
      ok: false,
      status: 400,
      error: "challengeId does not match deterministic derivation",
    };
  }

  // ── Freshness: bound the issuedAtMs drift so an old signed
  //    challenge can't be re-fed years later.
  const drift = (opts.maxIssuedAtDriftMs ?? 5 * 60_000);
  const now = (opts.nowMs ?? Date.now)();
  if (Math.abs(now - Number(issuedAtMs)) > drift) {
    return {
      ok: false,
      status: 400,
      error: `issuedAtMs out of drift window (drift > ${drift}ms)`,
    };
  }

  // ── EIP-712 signature verification against CHALLENGE_TYPES.
  //    Must match ChallengeFactoryV2.issue() field shape exactly.
  const domain = toEthersDomain(buildDomain(opts.chainId, opts.verifyingContract));
  const challengeData = {
    challengeId: p.challengeId,
    epochId,
    nodeId: p.nodeId,
    challengeType: TYPE_TO_INT[typeCode],
    nonce: p.nonce,
    challengeNonce,
    querySpecHash: p.querySpecHash,
    issuedAtMs,
    deadlineMs,
    challengerId: p.challengerId,
  };

  let recovered: string;
  try {
    recovered = verifyTypedData(domain, CHALLENGE_TYPES, challengeData, p.challengerSig as string).toLowerCase();
  } catch {
    return { ok: false, status: 400, error: "challengerSig malformed or does not recover" };
  }

  // challengerId is bytes32; the EOA is the trailing 20 bytes.
  const challengerAddress = `0x${(p.challengerId as string).toLowerCase().slice(-40)}`;
  if (recovered !== challengerAddress) {
    return { ok: false, status: 400, error: "challengerSig does not recover to challengerId" };
  }

  // querySpec optional — if provided, validate the hash matches so the
  // caller can't lie about what query they signed.
  let querySpec: Record<string, unknown> | undefined;
  if (p.querySpec !== undefined && p.querySpec !== null) {
    if (typeof p.querySpec !== "object" || Array.isArray(p.querySpec)) {
      return { ok: false, status: 400, error: "querySpec must be a JSON object when provided" };
    }
    const recomputed = `0x${keccak256Hex(Buffer.from(stableStringify(p.querySpec), "utf8"))}`.toLowerCase();
    if (recomputed !== (p.querySpecHash as string).toLowerCase()) {
      return { ok: false, status: 400, error: "querySpec does not hash to querySpecHash" };
    }
    querySpec = p.querySpec as Record<string, unknown>;
  }

  return {
    ok: true,
    challenge: {
      version: 2,
      challengeId: (p.challengeId as string).toLowerCase(),
      nodeId: (p.nodeId as string).toLowerCase(),
      challengeType: typeCode,
      querySpec,
      challengerId: (p.challengerId as string).toLowerCase(),
      challengerAddress,
    },
  };
}

function coerceUint64(value: unknown): bigint | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const v = BigInt(value);
    if (v < 0n || v > MAX_UINT64) return undefined;
    return v;
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_UINT64) return undefined;
    return value;
  }
  return undefined;
}
