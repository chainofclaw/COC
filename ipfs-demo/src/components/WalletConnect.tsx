"use client";

import type { UseWalletReturn } from "@/hooks/use-wallet";

interface Props {
  wallet: UseWalletReturn;
}

export function WalletConnect({ wallet }: Props) {
  if (!wallet.hasMetaMask) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500"
      >
        Install MetaMask
      </a>
    );
  }

  if (!wallet.connected) {
    return (
      <button
        onClick={wallet.connect}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
      >
        Connect Wallet
      </button>
    );
  }

  const shortAddr = `${wallet.address!.slice(0, 6)}...${wallet.address!.slice(-4)}`;
  const balDisplay =
    parseFloat(wallet.balance).toFixed(4).replace(/\.?0+$/, "") + " COC";

  return (
    <div className="flex items-center gap-3">
      {wallet.wrongChain && (
        <button
          onClick={wallet.switchChain}
          className="rounded-lg bg-yellow-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-500"
        >
          Switch to COC
        </button>
      )}
      <div className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm">
        <span className="text-gray-400">{balDisplay}</span>
        <span className="mx-2 text-gray-600">|</span>
        <span className="font-mono text-gray-200">{shortAddr}</span>
      </div>
      <button
        onClick={wallet.disconnect}
        className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
      >
        Disconnect
      </button>
    </div>
  );
}
