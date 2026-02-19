import Link from 'next/link'
import { rpcCall } from '@/lib/rpc'
import { formatAddress } from '@/lib/provider'

export const dynamic = 'force-dynamic'

interface DaoStats {
  enabled: boolean
  activeValidators: number
  totalStake: string
  pendingProposals: number
  totalProposals: number
  currentEpoch: string
  treasuryBalance: string
  factions: Record<string, { members: number; totalStake: string }> | null
}

interface ProposalItem {
  id: string
  type: string
  targetId: string
  targetAddress: string | null
  stakeAmount: string | null
  proposer: string
  createdAtEpoch: string
  expiresAtEpoch: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  voteCount: number
}

export default async function GovernancePage() {
  const [daoStats, proposals] = await Promise.all([
    rpcCall<DaoStats>('coc_getDaoStats').catch(() => null),
    rpcCall<ProposalItem[]>('coc_getDaoProposals').catch(() => []),
  ])

  const governanceEnabled = daoStats?.enabled ?? false

  if (!governanceEnabled) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-bold mb-4">DAO Governance</h2>
        <p className="text-gray-500">Governance is not enabled on this network.</p>
      </div>
    )
  }

  const totalStake = daoStats ? BigInt(daoStats.totalStake) : 0n
  const treasuryBalance = daoStats ? BigInt(daoStats.treasuryBalance) : 0n
  const currentEpoch = daoStats ? parseInt(daoStats.currentEpoch, 16) : 0

  const pendingProposals = (proposals ?? []).filter(p => p.status === 'pending')
  const pastProposals = (proposals ?? []).filter(p => p.status !== 'pending')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">DAO Governance</h2>
        <span className="text-sm text-gray-500">Epoch: #{currentEpoch.toLocaleString()}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active Validators" value={String(daoStats?.activeValidators ?? 0)} />
        <StatCard label="Total Stake" value={`${formatStake(totalStake)} COC`} />
        <StatCard label="Treasury" value={`${formatStake(treasuryBalance)} COC`} />
        <StatCard
          label="Proposals"
          value={`${daoStats?.pendingProposals ?? 0} pending / ${daoStats?.totalProposals ?? 0} total`}
        />
      </div>

      {/* Faction breakdown */}
      {daoStats?.factions && Object.keys(daoStats.factions).length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-xl font-bold mb-4">Factions</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(daoStats.factions).map(([name, data]) => (
              <div key={name} className="border rounded-lg p-4">
                <div className="text-sm font-medium text-gray-500 capitalize">{name}</div>
                <div className="mt-1 text-lg font-bold">{data.members} members</div>
                {data.totalStake && (
                  <div className="text-xs text-gray-400 font-mono">
                    {formatStake(BigInt(data.totalStake))} COC
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active proposals */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <h3 className="text-xl font-bold p-6 pb-2">
          Active Proposals
          {pendingProposals.length > 0 && (
            <span className="ml-2 px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded text-sm font-medium">
              {pendingProposals.length}
            </span>
          )}
        </h3>
        {pendingProposals.length === 0 ? (
          <p className="px-6 pb-6 text-gray-500">No active proposals.</p>
        ) : (
          <ProposalTable proposals={pendingProposals} currentEpoch={currentEpoch} />
        )}
      </div>

      {/* Past proposals */}
      {pastProposals.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <h3 className="text-xl font-bold p-6 pb-2">Past Proposals</h3>
          <ProposalTable proposals={pastProposals} currentEpoch={currentEpoch} />
        </div>
      )}
    </div>
  )
}

function ProposalTable({ proposals, currentEpoch }: { proposals: ProposalItem[]; currentEpoch: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Target</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Proposer</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Votes</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Epoch</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {proposals.map((p) => {
            const created = parseInt(p.createdAtEpoch, 16)
            const expires = parseInt(p.expiresAtEpoch, 16)
            return (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-mono font-medium">{p.id}</td>
                <td className="px-4 py-3 text-sm">
                  <TypeBadge type={p.type} />
                </td>
                <td className="px-4 py-3 text-sm font-mono truncate max-w-[160px]">
                  {p.targetAddress ? (
                    <Link href={`/address/${p.targetAddress}`} className="text-blue-600 hover:text-blue-800">
                      {formatAddress(p.targetAddress)}
                    </Link>
                  ) : (
                    <span className="text-gray-500">{p.targetId}</span>
                  )}
                  {p.stakeAmount && (
                    <div className="text-xs text-gray-400">{formatStake(BigInt(p.stakeAmount))} COC</div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm font-mono">
                  {formatAddress(p.proposer)}
                </td>
                <td className="px-4 py-3 text-sm font-mono">{p.voteCount}</td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  <span className="font-mono">#{created}</span>
                  <span className="text-gray-300 mx-1">&rarr;</span>
                  <span className="font-mono">#{expires}</span>
                  {p.status === 'pending' && currentEpoch < expires && (
                    <div className="text-xs text-yellow-600">{expires - currentEpoch} epochs left</div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm">
                  <StatusBadge status={p.status} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    add_validator: 'bg-green-100 text-green-700',
    remove_validator: 'bg-red-100 text-red-700',
    update_stake: 'bg-blue-100 text-blue-700',
  }
  const labels: Record<string, string> = {
    add_validator: 'Add Validator',
    remove_validator: 'Remove Validator',
    update_stake: 'Update Stake',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {labels[type] ?? type}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    approved: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
    expired: 'bg-gray-100 text-gray-500',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-xs font-medium text-gray-500 uppercase">{label}</div>
      <div className="mt-1 text-xl font-bold text-gray-900">{value}</div>
    </div>
  )
}

function formatStake(wei: bigint): string {
  const ether = Number(wei) / 1e18
  if (ether >= 1_000_000) return `${(ether / 1_000_000).toFixed(1)}M`
  if (ether >= 1_000) return `${(ether / 1_000).toFixed(1)}K`
  if (ether >= 1) return ether.toFixed(2)
  if (ether > 0) return ether.toFixed(6)
  return '0'
}
