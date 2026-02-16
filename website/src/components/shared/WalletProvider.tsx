'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useWallet, type WalletType, type ConnectionState } from '@/hooks/useWallet'
import type { ethers } from 'ethers'

interface WalletContextValue {
  address: string | null
  walletType: WalletType
  connectionState: ConnectionState
  error: string | null
  provider: ethers.BrowserProvider | null
  signer: ethers.Signer | null
  isConnected: boolean
  faction: string | null
  connectMetaMask: () => Promise<void>
  connectOpenClaw: () => Promise<void>
  disconnect: () => void
  signMessage: (message: string) => Promise<string>
}

const WalletContext = createContext<WalletContextValue | null>(null)

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet()
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWalletContext must be used within WalletProvider')
  return ctx
}
