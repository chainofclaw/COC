import type { MfsEntry, MfsStat, RepoStat } from "./types";

const API = "/ipfs-api";

async function checkResponse(res: Response, operation: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`IPFS ${operation} failed (${res.status}): ${text}`);
  }
}

export const ipfs = {
  async mkdir(path: string, parents = true): Promise<void> {
    const params = new URLSearchParams({ arg: path });
    if (parents) params.set("parents", "true");
    const res = await fetch(`${API}/files/mkdir?${params}`, { method: "POST" });
    await checkResponse(res, "mkdir");
  },

  async write(path: string, data: Uint8Array | Blob): Promise<void> {
    const params = new URLSearchParams({
      arg: path,
      create: "true",
      truncate: "true",
    });
    const body =
      data instanceof Blob ? data : new Blob([data as BlobPart]);
    const res = await fetch(`${API}/files/write?${params}`, {
      method: "POST",
      body,
    });
    await checkResponse(res, "write");
  },

  async read(path: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ arg: path });
    const res = await fetch(`${API}/files/read?${params}`, { method: "POST" });
    await checkResponse(res, "read");
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  },

  async ls(path: string): Promise<MfsEntry[]> {
    const params = new URLSearchParams({ arg: path });
    const res = await fetch(`${API}/files/ls?${params}`, { method: "POST" });
    await checkResponse(res, "ls");
    const json = await res.json();
    return (json.Entries as MfsEntry[] | null) ?? [];
  },

  async stat(path: string): Promise<MfsStat> {
    const params = new URLSearchParams({ arg: path });
    const res = await fetch(`${API}/files/stat?${params}`, { method: "POST" });
    await checkResponse(res, "stat");
    return (await res.json()) as MfsStat;
  },

  async rm(path: string, recursive = false): Promise<void> {
    const params = new URLSearchParams({ arg: path });
    if (recursive) params.set("recursive", "true");
    const res = await fetch(`${API}/files/rm?${params}`, { method: "POST" });
    await checkResponse(res, "rm");
  },

  async catByCid(cid: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ arg: cid });
    const res = await fetch(`${API}/cat?${params}`, { method: "POST" });
    await checkResponse(res, "cat");
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  },

  gatewayUrl(cid: string): string {
    return `/ipfs-gw/${cid}`;
  },

  async repoStat(): Promise<RepoStat> {
    const res = await fetch(`${API}/repo/stat`, { method: "POST" });
    await checkResponse(res, "repoStat");
    return (await res.json()) as RepoStat;
  },
};

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      .replace(/\.\./g, "_")
      .replace(/\0/g, "")
      .slice(0, 200)
      .trim() || "untitled"
  );
}
