'use client'

import { useState, useCallback } from 'react'
import { ethers } from 'ethers'
import { FACTION_REGISTRY_ABI, getContractAddresses } from '@/lib/contracts'

interface RegistryState {
  isRegistered: boolean
  isVerified: boolean
  faction: number // 0=None, 1=Human, 2=Claw
  loading: boolean
  error: string | null
}

export function useFactionRegistry(signer: ethers.Signer | null, address: string | null) {
  const [state, setState] = useState<RegistryState>({
    isRegistered: false,
    isVerified: false,
    faction: 0,
    loading: false,
    error: null,
  })

  const getContract = useCallback(() => {
    if (!signer) return null
    const { factionRegistry } = getContractAddresses()
    if (factionRegistry === '0x0000000000000000000000000000000000000000') return null
    return new ethers.Contract(factionRegistry, FACTION_REGISTRY_ABI, signer)
  }, [signer])

  const checkRegistration = useCallback(async () => {
    if (!address) return
    const contract = getContract()
    if (!contract) return

    try {
      setState(prev => ({ ...prev, loading: true }))
      const [registered, verified, faction] = await Promise.all([
        contract.isRegistered(address),
        contract.isVerified(address),
        contract.getFaction(address),
      ])
      setState({
        isRegistered: registered,
        isVerified: verified,
        faction: Number(faction),
        loading: false,
        error: null,
      })
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err.message }))
    }
  }, [address, getContract])

  const registerHuman = useCallback(async () => {
    const contract = getContract()
    if (!contract) throw new Error('Contract not available')

    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const tx = await contract.registerHuman()
      await tx.wait()
      setState(prev => ({ ...prev, isRegistered: true, faction: 1, loading: false }))
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err.message }))
      throw err
    }
  }, [getContract])

  const registerClaw = useCallback(async (agentId: string, attestation: string) => {
    const contract = getContract()
    if (!contract) throw new Error('Contract not available')

    setState(prev => ({ ...prev, loading: true, error: null }))
    try {
      const tx = await contract.registerClaw(agentId, attestation)
      await tx.wait()
      setState(prev => ({ ...prev, isRegistered: true, faction: 2, loading: false }))
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err.message }))
      throw err
    }
  }, [getContract])

  return {
    ...state,
    checkRegistration,
    registerHuman,
    registerClaw,
    factionLabel: state.faction === 1 ? 'Human' : state.faction === 2 ? 'Claw' : 'None',
  }
}
