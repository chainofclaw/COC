// DIDRegistry contract interaction client (ethers v6)
// Wraps DIDRegistry write operations with EIP-712 signing

import { Contract, FetchRequest, JsonRpcProvider, Wallet } from "ethers"

const DID_REGISTRY_ABI = [
  // Write (EIP-712 signed)
  "function updateDIDDocument(bytes32 agentId, bytes32 newDocumentCid, bytes calldata sig) external",
  "function addVerificationMethod(bytes32 agentId, bytes32 keyId, address keyAddress, uint8 keyPurpose, bytes calldata sig) external",
  "function revokeVerificationMethod(bytes32 agentId, bytes32 keyId, bytes calldata sig) external",
  "function grantDelegation(bytes32 delegator, bytes32 delegatee, bytes32 parentDelegation, bytes32 scopeHash, uint64 expiresAt, uint8 depth, bytes calldata sig) external",
  "function revokeDelegation(bytes32 delegationId, bytes calldata sig) external",
  "function createEphemeralIdentity(bytes32 parentAgentId, bytes32 ephemeralId, address ephemeralAddress, bytes32 scopeHash, uint64 expiresAt, bytes calldata sig) external",
  "function anchorCredential(bytes32 credentialHash, bytes32 issuerAgentId, bytes32 subjectAgentId, bytes32 credentialCid, uint64 expiresAt, bytes calldata sig) external",
  "function revokeCredential(bytes32 credentialId) external",
  "function revokeAllDelegations(bytes32 agentId) external",
  "function recordLineage(bytes32 agentId, bytes32 parentAgentId, uint256 forkHeight, uint16 generation) external",
  "function updateCapabilities(bytes32 agentId, uint16 capabilities) external",
  "function deactivateEphemeralIdentity(bytes32 ephemeralId) external",
  // Read
  "function nonces(bytes32 agentId) external view returns (uint64)",
  "function getActiveVerificationMethods(bytes32 agentId) external view returns (tuple(bytes32 keyId, address keyAddress, uint8 keyPurpose, uint64 addedAt, uint64 revokedAt, bool active)[])",
  "function agentCapabilities(bytes32 agentId) external view returns (uint256)",
  "function agentLineage(bytes32 agentId) external view returns (bytes32 parentAgentId, uint256 forkHeight, uint16 generation)",
  "function isDelegationValid(bytes32 delegationId) external view returns (bool)",
  "function getAgentDelegations(bytes32 agentId) external view returns (bytes32[])",
  "function delegations(bytes32 delegationId) external view returns (bytes32 delegator, bytes32 delegatee, bytes32 parentDelegation, bytes32 scopeHash, uint64 issuedAt, uint64 expiresAt, uint8 depth, bool revoked)",
] as const

const DID_DOMAIN_NAME = "COCDIDRegistry"
const DID_DOMAIN_VERSION = "1"

export class DIDClient {
  private readonly provider: JsonRpcProvider
  private readonly wallet: Wallet
  private readonly contract: Contract
  private readonly contractAddress: string

  constructor(rpcUrl: string, contractAddress: string, privateKey: string, rpcAuthToken?: string) {
    if (rpcAuthToken) {
      const fetchReq = new FetchRequest(rpcUrl)
      fetchReq.setHeader("Authorization", `Bearer ${rpcAuthToken}`)
      this.provider = new JsonRpcProvider(fetchReq)
    } else {
      this.provider = new JsonRpcProvider(rpcUrl)
    }
    this.wallet = new Wallet(privateKey, this.provider)
    this.contract = new Contract(contractAddress, DID_REGISTRY_ABI, this.wallet)
    this.contractAddress = contractAddress
  }

  private async getDomain() {
    const network = await this.provider.getNetwork()
    return {
      name: DID_DOMAIN_NAME,
      version: DID_DOMAIN_VERSION,
      chainId: network.chainId,
      verifyingContract: this.contractAddress,
    }
  }

  private async getNonce(agentId: string): Promise<bigint> {
    return this.contract.nonces(agentId)
  }

  // ── Write Operations (EIP-712 signed) ──────────────────────────────

