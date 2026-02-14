export type Hex = `0x${string}`

export type CidString = string

export interface IpfsAddResult {
  Name: string
  Hash: CidString
  Size: string
}

export interface IpfsBlock {
  cid: CidString
  bytes: Uint8Array
}

export interface FileChunk {
  offset: number
  bytes: Uint8Array
}

export interface UnixFsFileMeta {
  cid: CidString
  size: number
  blockSize: number
  leaves: CidString[]
  root: CidString
  merkleRoot: Hex
  merkleLeaves: Hex[]
}

export interface StorageProof {
  chunkIndex: number
  leafHash: Hex
  merkleRoot: Hex
  merklePath: Hex[]
}
