// DID Resolver for did:coc method.
// Resolves DID identifiers to DID Documents by querying on-chain state.

import type { DIDResolutionResult, ParsedDID, Hex32 } from "./did-types.ts"
import { DEFAULT_CHAIN_ID } from "./did-types.ts"
import type {
  SoulIdentityData,
  GuardianData,
  ResurrectionConfigData,
  VerificationMethodData,
  LineageData,
  BuilderInput,
} from "./did-document-builder.ts"
import { buildDIDDocument, buildDeactivatedDocument } from "./did-document-builder.ts"

// --- DID parsing ---

const DID_REGEX = /^did:coc:(?:(\d+):)?(?:(agent|node):)?(.+)$/

export function parseDID(did: string): ParsedDID | null {
  const match = did.match(DID_REGEX)
  if (!match) return null

  const [, chainIdStr, typeStr, identifier] = match
  const chainId = chainIdStr ? parseInt(chainIdStr, 10) : DEFAULT_CHAIN_ID

  if (!Number.isFinite(chainId) || chainId <= 0) return null

  const identifierType = (typeStr as "agent" | "node") ?? "agent"

  // Validate hex identifier
  const id = identifier.toLowerCase()
  if (!/^0x[0-9a-f]{1,64}$/.test(id)) return null

  return {
    method: "coc",
    chainId,
    identifierType,
    identifier: id as Hex32,
  }
}

export function formatDID(agentId: string, chainId?: number): string {
  const id = agentId.toLowerCase()
  return chainId && chainId !== DEFAULT_CHAIN_ID
    ? `did:coc:${chainId}:${id}`
    : `did:coc:${id}`
}

// --- Data provider interface ---

export interface DIDDataProvider {
  getSoul(agentId: Hex32): Promise<SoulIdentityData | null>
  getGuardians(agentId: Hex32): Promise<GuardianData[]>
  getResurrectionConfig(agentId: Hex32): Promise<ResurrectionConfigData | null>
  // Optional DIDRegistry queries (Phase 2 will provide implementation)
  getVerificationMethods?(agentId: Hex32): Promise<VerificationMethodData[]>
  getCapabilities?(agentId: Hex32): Promise<number>
  getLineage?(agentId: Hex32): Promise<LineageData | null>
  getDIDDocumentCid?(agentId: Hex32): Promise<string | null>
}

// --- Resolver ---

export interface ResolverConfig {
  defaultChainId: number
  provider: DIDDataProvider
}

export function createDIDResolver(config: ResolverConfig) {
  const { provider, defaultChainId } = config

  async function resolve(did: string): Promise<DIDResolutionResult> {
    const parsed = parseDID(did)
    if (!parsed) {
      return {
        didDocument: null,
        didResolutionMetadata: {
          contentType: "application/did+json",
          error: "invalidDid",
        },
        didDocumentMetadata: {},
      }
    }

    if (parsed.chainId !== defaultChainId) {
      return {
        didDocument: null,
        didResolutionMetadata: {
          contentType: "application/did+json",
          error: "methodNotSupported",
        },
        didDocumentMetadata: {},
      }
    }

    // For now only agent type is supported from SoulRegistry
    if (parsed.identifierType !== "agent") {
      return {
        didDocument: null,
        didResolutionMetadata: {
          contentType: "application/did+json",
          error: "methodNotSupported",
        },
        didDocumentMetadata: {},
      }
    }

    const soul = await provider.getSoul(parsed.identifier)
    if (!soul) {
      return {
        didDocument: null,
        didResolutionMetadata: {
          contentType: "application/did+json",
          error: "notFound",
        },
        didDocumentMetadata: {},
      }
    }

    if (!soul.active) {
      return {
        didDocument: buildDeactivatedDocument(parsed.identifier, parsed.chainId),
        didResolutionMetadata: { contentType: "application/did+json" },
        didDocumentMetadata: {
          created: new Date(Number(soul.registeredAt) * 1000).toISOString(),
          deactivated: true,
        },
      }
    }

    // Fetch supplementary data in parallel
    const extProvider = provider as DIDDataProvider & { getDIDDocumentUpdatedAt?(agentId: Hex32): Promise<number> }
    const [guardians, resurrectionConfig, verificationMethods, capabilities, lineage, didDocumentCid, didDocUpdatedAt] =
      await Promise.all([
        provider.getGuardians(parsed.identifier),
        provider.getResurrectionConfig(parsed.identifier),
        provider.getVerificationMethods?.(parsed.identifier) ?? Promise.resolve([]),
        provider.getCapabilities?.(parsed.identifier) ?? Promise.resolve(0),
        provider.getLineage?.(parsed.identifier) ?? Promise.resolve(null),
        provider.getDIDDocumentCid?.(parsed.identifier) ?? Promise.resolve(null),
        extProvider.getDIDDocumentUpdatedAt?.(parsed.identifier) ?? Promise.resolve(0),
      ])

    const builderInput: BuilderInput = {
      chainId: parsed.chainId,
      soul,
      guardians,
      resurrectionConfig: resurrectionConfig ?? undefined,
      verificationMethods: verificationMethods.length > 0 ? verificationMethods : undefined,
      capabilities: capabilities > 0 ? capabilities : undefined,
      lineage: lineage ?? undefined,
      didDocumentCid: didDocumentCid ?? undefined,
    }

    const didDocument = buildDIDDocument(builderInput)

    const metadata: DIDResolutionResult["didDocumentMetadata"] = {
      created: new Date(Number(soul.registeredAt) * 1000).toISOString(),
      deactivated: false,
    }

    // Use the most recent of lastBackupAt and didDocumentUpdatedAt
    const lastBackup = Number(soul.lastBackupAt)
    const lastDocUpdate = didDocUpdatedAt ?? 0
    const lastUpdate = Math.max(lastBackup, lastDocUpdate)
    if (lastUpdate > 0) {
      metadata.updated = new Date(lastUpdate * 1000).toISOString()
    }

    return {
      didDocument,
      didResolutionMetadata: { contentType: "application/did+json" },
      didDocumentMetadata: metadata,
    }
  }

  return { resolve, parseDID }
}
