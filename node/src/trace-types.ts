export interface TraceStep {
  pc: number
  op: string
  gas: string
  gasCost: string
  depth: number
  stack: string[]
  memory: string[]
  storage: Record<string, string>
}

export interface TransactionTrace {
  gas: number
  failed: boolean
  returnValue: string
  structLogs: TraceStep[]
}

export interface TraceOptions {
  disableStorage?: boolean
  disableMemory?: boolean
  disableStack?: boolean
  tracer?: string
}

export interface CallTrace {
  type: string
  from: string
  to: string
  value: string
  gas: string
  gasUsed: string
  input: string
  output: string
  error?: string
  revertReason?: string
  traceAddress?: number[]
  subtraces?: number
  logs?: Array<{
    address: string
    topics: string[]
    data: string
  }>
}

export interface RpcAccessListItem {
  address: string
  storageKeys: string[]
}

export interface CallTraceResult {
  returnValue: string
  gasUsed: bigint
  failed: boolean
  trace: TransactionTrace
  callTraces: CallTrace[]
  accessList: RpcAccessListItem[]
  stateDiff?: Record<string, unknown>
  prestate?: Record<string, unknown>
  poststate?: Record<string, unknown>
}

export interface TxTraceResult {
  txHash: string
  gasUsed: bigint
  success: boolean
  failed: boolean
  returnValue: string
  trace: TransactionTrace
  callTraces: CallTrace[]
  accessList: RpcAccessListItem[]
  stateDiff?: Record<string, unknown>
  prestate?: Record<string, unknown>
  poststate?: Record<string, unknown>
}
