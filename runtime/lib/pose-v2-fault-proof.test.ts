import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, solidityPackedKeccak256 } from "ethers";
import {
  computeCommitHash,
  computeRevealDigest,
  encodeEvidenceData,
  extractV2FaultProofPayload,
  faultTypeForResultCode,
} from "./pose-v2-fault-proof.ts";

describe("pose-v2-fault-proof", () => {
  it("encodes evidence data in the Solidity tuple layout", () => {
    const payload = {
      batchId: `0x${"11".repeat(32)}`,
      merkleProof: [`0x${"22".repeat(32)}`],
      evidenceLeaf: {
        epoch: "7",
        nodeId: `0x${"33".repeat(32)}`,
        nonce: `0x${"44".repeat(16)}`,
        tipHash: `0x${"55".repeat(32)}`,
        tipHeight: "99",
        latencyMs: 42,
        resultCode: 7,
        witnessBitmap: 3,
      },
    };

    const encoded = encodeEvidenceData(payload.batchId, payload.merkleProof, payload.evidenceLeaf);
    const decoded = AbiCoder.defaultAbiCoder().decode(
      [
        "bytes32",
        "bytes32[]",
        "tuple(uint64 epoch, bytes32 nodeId, bytes16 nonce, bytes32 tipHash, uint64 tipHeight, uint32 latencyMs, uint8 resultCode, uint32 witnessBitmap)",
      ],
      encoded,
    );

    assert.equal(decoded[0], payload.batchId);
    assert.deepEqual([...decoded[1]], payload.merkleProof);
    assert.equal(decoded[2].epoch, 7n);
    assert.equal(decoded[2].nodeId, payload.evidenceLeaf.nodeId);
    assert.equal(decoded[2].nonce, payload.evidenceLeaf.nonce);
    assert.equal(decoded[2].tipHash, payload.evidenceLeaf.tipHash);
    assert.equal(decoded[2].tipHeight, 99n);
    assert.equal(decoded[2].latencyMs, 42n);
    assert.equal(decoded[2].resultCode, 7n);
    assert.equal(decoded[2].witnessBitmap, 3n);
  });

  it("matches Solidity abi.encodePacked digests for commit and reveal", () => {
    const challengeId = `0x${"aa".repeat(32)}`;
    const targetNodeId = `0x${"bb".repeat(32)}`;
    const evidenceLeafHash = `0x${"cc".repeat(32)}`;
    const salt = `0x${"dd".repeat(32)}`;
    const faultType = 4;
    const evidenceData = encodeEvidenceData(
      `0x${"11".repeat(32)}`,
      [`0x${"22".repeat(32)}`],
      {
        epoch: "1",
        nodeId: targetNodeId,
        nonce: `0x${"33".repeat(16)}`,
        tipHash: `0x${"44".repeat(32)}`,
        tipHeight: "2",
        latencyMs: 7,
        resultCode: 7,
        witnessBitmap: 1,
      },
    );

    assert.equal(
      computeCommitHash(targetNodeId, faultType, evidenceLeafHash, salt),
      solidityPackedKeccak256(["bytes32", "uint8", "bytes32", "bytes32"], [targetNodeId, faultType, evidenceLeafHash, salt]),
    );

    assert.equal(
      computeRevealDigest(challengeId, targetNodeId, faultType, evidenceLeafHash, salt, evidenceData),
      solidityPackedKeccak256(
        ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
        ["coc-fault:", challengeId, targetNodeId, faultType, evidenceLeafHash, salt, solidityPackedKeccak256(["bytes"], [evidenceData])],
      ),
    );
  });

  it("extracts only protocolVersion=2 payloads", () => {
    const payload = extractV2FaultProofPayload({
      protocolVersion: 2,
      batchId: `0x${"11".repeat(32)}`,
      merkleProof: [`0x${"22".repeat(32)}`],
      evidenceLeaf: {
        epoch: "1",
        nodeId: `0x${"33".repeat(32)}`,
        nonce: `0x${"44".repeat(16)}`,
        tipHash: `0x${"55".repeat(32)}`,
        tipHeight: "2",
        latencyMs: 9,
        resultCode: 7,
        witnessBitmap: 1,
      },
      faultType: 4,
    });

    assert.ok(payload);
    assert.equal(payload?.faultType, 4);
    assert.equal(extractV2FaultProofPayload({ protocolVersion: 1 }), null);
  });

  it("maps result codes to fault types", () => {
    assert.equal(faultTypeForResultCode(0), 0);
    assert.equal(faultTypeForResultCode(2), 2);
    assert.equal(faultTypeForResultCode(1), 3);
    assert.equal(faultTypeForResultCode(7), 4);
  });
});