  async updateDIDDocument(agentId: string, newDocumentCid: string): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)
    const sig = await this.wallet.signTypedData(domain, {
      UpdateDIDDocument: [
        { name: "agentId", type: "bytes32" },
        { name: "newDocumentCid", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    }, { agentId, newDocumentCid, nonce })
    const tx = await this.contract.updateDIDDocument(agentId, newDocumentCid, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async addVerificationMethod(
    agentId: string, keyId: string, keyAddress: string, keyPurpose: number,
  ): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)
    const sig = await this.wallet.signTypedData(domain, {
      AddVerificationMethod: [
        { name: "agentId", type: "bytes32" },
        { name: "keyId", type: "bytes32" },
        { name: "keyAddress", type: "address" },
        { name: "keyPurpose", type: "uint8" },
        { name: "nonce", type: "uint64" },
      ],
    }, { agentId, keyId, keyAddress, keyPurpose, nonce })
    const tx = await this.contract.addVerificationMethod(agentId, keyId, keyAddress, keyPurpose, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async revokeVerificationMethod(agentId: string, keyId: string): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(agentId)
    const sig = await this.wallet.signTypedData(domain, {
      RevokeVerificationMethod: [
        { name: "agentId", type: "bytes32" },
        { name: "keyId", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    }, { agentId, keyId, nonce })
    const tx = await this.contract.revokeVerificationMethod(agentId, keyId, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async grantDelegation(
    delegator: string, delegatee: string, parentDelegation: string,
    scopeHash: string, expiresAt: number, depth: number,
  ): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(delegator)
    const sig = await this.wallet.signTypedData(domain, {
      GrantDelegation: [
        { name: "delegator", type: "bytes32" },
        { name: "delegatee", type: "bytes32" },
        { name: "parentDelegation", type: "bytes32" },
        { name: "scopeHash", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
        { name: "depth", type: "uint8" },
        { name: "nonce", type: "uint64" },
      ],
    }, { delegator, delegatee, parentDelegation, scopeHash, expiresAt, depth, nonce })
    const tx = await this.contract.grantDelegation(delegator, delegatee, parentDelegation, scopeHash, expiresAt, depth, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async revokeDelegation(delegationId: string): Promise<string> {
    const domain = await this.getDomain()
    // Look up the delegation to find the delegator, then fetch its nonce
    const delegation = await this.contract.delegations(delegationId)
    const nonce = await this.getNonce(delegation.delegator)
    const sig = await this.wallet.signTypedData(domain, {
      RevokeDelegation: [
        { name: "delegationId", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    }, { delegationId, nonce })
    const tx = await this.contract.revokeDelegation(delegationId, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async revokeAllDelegations(agentId: string): Promise<string> {
    const tx = await this.contract.revokeAllDelegations(agentId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async anchorCredential(
    credentialHash: string, issuerAgentId: string, subjectAgentId: string,
    credentialCid: string, expiresAt: number,
  ): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(issuerAgentId)
    const sig = await this.wallet.signTypedData(domain, {
      AnchorCredential: [
        { name: "credentialHash", type: "bytes32" },
        { name: "issuerAgentId", type: "bytes32" },
        { name: "subjectAgentId", type: "bytes32" },
        { name: "credentialCid", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    }, { credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, nonce })
    const tx = await this.contract.anchorCredential(credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async revokeCredential(credentialId: string): Promise<string> {
    const tx = await this.contract.revokeCredential(credentialId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async recordLineage(
    agentId: string, parentAgentId: string, forkHeight: number, generation: number,
  ): Promise<string> {
    const tx = await this.contract.recordLineage(agentId, parentAgentId, forkHeight, generation)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async updateCapabilities(agentId: string, capabilities: number): Promise<string> {
    const tx = await this.contract.updateCapabilities(agentId, capabilities)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async createEphemeralIdentity(
    parentAgentId: string, ephemeralId: string, ephemeralAddress: string,
    scopeHash: string, expiresAt: number,
  ): Promise<string> {
    const domain = await this.getDomain()
    const nonce = await this.getNonce(parentAgentId)
    const sig = await this.wallet.signTypedData(domain, {
      CreateEphemeralIdentity: [
        { name: "parentAgentId", type: "bytes32" },
        { name: "ephemeralId", type: "bytes32" },
        { name: "ephemeralAddress", type: "address" },
        { name: "scopeHash", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    }, { parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, nonce })
    const tx = await this.contract.createEphemeralIdentity(parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, sig)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  async deactivateEphemeralIdentity(ephemeralId: string): Promise<string> {
    const tx = await this.contract.deactivateEphemeralIdentity(ephemeralId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted")
    return receipt.hash
  }

  // ── Read Operations ────────────────────────────────────────────────

  async getVerificationMethods(agentId: string): Promise<Array<{
    keyId: string; keyAddress: string; keyPurpose: number
    addedAt: number; revokedAt: number; active: boolean
  }>> {
    const raw = await this.contract.getActiveVerificationMethods(agentId)
    return raw.map((vm: Record<string, unknown>) => ({
      keyId: vm.keyId as string,
      keyAddress: vm.keyAddress as string,
      keyPurpose: Number(vm.keyPurpose),
      addedAt: Number(vm.addedAt),
      revokedAt: Number(vm.revokedAt),
      active: vm.active as boolean,
    }))
  }

  async getCapabilities(agentId: string): Promise<number> {
    return Number(await this.contract.agentCapabilities(agentId))
  }

  async getDelegations(agentId: string): Promise<Array<{
    delegationId: string; delegator: string; delegatee: string
    scopeHash: string; issuedAt: number; expiresAt: number; depth: number; revoked: boolean
  }>> {
    const ids: string[] = await this.contract.getAgentDelegations(agentId)
    const results = []
    for (const delegationId of ids) {
      const d = await this.contract.delegations(delegationId)
      results.push({
        delegationId,
        delegator: d.delegator as string,
        delegatee: d.delegatee as string,
        scopeHash: d.scopeHash as string,
        issuedAt: Number(d.issuedAt),
        expiresAt: Number(d.expiresAt),
        depth: Number(d.depth),
        revoked: d.revoked as boolean,
      })
    }
    return results
  }
}
