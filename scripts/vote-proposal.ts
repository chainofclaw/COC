/**
 * Vote on Governance Proposal Script
 *
 * Submits a vote on a governance proposal via RPC.
 *
 * Usage:
 *   node --experimental-strip-types scripts/vote-proposal.ts [options]
 *
 * Options:
 *   --rpc <url>           RPC endpoint (default: http://127.0.0.1:18780)
 *   --proposal-id <id>    Proposal ID to vote on
 *   --voter <id>          Voter validator ID
 *   --approve             Vote to approve (default)
 *   --reject              Vote to reject
 *
 * Examples:
 *   # Approve a proposal
 *   node --experimental-strip-types scripts/vote-proposal.ts \
 *     --proposal-id prop-1 --voter validator-1 --approve
 *
 *   # Reject a proposal
 *   node --experimental-strip-types scripts/vote-proposal.ts \
 *     --proposal-id prop-1 --voter validator-2 --reject
 */

const DEFAULT_RPC = "http://127.0.0.1:18780"

interface VoteConfig {
  rpcUrl: string
  proposalId: string
  voterId: string
  approve: boolean
}

function parseArgs(): VoteConfig {
  const args = process.argv.slice(2)
  const config: VoteConfig = {
    rpcUrl: DEFAULT_RPC,
    proposalId: "",
    voterId: "",
    approve: true,
  }

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === "--rpc") { config.rpcUrl = args[++i]; continue }
    if (flag === "--proposal-id") { config.proposalId = args[++i]; continue }
    if (flag === "--voter") { config.voterId = args[++i]; continue }
    if (flag === "--approve") { config.approve = true; continue }
    if (flag === "--reject") { config.approve = false; continue }
  }

  return config
}

function validateConfig(config: VoteConfig): string | null {
  if (!config.proposalId) return "Missing --proposal-id"
  if (!config.voterId) return "Missing --voter"
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

  console.log(`Voting on proposal ${config.proposalId}...`)
  console.log(`  Voter: ${config.voterId}`)
  console.log(`  Vote: ${config.approve ? "APPROVE" : "REJECT"}`)

  const result = (await rpcCall(config.rpcUrl, "coc_voteProposal", [{
    proposalId: config.proposalId,
    voterId: config.voterId,
    approve: config.approve,
  }])) as {
    id: string
    status: string
    votes: Record<string, boolean>
  }

  console.log(`\nVote recorded!`)
  console.log(`  Proposal: ${result.id}`)
  console.log(`  Status: ${result.status}`)
  console.log(`  Votes: ${Object.keys(result.votes).length}`)
  for (const [voter, approved] of Object.entries(result.votes)) {
    console.log(`    ${voter}: ${approved ? "approve" : "reject"}`)
  }
}

// Only run when executed directly
const isMain = process.argv[1]?.endsWith("vote-proposal.ts")
if (isMain) {
  main().catch((err) => {
    console.error("Vote failed:", err)
    process.exit(1)
  })
}

export { parseArgs, validateConfig, type VoteConfig }
