import { RLP } from "@ethereumjs/rlp"
import { Trie } from "@ethereumjs/trie"
import { KECCAK256_RLP, bytesToHex, hexToBytes } from "@ethereumjs/util"
import { Bloom, encodeReceipt } from "@ethereumjs/vm"
import { Transaction } from "ethers"
import { genesisBaseFee } from "./base-fee.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

export interface ReceiptLogLike {
  address: string
  topics: string[]
  data: string
}

export interface ReceiptLike {
  transactionHash: string
  gasUsed: bigint | string
  status: bigint | string | number
  logs?: ReceiptLogLike[]
  logsBloom?: string
}

export interface BlockHeaderView {
  logsBloom: Hex
  transactionsRoot: Hex
  receiptsRoot: Hex
  gasUsed: bigint
  stateRoot: Hex
  baseFeePerGas: bigint
}

export async function buildBlockHeaderView(
  block: ChainBlock,
  receipts: ReceiptLike[],
): Promise<BlockHeaderView> {
  const logsBloom = aggregateBlockLogsBloom(receipts)
  const transactionsRoot = await computeTransactionsRoot(block.txs)
  const receiptsRoot = await computeReceiptsRoot(block.txs, receipts)
  const gasUsed = aggregateGasUsed(receipts, block)
  return {
    logsBloom,
    transactionsRoot,
    receiptsRoot,
    gasUsed,
    stateRoot: (block.stateRoot ?? (`0x${"0".repeat(64)}`)) as Hex,
    baseFeePerGas: block.baseFee ?? genesisBaseFee(),
  }
}

export async function computeTransactionsRoot(rawTxs: Hex[]): Promise<Hex> {
  if (rawTxs.length === 0) {
    return bytesToHex(KECCAK256_RLP) as Hex
  }

  const trie = new Trie()
  for (const [index, rawTx] of rawTxs.entries()) {
    await trie.put(RLP.encode(index), Buffer.from(rawTx.slice(2), "hex"))
  }
  return bytesToHex(trie.root()) as Hex
}

export async function computeReceiptsRoot(rawTxs: Hex[], receipts: ReceiptLike[]): Promise<Hex> {
  if (rawTxs.length === 0) {
    return bytesToHex(KECCAK256_RLP) as Hex
  }

  const trie = new Trie()
  const receiptsByHash = new Map(
    receipts.map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]),
  )
  let cumulativeGasUsed = 0n

  for (const [index, rawTx] of rawTxs.entries()) {
    const parsed = Transaction.from(rawTx)
    const txHash = parsed.hash.toLowerCase()
    const receipt = receiptsByHash.get(txHash) ?? receipts[index]
    if (!receipt) {
      continue
    }
    cumulativeGasUsed += normalizeBigInt(receipt.gasUsed)
    const encoded = encodeReceipt({
      status: normalizeStatus(receipt.status),
      cumulativeBlockGasUsed: cumulativeGasUsed,
      bitvector: bloomBytesForReceipt(receipt),
      logs: normalizeReceiptLogs(receipt.logs ?? []),
    } as any, Number(parsed.type ?? 0) as any)
    await trie.put(RLP.encode(index), encoded)
  }

  return bytesToHex(trie.root()) as Hex
}

export function aggregateBlockLogsBloom(receipts: ReceiptLike[]): Hex {
  const bloom = new Bloom()
  for (const receipt of receipts) {
    bloom.or(new Bloom(bloomBytesForReceipt(receipt)))
  }
  return bytesToHex(bloom.bitvector) as Hex
}

function aggregateGasUsed(receipts: ReceiptLike[], block: ChainBlock): bigint {
  if (receipts.length === 0) {
    return block.gasUsed ?? BigInt(block.txs.length * 21_000)
  }
  return receipts.reduce((sum, receipt) => sum + normalizeBigInt(receipt.gasUsed), 0n)
}

function normalizeStatus(value: bigint | string | number): number {
  if (typeof value === "bigint") return value === 0n ? 0 : 1
  if (typeof value === "number") return value === 0 ? 0 : 1
  const trimmed = value.trim().toLowerCase()
  if (trimmed === "0x0" || trimmed === "0") return 0
  return 1
}

function normalizeBigInt(value: bigint | string): bigint {
  if (typeof value === "bigint") return value
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return BigInt(value)
  }
  return BigInt(value)
}

function bloomBytesForReceipt(receipt: ReceiptLike): Uint8Array {
  if (typeof receipt.logsBloom === "string" && /^0x[0-9a-fA-F]{512}$/.test(receipt.logsBloom)) {
    return hexToBytes(receipt.logsBloom)
  }

  const bloom = new Bloom()
  for (const log of receipt.logs ?? []) {
    if (/^0x[0-9a-fA-F]+$/.test(log.address)) {
      bloom.add(hexToBytes(log.address))
    }
    for (const topic of log.topics ?? []) {
      if (/^0x[0-9a-fA-F]+$/.test(topic)) {
        bloom.add(hexToBytes(topic))
      }
    }
  }
  return bloom.bitvector
}

function normalizeReceiptLogs(logs: ReceiptLogLike[]): Array<[Uint8Array, Uint8Array[], Uint8Array]> {
  return logs.map((log) => ([
    hexToBytes(log.address),
    log.topics.map((topic) => hexToBytes(topic)),
    hexToBytes(log.data),
  ]))
}
