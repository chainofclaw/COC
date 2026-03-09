export interface NodeRegisteredLogLike {
  args?: Record<string, unknown> | unknown[]
}

export interface NodeRecordLike {
  active?: boolean
  [key: string]: unknown
}

export interface NodeRegistryContractLike {
  filters: {
    NodeRegistered(): unknown
  }
  queryFilter(filter: unknown, fromBlock?: number | string, toBlock?: number | string): Promise<NodeRegisteredLogLike[]>
  getNode(nodeId: string): Promise<NodeRecordLike | unknown[] | null | undefined>
}

export interface PaginatedNodeRegistryLike extends NodeRegistryContractLike {
  getActiveNodeIds?(offset: bigint, limit: bigint): Promise<string[]>
  getActiveNodeCount?(): Promise<bigint | number>
}

const PAGE_SIZE = 200n

export async function listActiveNodeIdsPaginated(
  contract: PaginatedNodeRegistryLike,
): Promise<`0x${string}`[]> {
  if (!contract.getActiveNodeIds || !contract.getActiveNodeCount) {
    throw new Error("contract does not support paginated active node queries")
  }

  const total = BigInt(await contract.getActiveNodeCount())
  if (total === 0n) return []

  const allIds: string[] = []
  let offset = 0n
  while (offset < total) {
    const page = await contract.getActiveNodeIds(offset, PAGE_SIZE)
    if (page.length === 0) break
    allIds.push(...page)
    offset += BigInt(page.length)
  }

  return allIds
    .map((id) => id.toLowerCase() as `0x${string}`)
    .sort()
}

export async function listActiveNodeIds(contract: PaginatedNodeRegistryLike): Promise<`0x${string}`[]> {
  // Prefer paginated on-chain query when available
  if (contract.getActiveNodeIds && contract.getActiveNodeCount) {
    try {
      return await listActiveNodeIdsPaginated(contract)
    } catch {
      // Fallback to event replay on failure
    }
  }

  return listActiveNodeIdsByEvents(contract)
}

async function listActiveNodeIdsByEvents(contract: NodeRegistryContractLike): Promise<`0x${string}`[]> {
  const events = await contract.queryFilter(contract.filters.NodeRegistered(), 0, "latest")
  const uniqueNodeIds = new Set<string>()

  for (const entry of events) {
    const nodeId = extractNodeId(entry)
    if (nodeId) {
      uniqueNodeIds.add(nodeId.toLowerCase())
    }
  }

  const activeNodeIds: `0x${string}`[] = []
  for (const nodeId of [...uniqueNodeIds].sort()) {
    const record = await contract.getNode(nodeId)
    if (isNodeActive(record)) {
      activeNodeIds.push(nodeId as `0x${string}`)
    }
  }

  return activeNodeIds
}

function extractNodeId(entry: NodeRegisteredLogLike): string | null {
  const args = entry.args
  if (!args) return null
  if (Array.isArray(args)) {
    const value = args[0]
    return typeof value === "string" ? value : null
  }
  const value = args.nodeId
  return typeof value === "string" ? value : null
}

function isNodeActive(record: NodeRecordLike | unknown[] | null | undefined): boolean {
  if (!record) return false
  if (Array.isArray(record)) {
    const value = record[9]
    return value === true
  }
  if ("active" in record) {
    return record.active === true
  }
  return false
}
