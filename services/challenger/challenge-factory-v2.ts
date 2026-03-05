// PoSe v2 challenge factory using EIP-712 typed data signatures.

import { randomBytes } from "node:crypto"
import { keccak256Hex } from "../relayer/keccak256.ts"
import { ChallengeType, type Hex32 } from "../common/pose-types.ts"
import type { ChallengeMessageV2 } from "../common/pose-types-v2.ts"
import { stableStringify, u64Bytes, hex32Bytes, hexSizedBytes } from "../common/encoding.ts"
import type { Eip712Signer } from "../../node/src/crypto/eip712-signer.ts"
import { CHALLENGE_TYPES } from "../../node/src/crypto/eip712-types.ts"

export interface ChallengeFactoryV2Config {
  challengerId: Hex32
  eip712Signer: Eip712Signer
}

export interface IssueChallengeV2Input {
  epochId: bigint
  nodeId: Hex32
  challengeType: keyof typeof ChallengeType
  issuedAtMs: bigint
  querySpec: Record<string, unknown>
  challengeNonce: bigint
}

export class ChallengeFactoryV2 {
  private readonly config: ChallengeFactoryV2Config

  constructor(config: ChallengeFactoryV2Config) {
    this.config = config
  }

  async issue(input: IssueChallengeV2Input): Promise<ChallengeMessageV2> {
    const nonce = `0x${randomBytes(16).toString("hex")}` as `0x${string}`
    const challengeCode = ChallengeType[input.challengeType]
    const deadlineMs = challengeCode === ChallengeType.Storage ? 6000 : 2500

    const querySpecHash = `0x${keccak256Hex(Buffer.from(stableStringify(input.querySpec), "utf8"))}` as Hex32

    // Build challengeId from digest
    const digest = Buffer.concat([
      u64Bytes(input.epochId),
      hex32Bytes(input.nodeId),
      Buffer.from(challengeCode, "utf8"),
      hexSizedBytes(nonce, 16),
      hex32Bytes(this.config.challengerId),
      u64Bytes(input.challengeNonce),
    ])
    const challengeId = `0x${keccak256Hex(digest)}` as Hex32

    // EIP-712 sign the challenge
    const challengeData = {
      challengeId,
      epochId: input.epochId,
      nodeId: input.nodeId,
      challengeType: ChallengeType[input.challengeType] === "U" ? 0 : ChallengeType[input.challengeType] === "S" ? 1 : 2,
      nonce,
      challengeNonce: input.challengeNonce,
      querySpecHash,
      issuedAtMs: input.issuedAtMs,
      deadlineMs: BigInt(deadlineMs),
      challengerId: this.config.challengerId,
    }

    const challengerSig = await this.config.eip712Signer.signTypedData(
      CHALLENGE_TYPES,
      challengeData as unknown as Record<string, unknown>,
    ) as `0x${string}`

    return {
      version: 2,
      challengeId,
      epochId: input.epochId,
      nodeId: input.nodeId,
      challengeType: challengeCode,
      nonce,
      challengeNonce: input.challengeNonce,
      querySpec: input.querySpec,
      querySpecHash,
      issuedAtMs: input.issuedAtMs,
      deadlineMs,
      challengerId: this.config.challengerId,
      challengerSig,
    }
  }
}
