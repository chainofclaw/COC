// SoulRegistry contract interaction client (ethers v6)

import { Contract, JsonRpcProvider, Wallet } from "ethers"
import type {
  SoulInfo,
  OnChainBackup,
  ResurrectionConfig,
  CarrierInfo,
  ResurrectionReadiness,
  ResurrectionRequestInfo,
  ResurrectionStartResult,
} from "./types.ts"

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
  // Resurrection
  "function configureResurrection(bytes32 agentId, bytes32 resurrectionKeyHash, uint64 maxOfflineDuration) external",
  "function heartbeat(bytes32 agentId, uint64 timestamp, bytes calldata sig) external",
  "function isOffline(bytes32 agentId) external view returns (bool)",
  "function getResurrectionConfig(bytes32 agentId) external view returns (tuple(bytes32 resurrectionKeyHash, uint64 maxOfflineDuration, uint64 lastHeartbeat, bool configured))",
  "function registerCarrier(bytes32 carrierId, string calldata endpoint, uint64 cpuMillicores, uint64 memoryMB, uint64 storageMB) external",
  "function deregisterCarrier(bytes32 carrierId) external",
  "function updateCarrierAvailability(bytes32 carrierId, bool available) external",
  "function getCarrier(bytes32 carrierId) external view returns (tuple(bytes32 carrierId, address owner, string endpoint, uint64 registeredAt, uint64 cpuMillicores, uint64 memoryMB, uint64 storageMB, bool available, bool active))",
  "function resurrectionRequests(bytes32 requestId) external view returns (bytes32 agentId, bytes32 carrierId, address initiator, uint64 initiatedAt, uint8 approvalCount, uint8 guardianSnapshot, bool executed, bool carrierConfirmed, uint8 trigger)",
  "function resurrectionApprovals(bytes32 requestId, address guardian) external view returns (bool)",
  "function getResurrectionReadiness(bytes32 requestId) external view returns (bool exists, uint8 trigger, uint8 approvalCount, uint8 approvalThreshold, bool carrierConfirmed, bool offlineNow, uint64 readyAt, bool canComplete)",
  "function initiateResurrection(bytes32 agentId, bytes32 carrierId, bytes calldata sig) external",
  "function initiateGuardianResurrection(bytes32 agentId, bytes32 carrierId) external",
  "function approveResurrection(bytes32 requestId) external",
  "function confirmCarrier(bytes32 requestId) external",
  "function completeResurrection(bytes32 requestId) external",
  "function cancelResurrection(bytes32 requestId) external",
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

  private _triggerLabel(trigger: number): "owner-key" | "guardian-vote" {
    return trigger === 1 ? "guardian-vote" : "owner-key"
  }

  private _extractEventArg(receipt: { logs?: Array<Record<string, any>> }, eventName: string, index: number): string {
    const log = receipt.logs?.find((entry) => entry.fragment?.name === eventName)
    const value = log?.args?.[index]
    if (typeof value !== "string") {
      throw new Error(`Failed to parse ${eventName} from transaction receipt`)
    }
    return value
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

  // -----------------------------------------------------------------------
  //  Resurrection
  // -----------------------------------------------------------------------

  async configureResurrection(
    agentId: string,
    resurrectionKeyHash: string,
    maxOfflineDuration: number,
  ): Promise<string> {
    const tx = await this.contract.configureResurrection(agentId, resurrectionKeyHash, maxOfflineDuration)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async heartbeat(agentId: string): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)
    const timestamp = Math.floor(Date.now() / 1000)

    const sig = await this.wallet.signTypedData(domain, {
      Heartbeat: [
        { name: "agentId", type: "bytes32" },
        { name: "timestamp", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    }, {
      agentId,
      timestamp,
      nonce,
    })

    const tx = await this.contract.heartbeat(agentId, timestamp, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async isOffline(agentId: string): Promise<boolean> {
    return this.contract.isOffline(agentId)
  }

  async getResurrectionConfig(agentId: string): Promise<ResurrectionConfig> {
    const raw = await this.contract.getResurrectionConfig(agentId)
    return {
      resurrectionKeyHash: raw.resurrectionKeyHash,
      maxOfflineDuration: Number(raw.maxOfflineDuration),
      lastHeartbeat: Number(raw.lastHeartbeat),
      configured: raw.configured,
    }
  }

  async initiateResurrection(
    agentId: string,
    carrierId: string,
    resurrectionKey: string,
  ): Promise<ResurrectionStartResult> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)

    // Sign with the resurrection key (separate wallet)
    const resWallet = new Wallet(resurrectionKey, this.provider)
    const sig = await resWallet.signTypedData(domain, {
      ResurrectSoul: [
        { name: "agentId", type: "bytes32" },
        { name: "carrierId", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    }, {
      agentId,
      carrierId,
      nonce,
    })

    const tx = await this.contract.initiateResurrection(agentId, carrierId, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return {
      txHash: receipt.hash,
      requestId: this._extractEventArg(receipt, "ResurrectionInitiated", 0),
    }
  }

  async registerCarrier(
    carrierId: string,
    endpoint: string,
    cpuMillicores: number,
    memoryMB: number,
    storageMB: number,
  ): Promise<string> {
    const tx = await this.contract.registerCarrier(carrierId, endpoint, cpuMillicores, memoryMB, storageMB)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async deregisterCarrier(carrierId: string): Promise<string> {
    const tx = await this.contract.deregisterCarrier(carrierId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async updateCarrierAvailability(carrierId: string, available: boolean): Promise<string> {
    const tx = await this.contract.updateCarrierAvailability(carrierId, available)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async getCarrier(carrierId: string): Promise<CarrierInfo> {
    const raw = await this.contract.getCarrier(carrierId)
    return {
      carrierId: raw.carrierId,
      owner: raw.owner,
      endpoint: raw.endpoint,
      registeredAt: Number(raw.registeredAt),
      cpuMillicores: Number(raw.cpuMillicores),
      memoryMB: Number(raw.memoryMB),
      storageMB: Number(raw.storageMB),
      available: raw.available,
      active: raw.active,
    }
  }

  async getResurrectionRequest(requestId: string): Promise<ResurrectionRequestInfo> {
    const raw = await this.contract.resurrectionRequests(requestId)
    return {
      requestId,
      agentId: raw.agentId,
      carrierId: raw.carrierId,
      initiator: raw.initiator,
      initiatedAt: Number(raw.initiatedAt),
      approvalCount: Number(raw.approvalCount),
      guardianSnapshot: Number(raw.guardianSnapshot),
      executed: raw.executed,
      carrierConfirmed: raw.carrierConfirmed,
      trigger: this._triggerLabel(Number(raw.trigger)),
    }
  }

  async getResurrectionApproval(requestId: string, guardian: string): Promise<boolean> {
    return this.contract.resurrectionApprovals(requestId, guardian)
  }

  async getResurrectionReadiness(requestId: string): Promise<ResurrectionReadiness> {
    const raw = await this.contract.getResurrectionReadiness(requestId)
    return {
      exists: raw.exists,
      trigger: this._triggerLabel(Number(raw.trigger)),
      approvalCount: Number(raw.approvalCount),
      approvalThreshold: Number(raw.approvalThreshold),
      carrierConfirmed: raw.carrierConfirmed,
      offlineNow: raw.offlineNow,
      readyAt: Number(raw.readyAt),
      canComplete: raw.canComplete,
    }
  }

  async confirmCarrier(requestId: string): Promise<string> {
    const tx = await this.contract.confirmCarrier(requestId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async completeResurrection(requestId: string): Promise<string> {
    const tx = await this.contract.completeResurrection(requestId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async cancelResurrection(requestId: string): Promise<string> {
    const tx = await this.contract.cancelResurrection(requestId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }
}
