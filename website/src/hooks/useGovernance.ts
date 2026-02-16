'use client'

import { useState, useCallback } from 'react'
import { ethers } from 'ethers'
import { GOVERNANCE_DAO_ABI, TREASURY_ABI, getContractAddresses, PROPOSAL_STATES } from '@/lib/contracts'

export interface ProposalData {
  id: number
  proposalType: number
  proposer: string
  title: string
  descriptionHash: string
  executionTarget: string
  executionData: string
  value: bigint
  createdAt: number
  votingDeadline: number
  executionDeadline: number
  forVotesHuman: number
  againstVotesHuman: number
  forVotesClaw: number
  againstVotesClaw: number
  abstainVotes: number
  state: number
}

export function useGovernance(signer: ethers.Signer | null) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const getGovernanceContract = useCallback(() => {
    if (!signer) return null
    const { governanceDAO } = getContractAddresses()
    if (governanceDAO === '0x0000000000000000000000000000000000000000') return null
    return new ethers.Contract(governanceDAO, GOVERNANCE_DAO_ABI, signer)
  }, [signer])

  const getTreasuryContract = useCallback(() => {
    if (!signer) return null
    const { treasury } = getContractAddresses()
    if (treasury === '0x0000000000000000000000000000000000000000') return null
    return new ethers.Contract(treasury, TREASURY_ABI, signer)
  }, [signer])

  const createProposal = useCallback(async (params: {
    proposalType: number
    title: string
    descriptionHash: string
    executionTarget?: string
    executionData?: string
    value?: bigint
  }) => {
    const contract = getGovernanceContract()
    if (!contract) throw new Error('Governance contract not available')

    setLoading(true)
    setError(null)
    try {
      const tx = await contract.createProposal(
        params.proposalType,
        params.title,
        params.descriptionHash,
        params.executionTarget || ethers.ZeroAddress,
        params.executionData || '0x',
        params.value || 0n,
      )
      const receipt = await tx.wait()
      setLoading(false)
      return receipt
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
      throw err
    }
  }, [getGovernanceContract])

  const vote = useCallback(async (proposalId: number, support: number) => {
    const contract = getGovernanceContract()
    if (!contract) throw new Error('Governance contract not available')

    setLoading(true)
    setError(null)
    try {
      const tx = await contract.vote(proposalId, support)
      await tx.wait()
      setLoading(false)
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
      throw err
    }
  }, [getGovernanceContract])

  const queueProposal = useCallback(async (proposalId: number) => {
    const contract = getGovernanceContract()
    if (!contract) throw new Error('Governance contract not available')
    const tx = await contract.queue(proposalId)
    await tx.wait()
  }, [getGovernanceContract])

  const executeProposal = useCallback(async (proposalId: number) => {
    const contract = getGovernanceContract()
    if (!contract) throw new Error('Governance contract not available')
    const tx = await contract.execute(proposalId)
    await tx.wait()
  }, [getGovernanceContract])

  const getProposal = useCallback(async (proposalId: number): Promise<ProposalData | null> => {
    const contract = getGovernanceContract()
    if (!contract) return null
    const p = await contract.getProposal(proposalId)
    return {
      id: Number(p.id),
      proposalType: Number(p.proposalType),
      proposer: p.proposer,
      title: p.title,
      descriptionHash: p.descriptionHash,
      executionTarget: p.executionTarget,
      executionData: p.executionData,
      value: p.value,
      createdAt: Number(p.createdAt),
      votingDeadline: Number(p.votingDeadline),
      executionDeadline: Number(p.executionDeadline),
      forVotesHuman: Number(p.forVotesHuman),
      againstVotesHuman: Number(p.againstVotesHuman),
      forVotesClaw: Number(p.forVotesClaw),
      againstVotesClaw: Number(p.againstVotesClaw),
      abstainVotes: Number(p.abstainVotes),
      state: Number(p.state),
    }
  }, [getGovernanceContract])

  const getTreasuryBalance = useCallback(async (): Promise<bigint | null> => {
    const contract = getTreasuryContract()
    if (!contract) return null
    return contract.balance()
  }, [getTreasuryContract])

  const getProposalStateLabel = (stateNum: number): string => {
    return PROPOSAL_STATES[stateNum] || 'Unknown'
  }

  return {
    loading,
    error,
    createProposal,
    vote,
    queueProposal,
    executeProposal,
    getProposal,
    getTreasuryBalance,
    getProposalStateLabel,
  }
}
