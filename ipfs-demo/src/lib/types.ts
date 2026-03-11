export interface MfsEntry {
  Name: string;
  Type: 0 | 1; // 0=file, 1=directory
  Size: number;
  Hash: string;
}

export interface MfsStat {
  hash: string;
  size: number;
  cumulativeSize: number;
  type: "file" | "directory";
  blocks: number;
}

export interface RepoStat {
  NumObjects: number;
  RepoSize: number;
  StorageMax: number;
  RepoPath: string;
  Version: string;
}

export interface WalletState {
  address: string | null;
  balance: string;
  chainId: number | null;
  connected: boolean;
  wrongChain: boolean;
}

export const COC_CHAIN_ID = 18780;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
