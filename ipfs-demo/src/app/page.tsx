"use client";

import { useState, useCallback } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { WalletConnect } from "@/components/WalletConnect";
import { FileUpload } from "@/components/FileUpload";
import { FileList } from "@/components/FileList";
import { FilePreview } from "@/components/FilePreview";
import { CidLookup } from "@/components/CidLookup";
import type { MfsEntry } from "@/lib/types";

export default function HomePage() {
  const wallet = useWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    entry: MfsEntry;
    path: string;
  } | null>(null);

  const userDir = wallet.address
    ? `/users/${wallet.address.toLowerCase()}`
    : null;
  const activePath = currentPath ?? userDir;

  const handleUploadComplete = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  const handlePreview = useCallback((entry: MfsEntry, path: string) => {
    setPreview({ entry, path });
  }, []);

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-4 py-6">
      {/* Navigation bar */}
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold">
            COC
          </div>
          <h1 className="text-xl font-bold">IPFS File Manager</h1>
        </div>
        <WalletConnect wallet={wallet} />
      </header>

      {/* Wrong chain warning */}
      {wallet.wrongChain && (
        <div className="mb-6 rounded-lg border border-yellow-700 bg-yellow-950/50 px-4 py-3 text-sm text-yellow-400">
          Wrong network detected. Please{" "}
          <button
            onClick={wallet.switchChain}
            className="font-medium underline hover:text-yellow-300"
          >
            switch to COC Chain
          </button>{" "}
          to upload files.
        </div>
      )}

      {/* Not connected state */}
      {!wallet.connected && (
        <div className="mb-8 rounded-xl border border-gray-800 bg-gray-900 px-6 py-12 text-center">
          <h2 className="mb-2 text-xl font-semibold text-gray-200">
            Welcome to COC IPFS
          </h2>
          <p className="mb-6 text-gray-400">
            Connect your MetaMask wallet to upload and manage files on the
            decentralized storage network.
          </p>
          {wallet.hasMetaMask ? (
            <button
              onClick={wallet.connect}
              className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white hover:bg-blue-500"
            >
              Connect MetaMask
            </button>
          ) : (
            <a
              href="https://metamask.io/download/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg bg-orange-600 px-6 py-3 font-medium text-white hover:bg-orange-500"
            >
              Install MetaMask
            </a>
          )}
        </div>
      )}

      {/* Connected state - file management */}
      {wallet.connected && activePath && (
        <div className="mb-6 space-y-6">
          <FileUpload
            wallet={wallet}
            currentPath={activePath}
            onUploadComplete={handleUploadComplete}
          />
          <FileList
            currentPath={activePath}
            onNavigate={handleNavigate}
            onPreview={handlePreview}
            refreshKey={refreshKey}
          />
        </div>
      )}

      {/* CID Lookup - always available */}
      <CidLookup />

      {/* Preview modal */}
      {preview && (
        <FilePreview
          entry={preview.entry}
          dirPath={preview.path}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
