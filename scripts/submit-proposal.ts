/**
 * Submit Governance Proposal Script
 *
 * Submits a governance proposal to a running COC node via RPC.
 *
 * Usage:
 *   node --experimental-strip-types scripts/submit-proposal.ts [options]
 *
 * Options:
 *   --rpc <url>           RPC endpoint (default: http://127.0.0.1:18780)
 *   --type <type>         Proposal type: add_validator | remove_validator | update_stake
 *   --target-id <id>      Target validator ID
 *   --proposer <id>       Proposer validator ID
 *   --target-address <a>  Target address (for add_validator)
 *   --stake-amount <wei>  Stake amount in wei (for add/update_stake)
 *
 * Examples:
 *   # Add a new validator
 *   node --experimental-strip-types scripts/submit-proposal.ts \
 *     --type add_validator --target-id validator-4 --proposer validator-1 \
 *     --target-address 0x1234...abcd --stake-amount 1000000000000000000
 *
 *   # Update stake for existing validator
 *   node --experimental-strip-types scripts/submit-proposal.ts \
 *     --type update_stake --target-id validator-2 --proposer validator-1 \
 *     --stake-amount 5000000000000000000
 *
 *   # Remove a validator
 *   node --experimental-strip-types scripts/submit-proposal.ts \
 *     --type remove_validator --target-id validator-3 --proposer validator-1
 */

const DEFAULT_RPC = "http://127.0.0.1:18780"
const VALID_TYPES = ["add_validator", "remove_validator", "update_stake"] as const

interface ProposalConfig {
  rpcUrl: string
  type: string
  targetId: string
  proposer: string
  targetAddress?: string
  stakeAmount?: string
}

function parseArgs(): ProposalConfig {
  const args = process.argv.slice(2)
  const config: ProposalConfig = {
    rpcUrl: DEFAULT_RPC,
    type: "",
    targetId: "",
    proposer: "",
  }

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const val = args[i + 1]
    if (flag === "--rpc") config.rpcUrl = val
    else if (flag === "--type") config.type = val
    else if (flag === "--target-id") config.targetId = val
    else if (flag === "--proposer") config.proposer = val
    else if (flag === "--target-address") config.targetAddress = val
    else if (flag === "--stake-amount") config.stakeAmount = val
  }

  return config
}

function validateConfig(config: ProposalConfig): string | null {
  if (!config.type) return "Missing --type"
  if (!VALID_TYPES.includes(config.type as typeof VALID_TYPES[number])) {
    return `Invalid type: ${config.type}. Must be one of: ${VALID_TYPES.join(", ")}`
  }
  if (!config.targetId) return "Missing --target-id"
  if (!config.proposer) return "Missing --proposer"
  if (config.type === "add_validator" && !config.targetAddress) {
    return "add_validator requires --target-address"
  }
  if (config.type === "add_validator" && !config.stakeAmount) {
    return "add_validator requires --stake-amount"
  }
  if (config.targetAddress && !/^0x[0-9a-fA-F]{40}$/.test(config.targetAddress)) {
    return "Invalid --target-address format (must be 0x + 40 hex chars)"
  }
  return null
}

async function rpcCall(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  })
  const json = (await resp.json()) as { result?: unknown; error?: { code: number; message: string } }
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`)
  return json.result
}

async function main(): Promise<void> {
  const config = parseArgs()
  const error = validateConfig(config)
  if (error) {
    console.error(`Error: ${error}`)
    process.exit(1)
  }

  // Verify connectivity
  try {
    await rpcCall(config.rpcUrl, "eth_blockNumber")
  } catch (err) {
    console.error(`Cannot connect to ${config.rpcUrl}: ${err}`)
    process.exit(1)
  }

  // Check governance is enabled
  const stats = (await rpcCall(config.rpcUrl, "coc_getDaoStats")) as { enabled: boolean }
  if (!stats?.enabled) {
    console.error("Governance is not enabled on this network")
    process.exit(1)
  }

  // Build proposal params
  const proposalParams: Record<string, string> = {
    type: config.type,
    targetId: config.targetId,
    proposer: config.proposer,
  }
  if (config.targetAddress) proposalParams.targetAddress = config.targetAddress
  if (config.stakeAmount) proposalParams.stakeAmount = config.stakeAmount

  console.log("Submitting proposal...")
  console.log(`  Type: ${config.type}`)
  console.log(`  Target: ${config.targetId}`)
  console.log(`  Proposer: ${config.proposer}`)
  if (config.targetAddress) console.log(`  Address: ${config.targetAddress}`)
  if (config.stakeAmount) console.log(`  Stake: ${config.stakeAmount} wei`)

  const result = (await rpcCall(config.rpcUrl, "coc_submitProposal", [proposalParams])) as {
    id: string
    type: string
    status: string
  }

  console.log(`\nProposal submitted successfully!`)
  console.log(`  ID: ${result.id}`)
  console.log(`  Status: ${result.status}`)

  // Fetch current proposals to show context
  const proposals = (await rpcCall(config.rpcUrl, "coc_getDaoProposals", ["pending"])) as Array<{
    id: string
    type: string
    status: string
    voteCount: number
  }>
  console.log(`\nPending proposals: ${proposals.length}`)
  for (const p of proposals) {
    console.log(`  [${p.id}] ${p.type} - ${p.voteCount} votes (${p.status})`)
  }
}

// Only run when executed directly
const isMain = process.argv[1]?.endsWith("submit-proposal.ts")
if (isMain) {
  main().catch((err) => {
    console.error("Proposal submission failed:", err)
    process.exit(1)
  })
}

export { parseArgs, validateConfig, type ProposalConfig }
