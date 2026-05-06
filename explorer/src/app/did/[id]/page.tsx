import { rpcCall } from "@/lib/rpc"

export const dynamic = "force-dynamic"

interface DIDDocument {
  "@context": string[]
  id: string
  controller?: string | string[]
  verificationMethod?: Array<{
    id: string
    type: string
    controller: string
    blockchainAccountId?: string
    publicKeyHex?: string
  }>
  authentication?: string[]
  assertionMethod?: string[]
  capabilityInvocation?: string[]
  capabilityDelegation?: string[]
  service?: Array<{
    id: string
    type: string
    serviceEndpoint: string
  }>
  cocAgent?: {
    registeredAt?: string
    version?: number
    identityCid?: string
    latestSnapshotCid?: string
    capabilities?: string[]
    lineage?: {
      parent: string | null
      forkHeight: string | null
      generation: number
    }
    reputation?: {
      poseScore: number
      epochsActive: number
      slashCount: number
    }
  }
}

interface ResolutionResult {
  didDocument: DIDDocument | null
  didResolutionMetadata: { contentType: string; error?: string }
  didDocumentMetadata: { created?: string; updated?: string; deactivated?: boolean }
}

export default async function DIDDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const agentId = id.toLowerCase().startsWith("0x") ? id.toLowerCase() : `0x${id.toLowerCase()}`

  const result = await rpcCall<ResolutionResult>("coc_resolveDid", [`did:coc:${agentId}`]).catch(() => null)

  if (!result || !result.didDocument) {
    return (
      <div className="container mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-4">DID Not Found</h1>
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-gray-600">
            No DID Document found for agent ID: <code className="font-mono text-sm bg-gray-100 px-1 rounded">{agentId}</code>
          </p>
          {result?.didResolutionMetadata?.error && (
            <p className="text-red-500 text-sm mt-2">Error: {result.didResolutionMetadata.error}</p>
          )}
        </div>
      </div>
    )
  }

  const doc = result.didDocument
  const meta = result.didDocumentMetadata

  return (
    <div className="container mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-2">DID Document</h1>
      <p className="text-gray-500 font-mono text-sm mb-6 break-all">{doc.id}</p>

      {meta.deactivated && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <span className="text-red-700 font-medium">This DID has been deactivated</span>
        </div>
      )}

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-gray-500 text-xs uppercase">Status</div>
          <div className={`text-lg font-bold ${meta.deactivated ? "text-red-600" : "text-green-600"}`}>
            {meta.deactivated ? "Deactivated" : "Active"}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-gray-500 text-xs uppercase">Version</div>
          <div className="text-lg font-bold">{doc.cocAgent?.version ?? "-"}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-gray-500 text-xs uppercase">Created</div>
          <div className="text-sm font-medium">{meta.created ? new Date(meta.created).toLocaleString() : "-"}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-gray-500 text-xs uppercase">Updated</div>
          <div className="text-sm font-medium">{meta.updated ? new Date(meta.updated).toLocaleString() : "-"}</div>
        </div>
      </div>

      {/* Verification Methods */}
      {doc.verificationMethod && doc.verificationMethod.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Verification Methods</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 pr-4">ID</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2">Account / Key</th>
                </tr>
              </thead>
              <tbody>
                {doc.verificationMethod.map((vm, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{vm.id.split("#")[1] || vm.id}</td>
                    <td className="py-2 pr-4 text-gray-600">{vm.type}</td>
                    <td className="py-2 font-mono text-xs break-all">
                      {vm.blockchainAccountId || vm.publicKeyHex || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Controllers */}
      {doc.controller && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Controllers</h2>
          <div className="space-y-1">
            {(Array.isArray(doc.controller) ? doc.controller : [doc.controller]).map((c, i) => (
              <div key={i} className="font-mono text-sm text-gray-700 break-all">{c}</div>
            ))}
          </div>
        </div>
      )}

      {/* Capabilities */}
      {doc.cocAgent?.capabilities && doc.cocAgent.capabilities.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Capabilities</h2>
          <div className="flex flex-wrap gap-2">
            {doc.cocAgent.capabilities.map((cap, i) => (
              <span key={i} className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Service Endpoints */}
      {doc.service && doc.service.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Service Endpoints</h2>
          <div className="space-y-2">
            {doc.service.map((svc, i) => (
              <div key={i} className="flex items-center gap-4 text-sm">
                <span className="font-mono text-gray-500 w-20">{svc.id.replace("#", "")}</span>
                <span className="px-2 py-0.5 bg-gray-100 rounded text-xs">{svc.type}</span>
                <span className="font-mono text-gray-700 break-all">{typeof svc.serviceEndpoint === "string" ? svc.serviceEndpoint : JSON.stringify(svc.serviceEndpoint)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lineage */}
      {doc.cocAgent?.lineage && doc.cocAgent.lineage.parent && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Lineage</h2>
          <div className="text-sm space-y-1">
            <div><span className="text-gray-500">Parent:</span> <span className="font-mono">{doc.cocAgent.lineage.parent}</span></div>
            <div><span className="text-gray-500">Generation:</span> {doc.cocAgent.lineage.generation}</div>
            {doc.cocAgent.lineage.forkHeight && (
              <div><span className="text-gray-500">Fork Height:</span> {doc.cocAgent.lineage.forkHeight}</div>
            )}
          </div>
        </div>
      )}

      {/* Raw Document */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Raw DID Document</h2>
        <pre className="bg-gray-50 p-4 rounded-lg overflow-x-auto text-xs font-mono">
          {JSON.stringify(doc, null, 2)}
        </pre>
      </div>
    </div>
  )
}
