"use client";

import { useState, useCallback, useRef } from "react";
import type { UseWalletReturn } from "@/hooks/use-wallet";
import { ipfs, sanitizeFilename } from "@/lib/ipfs-client";
import { MAX_FILE_SIZE } from "@/lib/types";

interface Props {
  wallet: UseWalletReturn;
  currentPath: string;
  onUploadComplete: () => void;
}

type UploadState = "idle" | "uploading" | "signing" | "done" | "error";

export function FileUpload({ wallet, currentPath, onUploadComplete }: Props) {
  const [state, setState] = useState<UploadState>("idle");
  const [dragOver, setDragOver] = useState(false);
  const [message, setMessage] = useState("");
  const [lastCid, setLastCid] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const disabled = !wallet.connected || wallet.wrongChain;

  const uploadFile = useCallback(
    async (file: File) => {
      if (disabled) return;

      if (file.size > MAX_FILE_SIZE) {
        setState("error");
        setMessage(`File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
        return;
      }

      const safeName = sanitizeFilename(file.name);
      const filePath = `${currentPath}/${safeName}`;

      try {
        // Check if file already exists
        try {
          await ipfs.stat(filePath);
          const confirmed = window.confirm(
            `"${safeName}" already exists. Overwrite?`,
          );
          if (!confirmed) return;
        } catch {
          // File doesn't exist, proceed
        }

        setState("uploading");
        setMessage(`Uploading ${safeName}...`);

        // Ensure user directory exists
        await ipfs.mkdir(currentPath, true);

        // Write file to MFS
        const bytes = new Uint8Array(await file.arrayBuffer());
        await ipfs.write(filePath, bytes);

        // Get CID from stat
        const stat = await ipfs.stat(filePath);
        const cid = stat.hash;

        // Sign with MetaMask
        setState("signing");
        setMessage("Waiting for signature...");
        const timestamp = Date.now();
        const signMsg = `ipfs-upload:${cid}:${safeName}:${timestamp}`;
        await wallet.signMessage(signMsg);

        setLastCid(cid);
        setState("done");
        setMessage(`Uploaded! CID: ${cid}`);
        onUploadComplete();
      } catch (err) {
        setState("error");
        setMessage(err instanceof Error ? err.message : "Upload failed");
      }
    },
    [disabled, currentPath, wallet, onUploadComplete],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
      e.target.value = "";
    },
    [uploadFile],
  );

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <h2 className="mb-4 text-lg font-semibold">Upload File</h2>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
          disabled
            ? "cursor-not-allowed border-gray-700 text-gray-600"
            : dragOver
              ? "border-blue-400 bg-blue-950/30 text-blue-300"
              : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300"
        }`}
      >
        <svg
          className="mb-2 h-8 w-8"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        {disabled ? (
          <span>Connect wallet to upload</span>
        ) : (
          <span>
            Drop file here or <span className="text-blue-400">browse</span>
          </span>
        )}
        <span className="mt-1 text-xs text-gray-500">Max 10MB</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        className="hidden"
      />

      {state !== "idle" && (
        <div className="mt-3">
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              state === "error"
                ? "bg-red-950/50 text-red-400"
                : state === "done"
                  ? "bg-green-950/50 text-green-400"
                  : "bg-blue-950/50 text-blue-400"
            }`}
          >
            {(state === "uploading" || state === "signing") && (
              <span className="mr-2 inline-block animate-spin">&#9696;</span>
            )}
            {message}
          </div>
          {lastCid && state === "done" && (
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-gray-800 px-2 py-1 text-xs text-gray-300">
                {lastCid}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(lastCid)}
                className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
              >
                Copy
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
