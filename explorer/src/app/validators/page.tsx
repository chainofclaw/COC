import { rpcCall } from '@/lib/rpc'

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

export default async function ValidatorsPage() {
  const data = await rpcCall<ValidatorsResponse>('coc_validators').catch(() => null)

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Validators</h2>
        <span className="text-sm text-gray-500">Block Height: #{height.toLocaleString()}</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Active Validators</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{data.validators.length}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Current Proposer</div>
          <div className="mt-1 text-lg font-bold text-green-600 font-mono truncate">{data.nextProposer}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs font-medium text-gray-500 uppercase">Consensus</div>
          <div className="mt-1 text-lg font-bold">PoSe (Round Robin)</div>
        </div>
      </div>

      {/* Validator table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Validator ID</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Next Block</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {data.validators.map((v, i) => (
              <tr key={v.id} className={`hover:bg-gray-50 ${v.isCurrentProposer ? 'bg-green-50' : ''}`}>
                <td className="px-4 py-3 text-sm text-gray-500">{i + 1}</td>
                <td className="px-4 py-3 text-sm font-mono font-medium">{v.id}</td>
                <td className="px-4 py-3 text-sm">
                  {v.isCurrentProposer ? (
                    <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium">
                      Proposing
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
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
