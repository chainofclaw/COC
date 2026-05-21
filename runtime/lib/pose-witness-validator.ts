/**
 * #322: validate /pose/witness payload shape before the EIP-712 sign path.
 *
 * Pre-fix the handler only checked `!payload.x` (falsy) for the three
 * string fields and `=== undefined` for witnessIndex. Anything truthy
 * (objects, arrays, numbers for strings; null/strings/objects for
 * witnessIndex) flowed straight to nodeSignerV2.eip712.signTypedData,
 * which threw inside ethers and surfaced via the .catch as
 *   500 "witness signing failed: <leaked V8/ethers TypeError>"
 * Same family as #214 (ethers error leak) / #294 (V8 error leak).
 *
 * The fix is a single up-front shape check: strings must be hex strings
 * matching the on-chain shape; witnessIndex must be a non-negative
 * integer. Anything else gets a clean 400 with a deterministic message,
 * no V8/ethers internals reflected.
 */

export interface PoseWitnessFields {
  challengeId: string;
  nodeId: string;
  responseBodyHash: string;
  witnessIndex: number;
  /**
   * #667 — optional epochId for v2 typehash binding. When provided the
   * server returns both v1 and v2 signatures; when absent only v1 is
   * produced (backwards-compatible with pre-#667 callers).
   */
  epochId?: bigint;
}

const HEX32_RE = /^0[xX][0-9a-fA-F]{64}$/;
const HEX_ADDR_RE = /^0[xX][0-9a-fA-F]{40}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

export type ValidateResult =
  | { ok: true; fields: PoseWitnessFields }
  | { ok: false; status: number; error: string };

export function validatePoseWitnessPayload(payload: unknown): ValidateResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.challengeId !== "string" || !HEX32_RE.test(p.challengeId)) {
    return { ok: false, status: 400, error: "challengeId must match 0x-prefixed 32-byte hex" };
  }
  if (typeof p.nodeId !== "string" || !HEX_ADDR_RE.test(p.nodeId)) {
    return { ok: false, status: 400, error: "nodeId must match 0x-prefixed 20-byte hex address" };
  }
  if (typeof p.responseBodyHash !== "string" || !HEX32_RE.test(p.responseBodyHash)) {
    return { ok: false, status: 400, error: "responseBodyHash must match 0x-prefixed 32-byte hex" };
  }
  if (typeof p.witnessIndex !== "number" || !Number.isFinite(p.witnessIndex) ||
      !Number.isInteger(p.witnessIndex) || p.witnessIndex < 0) {
    return { ok: false, status: 400, error: "witnessIndex must be a non-negative integer" };
  }

  // #667: epochId is optional during the rollout window. Accept number or
  // decimal-string (JSON has no bigint native form); reject anything else.
  let epochId: bigint | undefined;
  if (p.epochId !== undefined && p.epochId !== null) {
    let parsed: bigint;
    if (typeof p.epochId === "number") {
      if (!Number.isFinite(p.epochId) || !Number.isInteger(p.epochId) || p.epochId < 0) {
        return { ok: false, status: 400, error: "epochId must be a non-negative integer" };
      }
      parsed = BigInt(p.epochId);
    } else if (typeof p.epochId === "string" && /^[0-9]+$/.test(p.epochId)) {
      parsed = BigInt(p.epochId);
    } else if (typeof p.epochId === "bigint") {
      parsed = p.epochId;
    } else {
      return { ok: false, status: 400, error: "epochId must be a non-negative integer" };
    }
    if (parsed < 0n || parsed > MAX_UINT64) {
      return { ok: false, status: 400, error: "epochId out of uint64 range" };
    }
    epochId = parsed;
  }

  return {
    ok: true,
    fields: {
      challengeId: p.challengeId,
      nodeId: p.nodeId.toLowerCase(),
      responseBodyHash: p.responseBodyHash.toLowerCase(),
      witnessIndex: p.witnessIndex,
      epochId,
    },
  };
}
