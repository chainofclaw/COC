import { rpcCall } from '@/lib/rpc'
import { RPC_URL, WS_URL } from '@/lib/provider'

export const dynamic = 'force-dynamic'

interface NodeInfo {
  clientVersion: string
  chainId: number
  blockHeight: number | string
  mempool: { size: number; senders: number; oldestMs: number }
  uptime: number
  nodeVersion: string
  platform: string
  arch: string
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  parts.push(`${mins}m`)
  return parts.join(' ')
}

export default async function NetworkPage() {
  const [nodeInfo, gasPrice, syncing, peerCount, protocolVersion] = await Promise.all([
    rpcCall<NodeInfo>('coc_nodeInfo').catch(() => null),
    rpcCall<string>('eth_gasPrice').catch(() => '0x0'),
    rpcCall<boolean | object>('eth_syncing').catch(() => false),
    rpcCall<string>('net_peerCount').catch(() => '0x0'),
    rpcCall<string>('eth_protocolVersion').catch(() => 'unknown'),
  ])

  const blockHeight = nodeInfo
    ? typeof nodeInfo.blockHeight === 'string'
      ? parseInt(String(nodeInfo.blockHeight), 16)
      : Number(nodeInfo.blockHeight)
    : 0

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Network Status</h2>

      {/* Node info */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <InfoCard label="Client Version" value={nodeInfo?.clientVersion ?? 'N/A'} />
        <InfoCard label="Block Height" value={blockHeight.toLocaleString()} />
        <InfoCard label="Chain ID" value={nodeInfo ? `${nodeInfo.chainId} (0x${nodeInfo.chainId.toString(16)})` : 'N/A'} />
        <InfoCard label="Peers" value={parseInt(peerCount, 16).toString()} />
        <InfoCard label="Gas Price" value={`${(parseInt(gasPrice, 16) / 1e9).toFixed(0)} Gwei`} />
        <InfoCard label="Protocol Version" value={protocolVersion} />
        <InfoCard
          label="Syncing"
          value={syncing === false ? 'Synced' : 'Syncing...'}
          highlight={syncing !== false}
        />
        <InfoCard label="Uptime" value={nodeInfo ? formatUptime(nodeInfo.uptime) : 'N/A'} />
      </div>

      {/* Runtime info */}
      {nodeInfo && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Runtime</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Node.js Version</dt>
              <dd className="mt-1 text-sm font-mono">{nodeInfo.nodeVersion}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Platform</dt>
              <dd className="mt-1 text-sm font-mono">{nodeInfo.platform} / {nodeInfo.arch}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Uptime</dt>
              <dd className="mt-1 text-sm font-mono">{formatUptime(nodeInfo.uptime)}</dd>
            </div>
          </div>
        </div>
      )}

      {/* Mempool stats */}
      {nodeInfo && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Mempool</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Pending Txs</dt>
              <dd className="mt-1 text-2xl font-bold text-yellow-600">{nodeInfo.mempool.size}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Unique Senders</dt>
              <dd className="mt-1 text-2xl font-bold">{nodeInfo.mempool.senders}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Oldest Tx Age</dt>
              <dd className="mt-1 text-2xl font-bold">
                {nodeInfo.mempool.oldestMs > 0
                  ? formatUptime(Math.floor((Date.now() - nodeInfo.mempool.oldestMs) / 1000))
                  : '-'}
              </dd>
            </div>
          </div>
        </div>
      )}

      {/* Connection endpoints */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="font-semibold text-blue-900 mb-3">Connection Endpoints</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium w-28">HTTP RPC:</span>
            <code className="bg-blue-100 px-3 py-1 rounded">{RPC_URL}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium w-28">WebSocket:</span>
            <code className="bg-blue-100 px-3 py-1 rounded">{WS_URL}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium w-28">Chain ID:</span>
            <code className="bg-blue-100 px-3 py-1 rounded">{nodeInfo ? nodeInfo.chainId : 18780}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium w-28">Network:</span>
            <code className="bg-blue-100 px-3 py-1 rounded">ChainOfClaw (COC)</code>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-xs font-medium text-gray-500 uppercase">{label}</div>
      <div className={`mt-1 text-lg font-bold ${highlight ? 'text-yellow-600' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  )
}
