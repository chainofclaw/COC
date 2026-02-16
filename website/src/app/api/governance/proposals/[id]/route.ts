import { NextRequest, NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { GOVERNANCE_DAO_ABI, getContractAddresses } from '@/lib/contracts'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const proposalId = parseInt(id, 10)

  if (isNaN(proposalId) || proposalId < 1) {
    return NextResponse.json({ error: 'Invalid proposal ID' }, { status: 400 })
  }

  try {
    const { governanceDAO } = getContractAddresses()
    if (governanceDAO === '0x0000000000000000000000000000000000000000') {
      return NextResponse.json({ error: 'Governance contract not deployed' }, { status: 404 })
    }

    const rpcUrl = process.env.COC_RPC_URL || 'http://127.0.0.1:18780'
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const contract = new ethers.Contract(governanceDAO, GOVERNANCE_DAO_ABI, provider)

    const p = await contract.getProposal(proposalId)

    return NextResponse.json({
      proposal: {
        id: Number(p.id),
        proposalType: Number(p.proposalType),
        proposer: p.proposer,
        title: p.title,
        descriptionHash: p.descriptionHash,
        executionTarget: p.executionTarget,
        executionData: p.executionData,
        value: p.value.toString(),
        createdAt: Number(p.createdAt),
        votingDeadline: Number(p.votingDeadline),
        executionDeadline: Number(p.executionDeadline),
        forVotesHuman: Number(p.forVotesHuman),
        againstVotesHuman: Number(p.againstVotesHuman),
        forVotesClaw: Number(p.forVotesClaw),
        againstVotesClaw: Number(p.againstVotesClaw),
        abstainVotes: Number(p.abstainVotes),
        state: Number(p.state),
      },
    })
  } catch {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })
  }
}
