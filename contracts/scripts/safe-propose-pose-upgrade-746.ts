/**
 * Propose the PoSeManagerV2 #746 upgrade tx to the Gnosis Safe owning the
 * proxy. Reads the prepared impl from `tmp/upgrade-746-prepared.json`
 * (output of `upgrade-pose-manager-v2-746.js`) and submits a Safe Tx
 * Service proposal that, when executed by N-of-M multisig signers,
 * points the live proxy at the new implementation.
 *
 * USAGE
 *   COC_RPC_URL=https://<88780-rpc> \
 *   SAFE_TX_SERVICE_URL=https://<safe-tx-service-for-88780> \
 *   PROPOSER_PRIVATE_KEY=0x<proposer-eoa> \
 *   POSE_MULTISIG_ADDRESS=0x<safe-address> \
 *   npx ts-node scripts/safe-propose-pose-upgrade-746.ts
 *
 * Required env
 *   - COC_RPC_URL         JSON-RPC for 88780.
 *   - SAFE_TX_SERVICE_URL Safe Tx Service base URL. If your network is not
 *                         in Safe Global's hosted index, run your own
 *                         instance (https://github.com/safe-global/safe-tx-service).
 *   - POSE_MULTISIG_ADDRESS  The Safe holding ownership of the PoSeManagerV2
 *                            proxy (must match the proxy's `owner()`).
 *   - PROPOSER_PRIVATE_KEY EOA that signs the proposal (must be one of the
 *                          Safe owners). DOES NOT execute; signers approve
 *                          via Safe UI afterwards.
 *
 * Safety
 * ------
 * - Constructs an `upgradeToAndCall(newImpl, "")` call with empty init data.
 *   No re-initialization runs on the proxy; pre-upgrade storage is fully
 *   preserved (UUPS, OZ upgrade-safety validated already).
 * - Calls `proxy.owner()` and asserts it equals POSE_MULTISIG_ADDRESS — if
 *   the owner changed (e.g. ownership was transferred to GovernanceDAO),
 *   ABORT and re-coordinate.
 * - The proposal is created but NOT executed. Signers approve through the
 *   Safe UI; quorum is the Safe's own threshold (not this script's choice).
 *
 * After execution
 * ---------------
 * - Verify the upgrade via `eth_call` on `proxy.implementation()` (ERC-1967
 *   slot). The address should now match `prepared.newImpl`.
 * - Submit a sentinel `submitBatchV2WithMetadata` batch from a privileged
 *   aggregator with a tiny metadata payload to assert the new path works.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ethers } from "ethers"
import Safe from "@safe-global/protocol-kit"
import SafeApiKit from "@safe-global/api-kit"
import {
  type SafeTransactionDataPartial,
  type MetaTransactionData,
  OperationType,
} from "@safe-global/safe-core-sdk-types"

const PREPARED_PATH = join(__dirname, "..", "tmp", "upgrade-746-prepared.json")

const UUPS_ABI = [
  "function upgradeToAndCall(address newImplementation, bytes data) external payable",
  "function owner() external view returns (address)",
] as const

interface PreparedUpgrade {
  proxy: string
  newImpl: string
  contractName: string
  chainId: number
  preparedAt: string
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(`required env ${name} is not set`)
  }
  return v
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv("COC_RPC_URL")
  const safeTxServiceUrl = requireEnv("SAFE_TX_SERVICE_URL")
  const safeAddress = ethers.getAddress(requireEnv("POSE_MULTISIG_ADDRESS"))
  const proposerKey = requireEnv("PROPOSER_PRIVATE_KEY")

  const prepared = JSON.parse(readFileSync(PREPARED_PATH, "utf8")) as PreparedUpgrade
  if (prepared.chainId !== 88780) {
    throw new Error(`prepared upgrade chainId=${prepared.chainId}, expected 88780`)
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const network = await provider.getNetwork()
  if (Number(network.chainId) !== 88780) {
    throw new Error(`RPC chainId=${network.chainId}, expected 88780`)
  }

  // Owner sanity check before submitting anything.
  const proxy = new ethers.Contract(prepared.proxy, UUPS_ABI, provider)
  const liveOwner = ethers.getAddress(await proxy.owner())
  if (liveOwner !== safeAddress) {
    throw new Error(
      `proxy ${prepared.proxy} owner=${liveOwner} does not match POSE_MULTISIG_ADDRESS=${safeAddress}. ` +
      `Ownership may have been transferred — verify with the team before proceeding.`
    )
  }
  console.log(`✓ proxy ${prepared.proxy} owned by Safe ${safeAddress}`)

  // Encode the upgradeToAndCall calldata.
  const iface = new ethers.Interface(UUPS_ABI)
  const data = iface.encodeFunctionData("upgradeToAndCall", [prepared.newImpl, "0x"])
  console.log(`  upgradeToAndCall(${prepared.newImpl}, 0x) — ${data.length / 2 - 1} bytes calldata`)

  // Build Safe SDK transaction.
  const proposer = new ethers.Wallet(proposerKey, provider)
  const safeSdk = await Safe.init({
    provider: rpcUrl,
    signer: proposerKey,
    safeAddress,
  })

  const safeTransactionData: MetaTransactionData = {
    to: prepared.proxy,
    value: "0",
    data,
    operation: OperationType.Call,
  }
  const safeTransaction = await safeSdk.createTransaction({
    transactions: [safeTransactionData],
  })
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction)
  const senderSignature = await safeSdk.signHash(safeTxHash)

  // Push to Safe Tx Service for the other signers to approve.
  const apiKit = new SafeApiKit({
    chainId: BigInt(88780),
    txServiceUrl: safeTxServiceUrl,
  })
  await apiKit.proposeTransaction({
    safeAddress,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: proposer.address,
    senderSignature: senderSignature.data,
    origin: "PoSeManagerV2 #746 upgrade",
  })

  console.log("")
  console.log(`✓ Safe Tx proposed`)
  console.log(`  safeTxHash:  ${safeTxHash}`)
  console.log(`  txService:   ${safeTxServiceUrl}`)
  console.log(`  proposer:    ${proposer.address}`)
  console.log(`  to (proxy):  ${prepared.proxy}`)
  console.log(`  new impl:    ${prepared.newImpl}`)
  console.log("")
  console.log(`Other signers should approve via the Safe UI; once the threshold is met any owner can execute.`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
