// SoulRegistry contract interaction client (ethers v6)

import { Contract, JsonRpcProvider, Wallet } from "ethers"
import type { SoulInfo, OnChainBackup } from "./types.ts"

// Minimal ABI for SoulRegistry
const SOUL_REGISTRY_ABI = [
  "function registerSoul(bytes32 agentId, bytes32 identityCid, bytes calldata ownershipSig) external",
  "function anchorBackup(bytes32 agentId, bytes32 manifestCid, bytes32 dataMerkleRoot, uint32 fileCount, uint64 totalBytes, uint8 backupType, bytes32 parentManifestCid, bytes calldata sig) external",
  "function updateIdentity(bytes32 agentId, bytes32 newIdentityCid, bytes calldata sig) external",
  "function getSoul(bytes32 agentId) external view returns (tuple(bytes32 agentId, address owner, bytes32 identityCid, bytes32 latestSnapshotCid, uint64 registeredAt, uint64 lastBackupAt, uint32 backupCount, uint16 version, bool active))",
  "function getLatestBackup(bytes32 agentId) external view returns (tuple(bytes32 manifestCid, bytes32 dataMerkleRoot, uint64 anchoredAt, uint32 fileCount, uint64 totalBytes, uint8 backupType, bytes32 parentManifestCid))",
  "function getBackupHistory(bytes32 agentId, uint256 offset, uint256 limit) external view returns (tuple(bytes32 manifestCid, bytes32 dataMerkleRoot, uint64 anchoredAt, uint32 fileCount, uint64 totalBytes, uint8 backupType, bytes32 parentManifestCid)[])",
  "function getBackupCount(bytes32 agentId) external view returns (uint256)",
  "function getGuardians(bytes32 agentId) external view returns (tuple(address guardian, uint64 addedAt, bool active)[])",
  "function getActiveGuardianCount(bytes32 agentId) external view returns (uint256)",
  "function addGuardian(bytes32 agentId, address guardian) external",
  "function removeGuardian(bytes32 agentId, address guardian) external",
  "function nonces(bytes32 agentId) external view returns (uint64)",
  "function ownerToAgent(address owner) external view returns (bytes32)",
  "function soulCount() external view returns (uint256)",
  "function DOMAIN_SEPARATOR() external view returns (bytes32)",
] as const

const SOUL_DOMAIN_NAME = "COCSoulRegistry"
const SOUL_DOMAIN_VERSION = "1"

export class SoulClient {
  private readonly provider: JsonRpcProvider
  private readonly wallet: Wallet
  private readonly contract: Contract
  private readonly contractAddress: string

  constructor(rpcUrl: string, contractAddress: string, privateKey: string) {
    this.provider = new JsonRpcProvider(rpcUrl)
    this.wallet = new Wallet(privateKey, this.provider)
    this.contract = new Contract(contractAddress, SOUL_REGISTRY_ABI, this.wallet)
    this.contractAddress = contractAddress
  }

  get address(): string {
    return this.wallet.address
  }

  private async getDomain() {
    const network = await this.provider.getNetwork()
    return {
      name: SOUL_DOMAIN_NAME,
      version: SOUL_DOMAIN_VERSION,
      chainId: network.chainId,
      verifyingContract: this.contractAddress,
    }
  }

  async getNonce(agentId: string): Promise<bigint> {
    return this.contract.nonces(agentId)
  }

  async getAgentIdForOwner(owner?: string): Promise<string> {
    const addr = owner ?? this.wallet.address
    return this.contract.ownerToAgent(addr)
  }

  // -----------------------------------------------------------------------
  //  Registration
  // -----------------------------------------------------------------------

  async registerSoul(agentId: string, identityCid: string): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)

    const sig = await this.wallet.signTypedData(domain, {
      RegisterSoul: [
        { name: "agentId", type: "bytes32" },
        { name: "identityCid", type: "bytes32" },
        { name: "owner", type: "address" },
        { name: "nonce", type: "uint64" },
      ],
    }, {
      agentId,
      identityCid,
      owner: this.wallet.address,
      nonce,
    })

    const tx = await this.contract.registerSoul(agentId, identityCid, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  // -----------------------------------------------------------------------
  //  Backup Anchoring
  // -----------------------------------------------------------------------

  async anchorBackup(
    agentId: string,
    manifestCid: string,
    dataMerkleRoot: string,
    fileCount: number,
    totalBytes: number,
    backupType: 0 | 1,
    parentManifestCid: string,
  ): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)

    const sig = await this.wallet.signTypedData(domain, {
      AnchorBackup: [
        { name: "agentId", type: "bytes32" },
        { name: "manifestCid", type: "bytes32" },
        { name: "dataMerkleRoot", type: "bytes32" },
        { name: "fileCount", type: "uint32" },
        { name: "totalBytes", type: "uint64" },
        { name: "backupType", type: "uint8" },
        { name: "parentManifestCid", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    }, {
      agentId,
      manifestCid,
      dataMerkleRoot,
      fileCount,
      totalBytes,
      backupType,
      parentManifestCid,
      nonce,
    })

    const tx = await this.contract.anchorBackup(
      agentId, manifestCid, dataMerkleRoot,
      fileCount, totalBytes, backupType, parentManifestCid, sig,
    )
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  // -----------------------------------------------------------------------
  //  Identity Update
  // -----------------------------------------------------------------------

  async updateIdentity(agentId: string, newIdentityCid: string): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)

    const sig = await this.wallet.signTypedData(domain, {
      UpdateIdentity: [
        { name: "agentId", type: "bytes32" },
        { name: "newIdentityCid", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    }, {
      agentId,
      newIdentityCid,
      nonce,
    })

    const tx = await this.contract.updateIdentity(agentId, newIdentityCid, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  // -----------------------------------------------------------------------
  //  Views
  // -----------------------------------------------------------------------

  async getSoul(agentId: string): Promise<SoulInfo> {
    const raw = await this.contract.getSoul(agentId)
    return {
      agentId: raw.agentId,
      owner: raw.owner,
      identityCid: raw.identityCid,
      latestSnapshotCid: raw.latestSnapshotCid,
      registeredAt: Number(raw.registeredAt),
      lastBackupAt: Number(raw.lastBackupAt),
      backupCount: Number(raw.backupCount),
      version: Number(raw.version),
      active: raw.active,
    }
  }

  async getLatestBackup(agentId: string): Promise<OnChainBackup> {
    const raw = await this.contract.getLatestBackup(agentId)
    return this._mapBackup(raw)
  }

  async getBackupHistory(agentId: string, offset: number, limit: number): Promise<OnChainBackup[]> {
    const raw = await this.contract.getBackupHistory(agentId, offset, limit)
    return raw.map((r: Record<string, unknown>) => this._mapBackup(r))
  }

  async getBackupCount(agentId: string): Promise<number> {
    const count = await this.contract.getBackupCount(agentId)
    return Number(count)
  }

  private _mapBackup(raw: Record<string, unknown>): OnChainBackup {
    return {
      manifestCid: raw.manifestCid as string,
      dataMerkleRoot: raw.dataMerkleRoot as string,
      anchoredAt: Number(raw.anchoredAt),
      fileCount: Number(raw.fileCount),
      totalBytes: Number(raw.totalBytes),
      backupType: Number(raw.backupType),
      parentManifestCid: raw.parentManifestCid as string,
    }
  }
}
