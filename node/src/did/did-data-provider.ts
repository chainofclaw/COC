// Concrete DIDDataProvider: reads from SoulRegistry + DIDRegistry contracts
// Uses an injected ethCall function for in-process contract reads (no HTTP loopback)

import { Interface } from "ethers"
import type { DIDDataProvider } from "./did-resolver.ts"
import type {
  SoulIdentityData,
  GuardianData,
  ResurrectionConfigData,
  VerificationMethodData,
  LineageData,
} from "./did-document-builder.ts"
import type { Hex32 } from "./did-types.ts"

// Minimal ABIs — read-only functions
const SOUL_REGISTRY_IFACE = new Interface([
  "function getSoul(bytes32 agentId) external view returns (tuple(bytes32 agentId, address owner, bytes32 identityCid, bytes32 latestSnapshotCid, uint64 registeredAt, uint64 lastBackupAt, uint32 backupCount, uint16 version, bool active))",
  "function getGuardians(bytes32 agentId) external view returns (tuple(address guardian, uint64 addedAt, bool active)[])",
  "function getResurrectionConfig(bytes32 agentId) external view returns (tuple(bytes32 resurrectionKeyHash, uint64 maxOfflineDuration, uint64 lastHeartbeat, bool configured))",
])

const DID_REGISTRY_IFACE = new Interface([
  "function getActiveVerificationMethods(bytes32 agentId) external view returns (tuple(bytes32 keyId, address keyAddress, uint8 keyPurpose, uint64 addedAt, uint64 revokedAt, bool active)[])",
  "function agentCapabilities(bytes32 agentId) external view returns (uint256)",
  "function agentLineage(bytes32 agentId) external view returns (bytes32 parentAgentId, uint256 forkHeight, uint16 generation)",
  "function didDocumentCid(bytes32 agentId) external view returns (bytes32)",
  "function didDocumentUpdatedAt(bytes32 agentId) external view returns (uint64)",
  "function getAgentDelegations(bytes32 agentId) external view returns (bytes32[])",
  "function delegations(bytes32 delegationId) external view returns (bytes32 delegator, bytes32 delegatee, bytes32 parentDelegation, bytes32 scopeHash, uint64 issuedAt, uint64 expiresAt, uint8 depth, bool revoked)",
  "function credentials(bytes32 credentialId) external view returns (bytes32 credentialHash, bytes32 issuerAgentId, bytes32 subjectAgentId, bytes32 credentialCid, uint64 issuedAt, uint64 expiresAt, bool revoked)",
])

/** In-process eth_call function: (to, data) → hex result */
export type EthCallFn = (to: string, data: string) => Promise<string>

export interface ContractDIDDataProviderConfig {
  soulRegistryAddress: string
  didRegistryAddress: string
  ethCall: EthCallFn
}

async function call(ethCall: EthCallFn, to: string, iface: Interface, method: string, args: unknown[]): Promise<unknown[]> {
  const data = iface.encodeFunctionData(method, args)
  const result = await ethCall(to, data)
  return iface.decodeFunctionResult(method, result) as unknown as unknown[]
}

export interface DelegationRecord {
  delegationId: string
  delegator: string
  delegatee: string
  parentDelegation: string
  scopeHash: string
  issuedAt: number
  expiresAt: number
  depth: number
  revoked: boolean
  /** true when the delegation record could not be read from chain.
   *  When set, all other fields (except delegationId) are zero-valued stubs.
   *  Consumers should skip or retry these records. */
  _readError?: boolean
}

/** On-chain credential anchor check result.
 *  This only verifies the on-chain anchor (existence, revocation, expiry).
 *  Full VC verification (signatures, proofs, content) must be done separately
 *  via verifiable-credentials.ts after fetching the credential from IPFS. */
export interface OnChainCredentialAnchorResult {
  /** true if the credential anchor exists on-chain, is not revoked, and not expired */
  valid: boolean
  /** human-readable reason when valid=false */
  error?: string
  /** on-chain anchor data when the credential record exists */
  anchor?: {
    credentialHash: string
    issuerAgentId: string
    subjectAgentId: string
    credentialCid: string
    issuedAt: number
    expiresAt: number
    revoked: boolean
  }
}

export interface DIDDataProviderExt extends DIDDataProvider {
  getAgentDelegations(agentId: Hex32): Promise<string[]>
  getFullDelegations(agentId: Hex32): Promise<DelegationRecord[]>
  getDIDDocumentUpdatedAt(agentId: Hex32): Promise<number>
  getCredentialAnchor(credentialId: string): Promise<OnChainCredentialAnchorResult>
}

