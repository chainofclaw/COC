import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { lookupRewardClaim, manifestSigningPayload, readBestRewardManifest, stableStringifyForHash, verifyManifestSignature, writeRewardManifest, writeSettledRewardManifest, type RewardManifest } from "./reward-manifest.ts";
import { buildDomain, REWARD_MANIFEST_TYPES } from "../../node/src/crypto/eip712-types.ts";
import { toEthersDomain } from "../../node/src/crypto/eip712-types.ts";

describe("reward-manifest", () => {
  it("serializes bigint values without throwing", () => {
    const encoded = stableStringifyForHash([{ nodeId: "0x1", storageGb: 1n }]);
    assert.equal(encoded, `[{"nodeId":"0x1","storageGb":1}]`);
  });

  it("sorts object keys for deterministic hashing", () => {
    const a = stableStringifyForHash({ b: 2, a: 1, nested: { y: 2, x: 1 } });
    const b = stableStringifyForHash({ nested: { x: 1, y: 2 }, a: 1, b: 2 });
    assert.equal(a, b);
  });

  it("lookupRewardClaim finds proof using normalized node id", () => {
    const manifest: RewardManifest = {
      epochId: 3,
      rewardRoot: `0x${"11".repeat(32)}`,
      totalReward: "10",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [{ nodeId: `0x${"ab".repeat(32)}`, amount: "10" }],
      proofs: {
        [`3:0x${"ab".repeat(32)}`]: [`0x${"cd".repeat(32)}`],
      },
      scoringInputsHash: `0x${"22".repeat(32)}`,
      generatedAtMs: 1,
    };

    const claim = lookupRewardClaim(manifest, `0x${"ab".repeat(32)}`);
    assert.deepEqual(claim, {
      epochId: 3,
      nodeId: `0x${"ab".repeat(32)}`,
      amount: "10",
      proof: [`0x${"cd".repeat(32)}`],
      rewardRoot: `0x${"11".repeat(32)}`,
      totalReward: "10",
      settled: false,
    });
  });

  it("verifyManifestSignature returns missing when no signature", () => {
    const manifest: RewardManifest = {
      epochId: 1,
      rewardRoot: `0x${"11".repeat(32)}`,
      totalReward: "100",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"22".repeat(32)}`,
      generatedAtMs: 1,
    };
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const result = verifyManifestSignature(manifest, domain);
    assert.equal(result.valid, false);
    assert.equal(result.error, "missing");
  });

  it("verifyManifestSignature roundtrip with valid signature", async () => {
    const wallet = Wallet.createRandom();
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 5,
      rewardRoot: `0x${"ab".repeat(32)}`,
      totalReward: "500",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"cd".repeat(32)}`,
      generatedAtMs: Date.now(),
    };

    const payload = manifestSigningPayload(manifest);
    const signature = await wallet.signTypedData(
      toEthersDomain(domain),
      REWARD_MANIFEST_TYPES,
      payload,
    );
    manifest.generatorSignature = signature;
    manifest.generatorAddress = wallet.address.toLowerCase();

    const result = verifyManifestSignature(manifest, domain);
    assert.equal(result.valid, true);
    assert.equal(result.recoveredAddress, wallet.address.toLowerCase());
  });

  it("verifyManifestSignature detects tampering", async () => {
    const wallet = Wallet.createRandom();
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 5,
      rewardRoot: `0x${"ab".repeat(32)}`,
      totalReward: "500",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"cd".repeat(32)}`,
      generatedAtMs: Date.now(),
    };

    const payload = manifestSigningPayload(manifest);
    const signature = await wallet.signTypedData(
      toEthersDomain(domain),
      REWARD_MANIFEST_TYPES,
      payload,
    );
    manifest.generatorSignature = signature;
    manifest.generatorAddress = wallet.address.toLowerCase();

    // Tamper with totalReward
    manifest.totalReward = "999";

    const result = verifyManifestSignature(manifest, domain);
    assert.equal(result.valid, false);
    assert.equal(result.error, "address_mismatch");
  });

  it("verifyManifestSignature detects wrong address", async () => {
    const wallet = Wallet.createRandom();
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 5,
      rewardRoot: `0x${"ab".repeat(32)}`,
      totalReward: "500",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"cd".repeat(32)}`,
      generatedAtMs: Date.now(),
    };

    const payload = manifestSigningPayload(manifest);
    const signature = await wallet.signTypedData(
      toEthersDomain(domain),
      REWARD_MANIFEST_TYPES,
      payload,
    );
    manifest.generatorSignature = signature;
    manifest.generatorAddress = "0x0000000000000000000000000000000000000099"; // wrong address

    const result = verifyManifestSignature(manifest, domain);
    assert.equal(result.valid, false);
    assert.equal(result.error, "address_mismatch");
  });

  it("verifyManifestSignature rejects when neither generatorAddress nor expectedSigner is set (#727)", async () => {
    // Pre-fix: any well-formed 65-byte signature passed verification when
    // generatorAddress was omitted from the manifest. The relayer's V2
    // finalize path would then trust the manifest's rewardRoot and commit
    // an attacker-chosen value on chain.
    const wallet = Wallet.createRandom();
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 7,
      rewardRoot: `0x${"ab".repeat(32)}`,
      totalReward: "500",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"cd".repeat(32)}`,
      generatedAtMs: Date.now(),
    };

    const payload = manifestSigningPayload(manifest);
    const signature = await wallet.signTypedData(
      toEthersDomain(domain),
      REWARD_MANIFEST_TYPES,
      payload,
    );
    manifest.generatorSignature = signature;
    // Intentionally omit manifest.generatorAddress.

    const result = verifyManifestSignature(manifest, domain);
    assert.equal(result.valid, false);
    assert.equal(result.error, "no_signer_to_verify_against");
  });

  it("verifyManifestSignature accepts when expectedSigner matches recovered (#727)", async () => {
    const wallet = Wallet.createRandom();
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 8,
      rewardRoot: `0x${"ab".repeat(32)}`,
      totalReward: "500",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"cd".repeat(32)}`,
      generatedAtMs: Date.now(),
    };

    const payload = manifestSigningPayload(manifest);
    manifest.generatorSignature = await wallet.signTypedData(
      toEthersDomain(domain),
      REWARD_MANIFEST_TYPES,
      payload,
    );
    // Omit generatorAddress on purpose; trust comes from the offline-pinned
    // expectedSigner.

    const result = verifyManifestSignature(manifest, domain, { expectedSigner: wallet.address });
    assert.equal(result.valid, true);
    assert.equal(result.recoveredAddress, wallet.address.toLowerCase());
  });

  it("verifyManifestSignature rejects when expectedSigner overrides a matching self-claim (#727)", async () => {
    const realSigner = Wallet.createRandom();
    const trustedSigner = Wallet.createRandom();
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 9,
      rewardRoot: `0x${"ab".repeat(32)}`,
      totalReward: "500",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"cd".repeat(32)}`,
      generatedAtMs: Date.now(),
    };

    const payload = manifestSigningPayload(manifest);
    // Attacker signs with a random key and sets the self-claimed
    // generatorAddress to that key — the self-claim alone would pass.
    manifest.generatorSignature = await realSigner.signTypedData(
      toEthersDomain(domain),
      REWARD_MANIFEST_TYPES,
      payload,
    );
    manifest.generatorAddress = realSigner.address.toLowerCase();

    // Operator pinned a different trusted signer offline — must reject.
    const result = verifyManifestSignature(manifest, domain, { expectedSigner: trustedSigner.address });
    assert.equal(result.valid, false);
    assert.equal(result.error, "address_mismatch");
    assert.equal(result.recoveredAddress, realSigner.address.toLowerCase());
  });

  it("verifyManifestSignature handles corrupted signature gracefully", () => {
    const domain = buildDomain(1n, "0x0000000000000000000000000000000000000001");
    const manifest: RewardManifest = {
      epochId: 1,
      rewardRoot: `0x${"11".repeat(32)}`,
      totalReward: "100",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"22".repeat(32)}`,
      generatedAtMs: 1,
      generatorSignature: "0xdeadbeef",
      // #727: include a self-claim so the corrupt-signature path is reached
      // (else the new fail-closed guard short-circuits before verifyTypedData).
      generatorAddress: "0x0000000000000000000000000000000000000099",
    };
    const result = verifyManifestSignature(manifest, domain);
    assert.equal(result.valid, false);
    assert.ok(result.error?.startsWith("verify_failed:"));
  });

  it("readBestRewardManifest prefers settled manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "reward-manifest-"));
    const base: RewardManifest = {
      epochId: 9,
      rewardRoot: `0x${"11".repeat(32)}`,
      totalReward: "10",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"22".repeat(32)}`,
      generatedAtMs: 1,
    };
    writeRewardManifest(dir, base);
    writeSettledRewardManifest(dir, {
      ...base,
      rewardRoot: `0x${"33".repeat(32)}`,
      settled: true,
      settledAtMs: 2,
    });

    const manifest = readBestRewardManifest(dir, 9);
    assert.equal(manifest?.rewardRoot, `0x${"33".repeat(32)}`);
    assert.equal(manifest?.settled, true);
  });

  it("persists challenger settlement audit fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "reward-manifest-"));
    const manifest: RewardManifest = {
      epochId: 10,
      rewardRoot: `0x${"44".repeat(32)}`,
      totalReward: "25",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [],
      proofs: {},
      scoringInputsHash: `0x${"55".repeat(32)}`,
      generatedAtMs: 1,
      challengerRewards: [{
        challengerAddress: "0xabc",
        nodeId: `0x${"66".repeat(32)}`,
        challengeCount: 2,
        validReceiptCount: 2,
      }],
      appliedChallengerRewards: [{
        challengerAddress: "0xabc",
        nodeId: `0x${"66".repeat(32)}`,
        challengeCount: 2,
        validReceiptCount: 2,
        amount: "5",
      }],
      skippedChallengerRewards: [{
        challengerAddress: "0xdef",
        challengeCount: 1,
        validReceiptCount: 0,
        reason: "missing_node_id",
      }],
    };

    writeSettledRewardManifest(dir, manifest);
    const loaded = readBestRewardManifest(dir, 10);

    assert.deepEqual(loaded?.challengerRewards, manifest.challengerRewards);
    assert.deepEqual(loaded?.appliedChallengerRewards, manifest.appliedChallengerRewards);
    assert.deepEqual(loaded?.skippedChallengerRewards, manifest.skippedChallengerRewards);
  });
});
