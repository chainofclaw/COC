import Link from 'next/link'
import { provider, formatEther, formatAddress } from '@/lib/provider'
import { rpcCall, getTransactionsByAddress } from '@/lib/rpc'
import { TxHistory } from '@/components/TxHistory'
import { ContractView } from '@/components/ContractView'
import { notFound } from 'next/navigation'

export const dynamic = 'force-dynamic'

interface AddressPageProps {
  params: Promise<{ address: string }>
}

interface ContractMeta {
  address: string
  creator: string
  blockNumber: string
  txHash: string
  deployedAt: number
}

export default async function AddressPage({ params }: AddressPageProps) {
  const { address } = await params

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    notFound()
  }

  const [balance, txCount, code, txs] = await Promise.all([
    provider.getBalance(address),
    provider.getTransactionCount(address),
    provider.getCode(address),
    getTransactionsByAddress(address, 100).catch(() => []),
  ])

  const isContract = code !== '0x'

  // Fetch contract deployment info if this is a contract
  let contractMeta: ContractMeta | null = null
  if (isContract) {
    contractMeta = await rpcCall<ContractMeta | null>('coc_getContractInfo', [address]).catch(() => null)
  }

  return (
    <div className="space-y-6">
      {/* Address overview */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold">Address</h2>
          {isContract && (
            <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded text-sm font-medium">
              Contract
            </span>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <dt className="text-sm font-medium text-gray-500">Address</dt>
            <dd className="mt-1 text-sm font-mono break-all">{address}</dd>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500">Balance</dt>
              <dd className="mt-1 text-lg font-bold text-blue-600">{formatEther(balance)}</dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-gray-500">Nonce</dt>
              <dd className="mt-1 text-lg font-bold">{txCount}</dd>
            </div>

            <div>
              <dt className="text-sm font-medium text-gray-500">Transactions</dt>
              <dd className="mt-1 text-lg font-bold">{txs.length}</dd>
            </div>
          </div>
        </div>
      </div>

      {/* Contract deployment info */}
      {isContract && contractMeta && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-bold mb-4">Contract Info</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="font-medium text-gray-500">Creator</dt>
              <dd className="mt-1 font-mono">
                <Link href={`/address/${contractMeta.creator}`} className="text-blue-600 hover:text-blue-800">
                  {formatAddress(contractMeta.creator)}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-gray-500">Deploy Tx</dt>
              <dd className="mt-1 font-mono">
                <Link href={`/tx/${contractMeta.txHash}`} className="text-blue-600 hover:text-blue-800">
                  {contractMeta.txHash.slice(0, 18)}...
                </Link>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-gray-500">Deploy Block</dt>
              <dd className="mt-1">
                <Link href={`/block/${parseInt(contractMeta.blockNumber, 16)}`} className="text-blue-600 hover:text-blue-800">
                  #{parseInt(contractMeta.blockNumber, 16).toLocaleString()}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-gray-500">Bytecode Size</dt>
              <dd className="mt-1 font-mono">{((code.length - 2) / 2).toLocaleString()} bytes</dd>
            </div>
          </div>
        </div>
      )}

      {/* Transaction history */}
      <TxHistory address={address} initialTxs={txs} />

      {/* Contract section */}
      {isContract && <ContractView address={address} code={code} />}
    </div>
  )
}
