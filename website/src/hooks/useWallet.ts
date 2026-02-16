'use client'

import { useState, useCallback, useEffect } from 'react'
import { ethers } from 'ethers'

export type WalletType = 'metamask' | 'openclaw' | null
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

interface WalletState {
  address: string | null
  walletType: WalletType
  connectionState: ConnectionState
  error: string | null
  provider: ethers.BrowserProvider | null
  signer: ethers.Signer | null
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    walletType: null,
    connectionState: 'disconnected',
    error: null,
    provider: null,
    signer: null,
  })

  const connectMetaMask = useCallback(async () => {
    setState(prev => ({ ...prev, connectionState: 'connecting', error: null }))
    try {
      const ethereum = (window as any).ethereum
      if (!ethereum) {
        throw new Error('MetaMask not detected. Please install MetaMask.')
      }
      const provider = new ethers.BrowserProvider(ethereum)
      const accounts = await provider.send('eth_requestAccounts', [])
      const signer = await provider.getSigner()
      setState({
        address: accounts[0],
        walletType: 'metamask',
        connectionState: 'connected',
        error: null,
        provider,
        signer,
      })
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        connectionState: 'error',
        error: err.message || 'Failed to connect MetaMask',
      }))
    }
  }, [])

  const connectOpenClaw = useCallback(async () => {
    setState(prev => ({ ...prev, connectionState: 'connecting', error: null }))
    try {
      const openclaw = (window as any).openclaw
      if (!openclaw) {
        throw new Error('OpenClaw wallet not detected. Please install OpenClaw.')
      }
      const provider = new ethers.BrowserProvider(openclaw)
      const accounts = await provider.send('eth_requestAccounts', [])
      const signer = await provider.getSigner()
      setState({
        address: accounts[0],
        walletType: 'openclaw',
        connectionState: 'connected',
        error: null,
        provider,
        signer,
      })
    } catch (err: any) {
      setState(prev => ({
        ...prev,
        connectionState: 'error',
        error: err.message || 'Failed to connect OpenClaw wallet',
      }))
    }
  }, [])

  const disconnect = useCallback(() => {
    setState({
      address: null,
      walletType: null,
      connectionState: 'disconnected',
      error: null,
      provider: null,
      signer: null,
    })
  }, [])

  const signMessage = useCallback(async (message: string): Promise<string> => {
    if (!state.signer) throw new Error('No signer connected')
    return state.signer.signMessage(message)
  }, [state.signer])

  // Listen for account changes
  useEffect(() => {
    const ethereum = (window as any).ethereum
    if (!ethereum) return

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect()
      } else if (state.address && accounts[0] !== state.address) {
        setState(prev => ({ ...prev, address: accounts[0] }))
      }
    }

    ethereum.on?.('accountsChanged', handleAccountsChanged)
    return () => {
      ethereum.removeListener?.('accountsChanged', handleAccountsChanged)
    }
  }, [state.address, disconnect])

  return {
    ...state,
    connectMetaMask,
    connectOpenClaw,
    disconnect,
    signMessage,
    isConnected: state.connectionState === 'connected',
    faction: state.walletType === 'metamask' ? 'Human' : state.walletType === 'openclaw' ? 'Claw' : null,
  }
}
