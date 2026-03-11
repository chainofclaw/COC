"use client";

import { useState, useEffect, useCallback } from "react";
import { ipfs } from "@/lib/ipfs-client";
import type { MfsEntry } from "@/lib/types";

interface Props {
  entry: MfsEntry;
  dirPath: string;
  onClose: () => void;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"]);
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "json",
  "csv",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "yaml",
  "yml",
  "toml",
  "log",
]);

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function FilePreview({ entry, dirPath, onClose }: Props) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const ext = getExtension(entry.Name);
  const isImage = IMAGE_EXTS.has(ext);
  const isText = TEXT_EXTS.has(ext);
  const cid = entry.Hash;

  useEffect(() => {
    if (!isText || !cid) return;
    setLoading(true);
    ipfs
      .read(`${dirPath}/${entry.Name}`)
      .then((data) => {
        const text = new TextDecoder().decode(data);
        setTextContent(text.slice(0, 50000)); // cap preview at 50KB text
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Read failed"),
      )
      .finally(() => setLoading(false));
  }, [isText, cid, dirPath, entry.Name]);

  const handleDownload = useCallback(() => {
    if (!cid) return;
    const url = ipfs.gatewayUrl(cid);
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.Name;
    a.click();
  }, [cid, entry.Name]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl border border-gray-700 bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h3 className="truncate font-medium">{entry.Name}</h3>
          <div className="flex items-center gap-2">
            {cid && (
              <button
                onClick={handleDownload}
                className="rounded-lg bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
              >
                Download
              </button>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white"
            >
              &#10005;
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="overflow-auto p-4" style={{ maxHeight: "60vh" }}>
          {isImage && cid && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={ipfs.gatewayUrl(cid)}
              alt={entry.Name}
              className="mx-auto max-h-[50vh] rounded"
            />
          )}

          {isText && loading && (
            <p className="text-center text-gray-500">Loading preview...</p>
          )}
          {isText && error && (
            <p className="text-center text-red-400">{error}</p>
          )}
          {isText && textContent !== null && (
            <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-gray-800 p-4 font-mono text-sm text-gray-300">
              {textContent}
            </pre>
          )}

          {!isImage && !isText && (
            <div className="py-8 text-center">
              <p className="text-gray-400">
                Preview not available for .{ext || "unknown"} files
              </p>
              {cid && (
                <div className="mt-4">
                  <p className="mb-2 text-sm text-gray-500">CID:</p>
                  <code className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-300">
                    {cid}
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