export function createContractDIDDataProvider(
  config: ContractDIDDataProviderConfig,
): DIDDataProviderExt {
  const { soulRegistryAddress, didRegistryAddress, ethCall } = config

  return {
    async getSoul(agentId: Hex32): Promise<SoulIdentityData | null> {
      try {
        const [raw] = await call(ethCall, soulRegistryAddress, SOUL_REGISTRY_IFACE, "getSoul", [agentId])
        const r = raw as Record<string, unknown>
        const owner = r.owner as string
        if (!owner || owner === "0x" + "0".repeat(40)) return null
        return {
          agentId: r.agentId as string,
          owner,
          identityCid: r.identityCid as string,
          latestSnapshotCid: r.latestSnapshotCid as string,
          registeredAt: BigInt(r.registeredAt as bigint),
          lastBackupAt: BigInt(r.lastBackupAt as bigint),
          backupCount: Number(r.backupCount),
          version: Number(r.version),
          active: r.active as boolean,
        }
      } catch {
        return null
      }
    },

    async getGuardians(agentId: Hex32): Promise<GuardianData[]> {
      try {
        const [raw] = await call(ethCall, soulRegistryAddress, SOUL_REGISTRY_IFACE, "getGuardians", [agentId])
        return (raw as Array<Record<string, unknown>>).map((g) => ({
          guardian: g.guardian as string,
          addedAt: BigInt(g.addedAt as bigint),
          active: g.active as boolean,
        }))
      } catch {
        return []
      }
    },

    async getResurrectionConfig(agentId: Hex32): Promise<ResurrectionConfigData | null> {
      try {
        const [raw] = await call(ethCall, soulRegistryAddress, SOUL_REGISTRY_IFACE, "getResurrectionConfig", [agentId])
        const r = raw as Record<string, unknown>
        if (!(r.configured as boolean)) return null
        return {
          resurrectionKeyHash: r.resurrectionKeyHash as string,
          maxOfflineDuration: BigInt(r.maxOfflineDuration as bigint),
          lastHeartbeat: BigInt(r.lastHeartbeat as bigint),
          configured: true,
        }
      } catch {
        return null
      }
    },

    async getVerificationMethods(agentId: Hex32): Promise<VerificationMethodData[]> {
      try {
        const [raw] = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "getActiveVerificationMethods", [agentId])
        return (raw as Array<Record<string, unknown>>).map((vm) => ({
          keyId: vm.keyId as string,
          keyAddress: vm.keyAddress as string,
          keyPurpose: Number(vm.keyPurpose),
          addedAt: BigInt(vm.addedAt as bigint),
          revokedAt: BigInt(vm.revokedAt as bigint),
          active: vm.active as boolean,
        }))
      } catch {
        return []
      }
    },

    async getCapabilities(agentId: Hex32): Promise<number> {
      try {
        const [caps] = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "agentCapabilities", [agentId])
        return Number(caps)
      } catch {
        return 0
      }
    },

    async getLineage(agentId: Hex32): Promise<LineageData | null> {
      try {
        const result = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "agentLineage", [agentId])
        const parentAgentId = result[0] as string
        const zeroId = "0x" + "00".repeat(32)
        if (parentAgentId === zeroId) return null
        return {
          parentAgentId,
          forkHeight: BigInt(result[1] as bigint),
          generation: Number(result[2]),
        }
      } catch {
        return null
      }
    },

    async getDIDDocumentCid(agentId: Hex32): Promise<string | null> {
      try {
        const [cid] = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "didDocumentCid", [agentId])
        const zeroId = "0x" + "00".repeat(32)
        return cid === zeroId ? null : cid as string
      } catch {
        return null
      }
    },

    async getAgentDelegations(agentId: Hex32): Promise<string[]> {
      try {
        const [ids] = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "getAgentDelegations", [agentId])
        return Array.from(ids as Iterable<string>)
      } catch {
        return []
      }
    },

    async getFullDelegations(agentId: Hex32): Promise<DelegationRecord[]> {
      try {
        const ids = await this.getAgentDelegations(agentId)
        const records: DelegationRecord[] = []
        for (const delegationId of ids) {
          try {
            const result = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "delegations", [delegationId])
            records.push({
              delegationId,
              delegator: result[0] as string,
              delegatee: result[1] as string,
              parentDelegation: result[2] as string,
              scopeHash: result[3] as string,
              issuedAt: Number(result[4]),
              expiresAt: Number(result[5]),
              depth: Number(result[6]),
              revoked: result[7] as boolean,
            })
          } catch {
            // Surface unreadable delegation as a stub record with _readError flag
            records.push({
              delegationId,
              delegator: "", delegatee: "", parentDelegation: "", scopeHash: "",
              issuedAt: 0, expiresAt: 0, depth: 0, revoked: false,
              _readError: true,
            })
          }
        }
        return records
      } catch {
        return []
      }
    },

    async getDIDDocumentUpdatedAt(agentId: Hex32): Promise<number> {
      try {
        const [ts] = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "didDocumentUpdatedAt", [agentId])
        return Number(ts)
      } catch {
        return 0
      }
    },

    async getCredentialAnchor(credentialId: string): Promise<OnChainCredentialAnchorResult> {
      try {
        const result = await call(ethCall, didRegistryAddress, DID_REGISTRY_IFACE, "credentials", [credentialId])
        const credentialHash = result[0] as string
        const zeroHash = "0x" + "00".repeat(32)
        if (credentialHash === zeroHash) {
          return { valid: false, error: "credential not found" }
        }
        const anchor = {
          credentialHash,
          issuerAgentId: result[1] as string,
          subjectAgentId: result[2] as string,
          credentialCid: result[3] as string,
          issuedAt: Number(result[4]),
          expiresAt: Number(result[5]),
          revoked: result[6] as boolean,
        }
        if (anchor.revoked) {
          return { valid: false, error: "credential revoked", anchor }
        }
        if (anchor.expiresAt > 0 && anchor.expiresAt < Math.floor(Date.now() / 1000)) {
          return { valid: false, error: "credential expired", anchor }
        }
        return { valid: true, anchor }
      } catch {
        return { valid: false, error: "on-chain read failed" }
      }
    },
  }
}
