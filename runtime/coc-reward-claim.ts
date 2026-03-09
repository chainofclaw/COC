import { join } from "node:path";
import { Contract, JsonRpcProvider, Wallet, keccak256 } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { lookupRewardClaim, readBestRewardManifest, verifyManifestSignature } from "./lib/reward-manifest.ts";
import { buildDomain } from "../node/src/crypto/eip712-types.ts";
import { resolvePrivateKey } from "./lib/key-material.ts";

function parseArgs(argv: string[]): { epochId: number | null; nodeId?: string } {
  let epochId: number | null = null;
  let nodeId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--epoch" && i + 1 < argv.length) {
      epochId = Number(argv[++i]);
    } else if (arg === "--node-id" && i + 1 < argv.length) {
      nodeId = argv[++i].toLowerCase();
    }
  }

  return { epochId, nodeId };
}

const { epochId, nodeId: argNodeId } = parseArgs(process.argv.slice(2));
const config = await loadConfig();
const privateKey = resolvePrivateKey({
  envValue: process.env.COC_OPERATOR_PK,
  envFilePath: process.env.COC_OPERATOR_PK_FILE,
  configValue: config.operatorPrivateKey,
  configFilePath: config.operatorPrivateKeyFile,
  label: "operator",
});
const protocolVersion = config.protocolVersion ?? 1;
const rpcUrl = protocolVersion === 2
  ? (config.l2RpcUrl ?? config.l1RpcUrl ?? "http://127.0.0.1:8545")
  : (config.l1RpcUrl ?? "http://127.0.0.1:8545");
const provider = new JsonRpcProvider(rpcUrl);
const signer = new Wallet(privateKey, provider);
const defaultNodeId = keccak256(signer.signingKey.publicKey).toLowerCase();
const nodeId = argNodeId ?? defaultNodeId;

if (protocolVersion === 2 || config.poseManagerV2Address) {
  if (epochId === null || !Number.isInteger(epochId) || epochId < 0) {
    throw new Error("v2 reward claim requires --epoch <epochId>");
  }
  if (!config.poseManagerV2Address) {
    throw new Error("poseManagerV2Address not configured");
  }

  const rewardManifestDir = config.rewardManifestDir ?? join(config.dataDir, "reward-manifests");
  const manifest = readBestRewardManifest(rewardManifestDir, epochId);
  if (!manifest) {
    throw new Error(`reward manifest not found for epoch ${epochId}`);
  }

  // Signature verification (warn-only for backward compatibility)
  const v2ChainId = config.chainId ?? 20241224;
  const v2VerifyingContract = config.verifyingContract ?? config.poseManagerV2Address ?? "0x0000000000000000000000000000000000000000";
  const claimDomain = buildDomain(BigInt(v2ChainId), v2VerifyingContract);
  if (manifest.generatorSignature) {
    const sigResult = verifyManifestSignature(manifest, claimDomain);
    if (sigResult.valid) {
      console.log(`manifest signature valid (signer: ${sigResult.recoveredAddress})`);
    } else {
      console.warn(`WARNING: manifest signature invalid: ${sigResult.error}`);
    }
  } else {
    console.warn("WARNING: manifest has no generator signature");
  }

  const claim = lookupRewardClaim(manifest, nodeId);
  if (!claim) {
    throw new Error(`reward claim not found for nodeId ${nodeId} in epoch ${epochId}`);
  }

  const contract = new Contract(
    config.poseManagerV2Address,
    ["function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] merkleProof)"],
    signer,
  );
  const tx = await contract.claim(BigInt(claim.epochId), claim.nodeId, BigInt(claim.amount), claim.proof);
  const receipt = await tx.wait();
  console.log(JSON.stringify({
    protocolVersion: 2,
    epochId: claim.epochId,
    nodeId: claim.nodeId,
    amount: claim.amount,
    rewardRoot: claim.rewardRoot,
    txHash: tx.hash,
    status: receipt?.status ?? null,
  }, null, 2));
} else {
  if (!config.poseManagerAddress) {
    throw new Error("poseManagerAddress not configured");
  }
  const contract = new Contract(
    config.poseManagerAddress,
    ["function claimReward(bytes32 nodeId)"],
    signer,
  );
  const tx = await contract.claimReward(nodeId);
  const receipt = await tx.wait();
  console.log(JSON.stringify({
    protocolVersion: 1,
    nodeId,
    txHash: tx.hash,
    status: receipt?.status ?? null,
  }, null, 2));
}
