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
  /**
   * #667 (audit follow-up, 2026-05-26) — optional Push-verification
   * fields. When all five are present, the witness re-derives
   * `responseBodyHash` from `responseBody` and ecrecovers the prover's
   * `nodeSig` against the RECEIPT_TYPES digest. Only when both checks
   * pass does the witness sign the attestation.
   *
   * The fields are optional during the rollout window:
   * - Caller passes them → witness MUST verify; fail → 400
   * - Caller omits them → witness falls back to legacy rubber-stamp
   *   behaviour (gated by `COC_POSE_WITNESS_REQUIRE_VERIFIED`; default
   *   `false` in current release to preserve interop, will flip to
   *   `true` once all agents ship the push fields).
   *
   * F2 (freshness): `responseAtMs` is checked against wall-clock so a
   * witness can't be tricked into signing a stale receipt that was
   * re-fed across challenges.
   */
  responseBody?: Record<string, unknown>;
  responseAtMs?: number;
  nodeSig?: string;
  tipHash?: string;
  tipHeight?: bigint;
}

const HEX32_RE = /^0[xX][0-9a-fA-F]{64}$/;
const HEX_ADDR_RE = /^0[xX][0-9a-fA-F]{40}$/;
const SIG_HEX_RE = /^0[xX][0-9a-fA-F]{130}$/;
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Pre-#667 the validator hard-locked nodeId to a 20-byte address. But the
 * v2 witness pipeline (BatchAggregatorV2 + on-chain `_validateWitnessQuorumV2`)
 * uses the 32-byte `poseNodeId = keccak256(pubkeyNode)` so the EIP-712
 * `Receipt.nodeId` field (declared `bytes32`) can pass ethers' length check.
 * The 20-byte-only validator silently rejected every v2 witness request,
 * leaving production stuck on the empty-witness owner-only fallback. Accept
 * both shapes so legacy 20-byte callers continue to work and the v2 push
 * path can actually settle.
 */
function isWitnessNodeIdShape(value: string): boolean {
  return HEX_ADDR_RE.test(value) || HEX32_RE.test(value);
}

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
  if (typeof p.nodeId !== "string" || !isWitnessNodeIdShape(p.nodeId)) {
    return { ok: false, status: 400, error: "nodeId must match 0x-prefixed 20-byte address or 32-byte hash" };
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

  // #667 (audit follow-up, 2026-05-26) — Push-verification fields. All
  // five must appear together or none at all; partial sets are a strict
  // 400 to avoid downgrade attacks where a malicious caller omits one
  // field to dodge a specific check (e.g. drop `nodeSig` to skip
  // signature verification while keeping `responseBody` to look legit
  // in logs).
  const pushFieldNames = ["responseBody", "responseAtMs", "nodeSig", "tipHash", "tipHeight"] as const;
  const pushPresent = pushFieldNames.filter(n => p[n] !== undefined && p[n] !== null);
  if (pushPresent.length !== 0 && pushPresent.length !== pushFieldNames.length) {
    return { ok: false, status: 400, error: "push fields must be supplied together (responseBody, responseAtMs, nodeSig, tipHash, tipHeight)" };
  }

  let responseBody: Record<string, unknown> | undefined;
  let responseAtMs: number | undefined;
  let nodeSig: string | undefined;
  let tipHash: string | undefined;
  let tipHeight: bigint | undefined;

  if (pushPresent.length === pushFieldNames.length) {
    if (typeof p.responseBody !== "object" || p.responseBody === null || Array.isArray(p.responseBody)) {
      return { ok: false, status: 400, error: "responseBody must be a JSON object" };
    }
    if (typeof p.responseAtMs !== "number" || !Number.isFinite(p.responseAtMs) ||
        !Number.isInteger(p.responseAtMs) || p.responseAtMs < 0) {
      return { ok: false, status: 400, error: "responseAtMs must be a non-negative integer milliseconds value" };
    }
    if (typeof p.nodeSig !== "string" || !SIG_HEX_RE.test(p.nodeSig)) {
      return { ok: false, status: 400, error: "nodeSig must match 0x-prefixed 65-byte hex" };
    }
    if (typeof p.tipHash !== "string" || !HEX32_RE.test(p.tipHash)) {
      return { ok: false, status: 400, error: "tipHash must match 0x-prefixed 32-byte hex" };
    }
    // tipHeight: same shape as epochId (number or decimal string), uint64 bound.
    let tipHeightParsed: bigint;
    if (typeof p.tipHeight === "number") {
      if (!Number.isFinite(p.tipHeight) || !Number.isInteger(p.tipHeight) || p.tipHeight < 0) {
        return { ok: false, status: 400, error: "tipHeight must be a non-negative integer" };
      }
      tipHeightParsed = BigInt(p.tipHeight);
    } else if (typeof p.tipHeight === "string" && /^[0-9]+$/.test(p.tipHeight)) {
      tipHeightParsed = BigInt(p.tipHeight);
    } else if (typeof p.tipHeight === "bigint") {
      tipHeightParsed = p.tipHeight;
    } else {
      return { ok: false, status: 400, error: "tipHeight must be a non-negative integer" };
    }
    if (tipHeightParsed < 0n || tipHeightParsed > MAX_UINT64) {
      return { ok: false, status: 400, error: "tipHeight out of uint64 range" };
    }
    responseBody = p.responseBody as Record<string, unknown>;
    responseAtMs = p.responseAtMs;
    nodeSig = p.nodeSig.toLowerCase();
    tipHash = p.tipHash.toLowerCase();
    tipHeight = tipHeightParsed;
  }

  return {
    ok: true,
    fields: {
      challengeId: p.challengeId,
      nodeId: p.nodeId.toLowerCase(),
      responseBodyHash: p.responseBodyHash.toLowerCase(),
      witnessIndex: p.witnessIndex,
      epochId,
      responseBody,
      responseAtMs,
      nodeSig,
      tipHash,
      tipHeight,
    },
  };
}
