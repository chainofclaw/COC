import { NextResponse } from 'next/server'
import { getForumStats } from '@/lib/forum-queries'
import { ethers } from 'ethers'
import { GOVERNANCE_DAO_ABI, TREASURY_ABI, FACTION_REGISTRY_ABI, getContractAddresses } from '@/lib/contracts'

export async function GET() {
  try {
    // Forum stats from SQLite
    const forumStats = getForumStats()

    // Chain stats from RPC
    const { governanceDAO, treasury, factionRegistry } = getContractAddresses()
    const rpcUrl = process.env.COC_RPC_URL || 'http://127.0.0.1:18780'

    let totalProposals = 0
    let activeProposals = 0
    let passedProposals = 0
    let treasuryBalance = '0 ETH'
    let humanCount = forumStats.human_count
    let clawCount = forumStats.claw_count

    // Try to fetch on-chain stats
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl)

      if (governanceDAO !== '0x0000000000000000000000000000000000000000') {
        const gov = new ethers.Contract(governanceDAO, GOVERNANCE_DAO_ABI, provider)
        totalProposals = Number(await gov.proposalCount())

        // Count active and passed proposals (check last 50)
        for (let i = totalProposals; i >= 1 && i > totalProposals - 50; i--) {
          try {
            const p = await gov.getProposal(i)
            const state = Number(p.state)
            if (state === 0) activeProposals++
            if (state === 1 || state === 4) passedProposals++
          } catch {
            break
          }
        }
      }

      if (treasury !== '0x0000000000000000000000000000000000000000') {
        const tres = new ethers.Contract(treasury, TREASURY_ABI, provider)
        const bal = await tres.balance()
        treasuryBalance = `${ethers.formatEther(bal)} ETH`
      }

      if (factionRegistry !== '0x0000000000000000000000000000000000000000') {
        const reg = new ethers.Contract(factionRegistry, FACTION_REGISTRY_ABI, provider)
        humanCount = Number(await reg.humanCount())
        clawCount = Number(await reg.clawCount())
      }
    } catch {
      // RPC unavailable, use forum stats only
    }

    return NextResponse.json({
      totalProposals,
      activeProposals,
      passedProposals,
      treasuryBalance,
      humanCount,
      clawCount,
      forumPosts: forumStats.total_posts,
      forumReplies: forumStats.total_replies,
    })
  } catch (err: any) {
    return NextResponse.json({
      totalProposals: 0,
      activeProposals: 0,
      passedProposals: 0,
      treasuryBalance: '0 ETH',
      humanCount: 0,
      clawCount: 0,
    })
  }
}
