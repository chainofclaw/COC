import { AbiCoder, solidityPackedKeccak256 } from "ethers";
import { ResultCode, type EvidenceLeafV2, type FaultType } from "../../services/common/pose-types-v2.ts";

export interface EvidenceLeafV2Input {
  epoch: bigint | number | string;
  nodeId: string;
  nonce: string;
  tipHash: string;
  tipHeight: bigint | number | string;
  latencyMs: number;
  resultCode: number;
  witnessBitmap: number;
}

export interface V2FaultProofPayload {
  batchId: string;
  merkleProof: string[];
  evidenceLeaf: EvidenceLeafV2Input;
  evidenceLeafHash?: string;
  faultType?: number;
}

export function faultTypeForResultCode(resultCode: number): FaultType | 0 {
  if (resultCode === ResultCode.InvalidSig) return 2;
  if (resultCode === ResultCode.Timeout) return 3;
  if (
    resultCode === ResultCode.StorageProofFail ||
    resultCode === ResultCode.RelayWitnessFail ||
    resultCode === ResultCode.TipMismatch ||
    resultCode === ResultCode.NonceMismatch ||
    resultCode === ResultCode.WitnessQuorumFail
  ) return 4;
  return 0;
}

export function normalizeEvidenceLeaf(input: EvidenceLeafV2Input): EvidenceLeafV2 {
  return {
    epoch: BigInt(input.epoch),
    nodeId: input.nodeId as `0x${string}`,
    nonce: input.nonce as `0x${string}`,
    tipHash: input.tipHash as `0x${string}`,
    tipHeight: BigInt(input.tipHeight),
    latencyMs: Number(input.latencyMs),
    resultCode: Number(input.resultCode) as EvidenceLeafV2["resultCode"],
    witnessBitmap: Number(input.witnessBitmap),
  };
}

export function serializeEvidenceLeaf(input: EvidenceLeafV2): EvidenceLeafV2Input {
  return {
    epoch: input.epoch.toString(),
    nodeId: input.nodeId,
    nonce: input.nonce,
    tipHash: input.tipHash,
    tipHeight: input.tipHeight.toString(),
    latencyMs: input.latencyMs,
    resultCode: input.resultCode,
    witnessBitmap: input.witnessBitmap,
  };
}

export function encodeEvidenceData(batchId: string, merkleProof: string[], evidenceLeaf: EvidenceLeafV2Input): `0x${string}` {
  const abi = AbiCoder.defaultAbiCoder();
  const normalized = normalizeEvidenceLeaf(evidenceLeaf);
  return abi.encode(
    [
      "bytes32",
      "bytes32[]",
      "tuple(uint64 epoch, bytes32 nodeId, bytes16 nonce, bytes32 tipHash, uint64 tipHeight, uint32 latencyMs, uint8 resultCode, uint32 witnessBitmap)",
    ],
    [
      batchId,
      merkleProof,
      [
        normalized.epoch,
        normalized.nodeId,
        normalized.nonce,
        normalized.tipHash,
        normalized.tipHeight,
        normalized.latencyMs,
        normalized.resultCode,
        normalized.witnessBitmap,
      ],
    ],
  ) as `0x${string}`;
}

export function computeCommitHash(
  targetNodeId: string,
  faultType: number,
  evidenceLeafHash: string,
  salt: string,
): `0x${string}` {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32"],
    [targetNodeId, faultType, evidenceLeafHash, salt],
  ) as `0x${string}`;
}

export function computeRevealDigest(
  challengeId: string,
  targetNodeId: string,
  faultType: number,
  evidenceLeafHash: string,
  salt: string,
  evidenceData: string,
): `0x${string}` {
  return solidityPackedKeccak256(
    ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
    ["coc-fault:", challengeId, targetNodeId, faultType, evidenceLeafHash, salt, solidityPackedKeccak256(["bytes"], [evidenceData])],
  ) as `0x${string}`;
}

export function extractV2FaultProofPayload(rawEvidence: Record<string, unknown>): V2FaultProofPayload | null {
  if (Number(rawEvidence.protocolVersion ?? 0) !== 2) return null;
  if (typeof rawEvidence.batchId !== "string") return null;
  if (!Array.isArray(rawEvidence.merkleProof) || rawEvidence.merkleProof.some((item) => typeof item !== "string")) return null;
  if (!rawEvidence.evidenceLeaf || typeof rawEvidence.evidenceLeaf !== "object") return null;

  return {
    batchId: rawEvidence.batchId,
    merkleProof: rawEvidence.merkleProof as string[],
    evidenceLeaf: rawEvidence.evidenceLeaf as EvidenceLeafV2Input,
    evidenceLeafHash: typeof rawEvidence.evidenceLeafHash === "string" ? rawEvidence.evidenceLeafHash : undefined,
    faultType: typeof rawEvidence.faultType === "number" ? rawEvidence.faultType : undefined,
  };
}
