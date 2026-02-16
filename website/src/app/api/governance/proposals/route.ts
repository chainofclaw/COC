import { NextRequest, NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { GOVERNANCE_DAO_ABI, getContractAddresses } from '@/lib/contracts'

export async function GET(request: NextRequest) {
  try {
    const { governanceDAO } = getContractAddresses()
    if (governanceDAO === '0x0000000000000000000000000000000000000000') {
      return NextResponse.json({ proposals: [], total: 0 })
    }

    const rpcUrl = process.env.COC_RPC_URL || 'http://127.0.0.1:18780'
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const contract = new ethers.Contract(governanceDAO, GOVERNANCE_DAO_ABI, provider)

    const count = Number(await contract.proposalCount())
    const { searchParams } = new URL(request.url)
    const stateFilter = searchParams.get('state')

    const proposals = []
    for (let i = count; i >= 1 && proposals.length < 50; i--) {
      try {
        const p = await contract.getProposal(i)
        const state = Number(p.state)

        if (stateFilter) {
          if (stateFilter === 'active' && state !== 0) continue
          if (stateFilter === 'passed' && state !== 1 && state !== 3 && state !== 4) continue
          if (stateFilter === 'rejected' && state !== 2) continue
          if (stateFilter === 'executed' && state !== 4) continue
        }

        proposals.push({
          id: Number(p.id),
          title: p.title,
          proposalType: Number(p.proposalType),
          proposer: p.proposer,
          state,
          forVotesHuman: Number(p.forVotesHuman),
          againstVotesHuman: Number(p.againstVotesHuman),
          forVotesClaw: Number(p.forVotesClaw),
          againstVotesClaw: Number(p.againstVotesClaw),
          abstainVotes: Number(p.abstainVotes),
          votingDeadline: Number(p.votingDeadline),
          createdAt: Number(p.createdAt),
        })
      } catch {
        // skip invalid proposals
      }
    }

    return NextResponse.json({ proposals, total: count })
  } catch (err: any) {
    return NextResponse.json({ proposals: [], total: 0, error: err.message })
  }
}
