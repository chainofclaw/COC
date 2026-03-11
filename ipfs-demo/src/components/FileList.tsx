"use client";

import { useState, useEffect, useCallback } from "react";
import { ipfs } from "@/lib/ipfs-client";
import type { MfsEntry } from "@/lib/types";

interface Props {
  currentPath: string;
  onNavigate: (path: string) => void;
  onPreview: (entry: MfsEntry, path: string) => void;
  refreshKey: number;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileList({
  currentPath,
  onNavigate,
  onPreview,
  refreshKey,
}: Props) {
  const [entries, setEntries] = useState<MfsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await ipfs.mkdir(currentPath, true);
      const items = await ipfs.ls(currentPath);
      const sorted = [...items].sort((a, b) => {
        if (a.Type !== b.Type) return b.Type - a.Type; // directories first
        return a.Name.localeCompare(b.Name);
      });
      setEntries(sorted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list files");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [currentPath]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries, refreshKey]);

  const handleDelete = useCallback(
    async (entry: MfsEntry) => {
      const confirmed = window.confirm(
        `Delete "${entry.Name}"${entry.Type === 1 ? " and all contents" : ""}?`,
      );
      if (!confirmed) return;
      try {
        await ipfs.rm(
          `${currentPath}/${entry.Name}`,
          entry.Type === 1, // recursive for directories
        );
        await loadEntries();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [currentPath, loadEntries],
  );

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      await ipfs.mkdir(`${currentPath}/${newFolderName.trim()}`, true);
      setNewFolderName("");
      setShowNewFolder(false);
      await loadEntries();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Create folder failed");
    }
  }, [currentPath, newFolderName, loadEntries]);

  // Breadcrumb segments
  const segments = currentPath.split("/").filter(Boolean);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Files</h2>
        <button
          onClick={() => setShowNewFolder(!showNewFolder)}
          className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
        >
          New Folder
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
        <button
          onClick={() => onNavigate("/" + segments.slice(0, 2).join("/"))}
          className="text-blue-400 hover:text-blue-300"
        >
          ~
        </button>
        {segments.slice(2).map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-gray-600">/</span>
            <button
              onClick={() =>
                onNavigate("/" + segments.slice(0, i + 3).join("/"))
              }
              className="text-blue-400 hover:text-blue-300"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="mb-3 flex gap-2">
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
            placeholder="Folder name"
            className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            autoFocus
          />
          <button
            onClick={handleCreateFolder}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
          >
            Create
          </button>
          <button
            onClick={() => {
              setShowNewFolder(false);
              setNewFolderName("");
            }}
            className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
          >
            Cancel
          </button>
        </div>
      )}

      {loading && <p className="py-8 text-center text-gray-500">Loading...</p>}

      {error && (
        <p className="py-4 text-center text-sm text-red-400">{error}</p>
      )}

      {!loading && !error && entries.length === 0 && (
        <p className="py-8 text-center text-gray-500">
          Empty directory. Upload a file to get started.
        </p>
      )}

      {!loading && entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500">
                <th className="pb-2 pr-4">Name</th>
                <th className="pb-2 pr-4">Size</th>
                <th className="pb-2 pr-4">CID</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.Name}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30"
                >
                  <td className="py-2 pr-4">
                    {entry.Type === 1 ? (
                      <button
                        onClick={() =>
                          onNavigate(`${currentPath}/${entry.Name}`)
                        }
                        className="flex items-center gap-2 text-blue-400 hover:text-blue-300"
                      >
                        <span>&#128193;</span>
                        {entry.Name}
                      </button>
                    ) : (
                      <button
                        onClick={() => onPreview(entry, currentPath)}
                        className="flex items-center gap-2 text-gray-200 hover:text-white"
                      >
                        <span>&#128196;</span>
                        {entry.Name}
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-gray-400">
                    {formatSize(entry.Size)}
                  </td>
                  <td className="py-2 pr-4">
                    {entry.Hash && (
                      <code className="text-xs text-gray-500">
                        {entry.Hash.slice(0, 12)}...
                      </code>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => handleDelete(entry)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
