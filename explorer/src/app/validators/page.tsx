import Link from 'next/link'
import { rpcCall } from '@/lib/rpc'
import { formatAddress } from '@/lib/provider'

export const dynamic = 'force-dynamic'

interface ValidatorInfo {
  id: string
  isCurrentProposer: boolean
  nextProposalBlock: number
}

interface ValidatorsResponse {
  validators: ValidatorInfo[]
  currentHeight: number | string
  nextProposer: string
}

interface GovernanceValidator {
  id: string
  address: string
  stake: string
  votingPower: number
  active: boolean
  joinedAtEpoch: string
}

export default async function ValidatorsPage() {
  const [data, govValidators] = await Promise.all([
    rpcCall<ValidatorsResponse>('coc_validators').catch(() => null),
    rpcCall<GovernanceValidator[]>('coc_getValidators').catch(() => null),
  ])

  if (!data) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-bold mb-4">Validators</h2>
        <p className="text-gray-500">Unable to fetch validator data.</p>
      </div>
    )
  }

  const height = typeof data.currentHeight === 'string'
    ? parseInt(data.currentHeight, 16)
    : Number(data.currentHeight)

  // Build governance lookup by validator ID
  const govMap = new Map<string, GovernanceValidator>()
  const hasGovernance = Array.isArray(govValidators) && govValidators.length > 0
  if (hasGovernance) {
    for (const gv of govValidators) {
      govMap.set(gv.id, gv)
    }
  }

  // Calculate total stake for percentage display
  const totalStake = hasGovernance
    ? govValidators.reduce((sum, v) => sum + BigInt(v.stake), 0n)
    : 0n

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Validators</h2>
        <span className="text-sm text-gray-500">Block Height: #{height.toLocaleString()}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Active Validators</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{data.validators.length}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Current Proposer</div>
          <div className="mt-1 text-sm font-bold text-green-600 font-mono truncate">
            {/^0x[a-fA-F0-9]{40}$/.test(data.nextProposer) ? (
              <Link href={`/address/${data.nextProposer}`} className="hover:text-green-800">
                {formatAddress(data.nextProposer)}
              </Link>
            ) : data.nextProposer}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Consensus</div>
          <div className="mt-1 text-lg font-bold">
            {hasGovernance ? 'Stake-Weighted' : 'Round Robin'}
          </div>
        </div>
        {hasGovernance && totalStake > 0n && (
          <div className="bg-white rounded-lg shadow p-4">
            <div className="text-xs font-medium text-gray-500 uppercase">Total Stake</div>
            <div className="mt-1 text-lg font-bold text-purple-600">
              {formatStake(totalStake)} COC
            </div>
          </div>
        )}
      </div>

      {/* Validator table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Validator</th>
              {hasGovernance && (
                <>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Address</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stake</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Voting Power</th>
                </>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Next Block</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data.validators.map((v, i) => {
              const gov = govMap.get(v.id)
              const stake = gov ? BigInt(gov.stake) : 0n
              const stakePercent = totalStake > 0n && stake > 0n
                ? Number((stake * 10000n) / totalStake) / 100
                : 0

              return (
                <tr key={v.id} className={`hover:bg-gray-50 ${v.isCurrentProposer ? 'bg-green-50' : ''}`}>
                  <td className="px-4 py-3 text-sm text-gray-500">{i + 1}</td>
                  <td className="px-4 py-3 text-sm font-mono font-medium truncate max-w-[200px]">
                    {v.id}
                  </td>
                  {hasGovernance && (
                    <>
                      <td className="px-4 py-3 text-sm">
                        {gov?.address ? (
                          <Link href={`/address/${gov.address}`} className="text-blue-600 hover:text-blue-800 font-mono">
                            {formatAddress(gov.address)}
                          </Link>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {stake > 0n ? (
                          <div className="space-y-1">
                            <span className="font-mono font-medium">{formatStake(stake)} COC</span>
                            <div className="flex items-center gap-2">
                              <div className="w-20 bg-gray-200 rounded-full h-1.5">
                                <div
                                  className="bg-purple-600 h-1.5 rounded-full"
                                  style={{ width: `${Math.min(100, stakePercent)}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-400">{stakePercent.toFixed(1)}%</span>
                            </div>
                          </div>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">
                        {gov?.votingPower != null ? gov.votingPower.toFixed(2) : '-'}
                      </td>
                    </>
                  )}
                  <td className="px-4 py-3 text-sm">
                    {v.isCurrentProposer ? (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium">
                        Proposing
                      </span>
                    ) : gov && !gov.active ? (
                      <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-medium">
                        Inactive
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs font-medium">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm font-mono">
                    #{v.nextProposalBlock.toLocaleString()}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatStake(wei: bigint): string {
  const ether = Number(wei) / 1e18
  if (ether >= 1_000_000) return `${(ether / 1_000_000).toFixed(1)}M`
  if (ether >= 1_000) return `${(ether / 1_000).toFixed(1)}K`
  if (ether >= 1) return ether.toFixed(2)
  return ether.toFixed(6)
}
