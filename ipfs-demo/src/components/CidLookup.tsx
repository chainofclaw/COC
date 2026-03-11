"use client";

import { useState, useCallback } from "react";
import { ipfs } from "@/lib/ipfs-client";

export function CidLookup() {
  const [cid, setCid] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  const handleSearch = useCallback(async () => {
    const trimmed = cid.trim();
    if (!trimmed) return;

    setLoading(true);
    setError("");
    setPreviewUrl(null);
    setPreviewText(null);

    try {
      const data = await ipfs.catByCid(trimmed);

      // Try to detect if it's text
      const isLikelyText =
        data.length < 100000 && data.every((b) => b < 128 || b > 191);

      if (isLikelyText && data.length < 50000) {
        const text = new TextDecoder().decode(data);
        if (/^[\x20-\x7E\t\n\r]*$/.test(text.slice(0, 1000))) {
          setPreviewText(text);
          return;
        }
      }

      // Provide download link via gateway
      setPreviewUrl(ipfs.gatewayUrl(trimmed));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Content not found for this CID",
      );
    } finally {
      setLoading(false);
    }
  }, [cid]);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <h2 className="mb-4 text-lg font-semibold">CID Lookup</h2>
      <div className="flex gap-2">
        <input
          value={cid}
          onChange={(e) => setCid(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Enter CID (e.g. Qm...)"
          className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={handleSearch}
          disabled={loading || !cid.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "..." : "Search"}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-400">{error}</p>
      )}

      {previewText !== null && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-gray-500">Text content</span>
            <a
              href={ipfs.gatewayUrl(cid.trim())}
              download
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              Download
            </a>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-800 p-4 font-mono text-sm text-gray-300">
            {previewText}
          </pre>
        </div>
      )}

      {previewUrl && !previewText && (
        <div className="mt-4 text-center">
          <p className="mb-2 text-sm text-gray-400">Content found</p>
          <a
            href={previewUrl}
            download
            className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
          >
            Download File
          </a>
        </div>
      )}
    </div>
  );
}
