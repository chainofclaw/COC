"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { BrowserProvider, formatEther } from "ethers";
import { COC_CHAIN_ID } from "@/lib/types";

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export interface UseWalletReturn {
  address: string | null;
  balance: string;
  chainId: number | null;
  connected: boolean;
  wrongChain: boolean;
  hasMetaMask: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  signMessage(msg: string): Promise<string>;
  switchChain(): Promise<void>;
}

const COC_CHAIN_HEX = "0x" + COC_CHAIN_ID.toString(16);

export function useWallet(): UseWalletReturn {
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState("0");
  const [chainId, setChainId] = useState<number | null>(null);
  const [hasMetaMask, setHasMetaMask] = useState(false);
  const providerRef = useRef<BrowserProvider | null>(null);

  const connected = address !== null;
  const wrongChain = connected && chainId !== null && chainId !== COC_CHAIN_ID;

  const fetchBalance = useCallback(async (addr: string) => {
    if (!providerRef.current) return;
    try {
      const bal = await providerRef.current.getBalance(addr);
      setBalance(formatEther(bal));
    } catch {
      setBalance("0");
    }
  }, []);

  const fetchChainId = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      const id = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;
      setChainId(parseInt(id, 16));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const eth = typeof window !== "undefined" ? window.ethereum : undefined;
    setHasMetaMask(!!eth);
    if (!eth) return;

    providerRef.current = new BrowserProvider(eth);
    fetchChainId();

    const handleAccountsChanged = (accounts: unknown) => {
      const accts = accounts as string[];
      if (accts.length === 0) {
        setAddress(null);
        setBalance("0");
      } else {
        const addr = accts[0]!;
        setAddress(addr);
        fetchBalance(addr);
      }
    };

    const handleChainChanged = (_chainId: unknown) => {
      const id = parseInt(_chainId as string, 16);
      setChainId(id);
      providerRef.current = new BrowserProvider(eth);
      if (address) fetchBalance(address);
    };

    eth.on("accountsChanged", handleAccountsChanged);
    eth.on("chainChanged", handleChainChanged);

    return () => {
      eth.removeListener("accountsChanged", handleAccountsChanged);
      eth.removeListener("chainChanged", handleChainChanged);
    };
  }, [address, fetchBalance, fetchChainId]);

  const connect = useCallback(async () => {
    if (!window.ethereum) throw new Error("MetaMask not installed");
    providerRef.current = new BrowserProvider(window.ethereum);
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    const addr = accounts[0];
    if (!addr) throw new Error("No account returned");
    setAddress(addr);
    await fetchChainId();
    await fetchBalance(addr);
  }, [fetchBalance, fetchChainId]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setBalance("0");
    setChainId(null);
  }, []);

  const signMessage = useCallback(async (msg: string): Promise<string> => {
    if (!providerRef.current) throw new Error("Not connected");
    const signer = await providerRef.current.getSigner();
    return signer.signMessage(msg);
  }, []);

  const switchChain = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: COC_CHAIN_HEX }],
      });
    } catch (err: unknown) {
      const error = err as { code?: number };
      if (error.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: COC_CHAIN_HEX,
              chainName: "COC Chain",
              rpcUrls: ["http://127.0.0.1:18780"],
              nativeCurrency: { name: "COC", symbol: "COC", decimals: 18 },
            },
          ],
        });
      }
    }
  }, []);

  return {
    address,
    balance,
    chainId,
    connected,
    wrongChain,
    hasMetaMask,
    connect,
    disconnect,
    signMessage,
    switchChain,
  };
}
