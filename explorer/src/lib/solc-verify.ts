/**
 * Solidity source code verification.
 * Compiles source with solc-js and compares bytecode against on-chain deployment.
 *
 * The solc compile step is CPU-bound and synchronous; running it on the
 * Next.js request thread blocks the event loop for the whole process. It is
 * therefore offloaded to a worker thread with a hard wall-clock deadline —
 * `worker.terminate()` stops a runaway compile regardless of its internal
 * state, which a post-hoc duration check could never do.
 */

import { Worker } from 'node:worker_threads'
import { rpcCall } from './rpc.ts'

export interface VerifyParams {
  address: string
  sourceCode: string
  compilerVersion: string
  optimize: boolean
  optimizeRuns: number
  contractName?: string
}

export interface VerifyResult {
  verified: boolean
  matchPct: number
  error?: string
  compiledBytecode?: string
  onChainBytecode?: string
}

const SOLC_REMOTE_VERSION_TAGS: Record<string, string> = {
  '0.8.28': 'v0.8.28+commit.7893614a',
  '0.8.27': 'v0.8.27+commit.40a35a09',
  '0.8.26': 'v0.8.26+commit.8a97fa7a',
  '0.8.24': 'v0.8.24+commit.e11b9ed9',
  '0.8.20': 'v0.8.20+commit.a1b79de6',
}
const SOLC_ALLOWED_VERSION_TAGS = new Set(Object.values(SOLC_REMOTE_VERSION_TAGS))
const DEFAULT_COMPILER_VERSIONS = new Set(['0.8.28', 'v0.8.28+commit.7893614a'])
const COMPILE_TIMEOUT_MS = Number(
  process.env.COC_VERIFY_COMPILE_TIMEOUT_MS ?? process.env.COC_VERIFY_COMPILE_WARN_MS ?? 15000,
)
const MAX_SOLC_SOURCE_CHARS = Number(process.env.COC_VERIFY_MAX_SOURCE_CHARS ?? 100_000)

/**
 * Worker entry executed via `new Worker(src, { eval: true })`.
 * Kept as an inline string so Next.js standalone output tracing does not
 * need to discover and copy a separate worker file.
 */
const SOLC_COMPILE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  try {
    const { solcEntry, versionTag, allowRemote, isDefault, inputJson } = workerData
    let solcModule
    try {
      solcModule = require(solcEntry)
    } catch (err) {
      parentPort.postMessage({ ok: false, code: 'solc-unavailable' })
      return
    }
    const baseSolc = solcModule.default || solcModule
    let solc = baseSolc
    const loadRemote = baseSolc.loadRemoteVersion
    if (allowRemote && typeof loadRemote === 'function') {
      const remote = await new Promise((resolve) => {
        loadRemote.call(baseSolc, versionTag, (e, snapshot) => {
          resolve(e || !snapshot ? null : snapshot)
        })
      })
      if (remote) {
        solc = remote
      } else if (!isDefault) {
        parentPort.postMessage({ ok: false, code: 'unavailable' })
        return
      }
    } else if (!isDefault) {
      parentPort.postMessage({ ok: false, code: allowRemote ? 'unavailable' : 'remote-disabled' })
      return
    }
    const outputJson = solc.compile(inputJson)
    parentPort.postMessage({ ok: true, outputJson })
  } catch (err) {
    parentPort.postMessage({ ok: false, code: 'compile-error' })
  }
})()
`

interface SolcWorkerInput {
  solcEntry: string
  versionTag: string
  allowRemote: boolean
  isDefault: boolean
  inputJson: string
}

type SolcWorkerResult =
  | { ok: true; outputJson: string }
  | { ok: false; code: 'solc-unavailable' | 'unavailable' | 'remote-disabled' | 'compile-error' }
  | { ok: false; code: 'timeout' }

/**
 * Run a solc compile in a worker thread with a hard deadline. The worker is
 * always terminated afterwards, so a hung compile cannot leak a thread.
 */
export async function compileInWorker(
  workerData: SolcWorkerInput,
  timeoutMs: number,
): Promise<SolcWorkerResult> {
  const worker = new Worker(SOLC_COMPILE_WORKER, { eval: true, workerData })
  let settled = false
  try {
    return await new Promise<SolcWorkerResult>((resolve) => {
      const finish = (result: SolcWorkerResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs)
      worker.on('message', (msg: SolcWorkerResult) => finish(msg))
      worker.on('error', () => finish({ ok: false, code: 'compile-error' }))
      worker.on('exit', (code) => {
        if (code !== 0) finish({ ok: false, code: 'compile-error' })
      })
    })
  } finally {
    await worker.terminate().catch(() => {})
  }
}

/**
 * Strip CBOR metadata suffix from bytecode for comparison.
 * Solidity appends a CBOR-encoded metadata hash at the end of bytecode.
 */
function stripMetadata(bytecode: string): string {
  const normalized = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode
  if (normalized.length < 4) return bytecode
  const metadataLengthHex = normalized.slice(-4)
  const metadataBytes = Number.parseInt(metadataLengthHex, 16)
  if (!Number.isInteger(metadataBytes) || metadataBytes <= 0) return bytecode
  const metadataHexLen = (metadataBytes + 2) * 2
  if (metadataHexLen >= normalized.length) return bytecode
  return `0x${normalized.slice(0, -metadataHexLen)}`
}

/**
 * Compute match percentage between two hex strings.
 */
function computeMatchPct(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length)
  if (minLen === 0) return 0
  let matching = 0
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) matching++
  }
  return Math.round((matching / minLen) * 100)
}

export function resolveCompilerVersionTag(compilerVersion: string): string | null {
  if (!compilerVersion) return null
  if (/^v\d+\.\d+\.\d+\+commit\.[0-9a-fA-F]+$/.test(compilerVersion)) {
    return compilerVersion
  }
  return SOLC_REMOTE_VERSION_TAGS[compilerVersion] ?? null
}

export function safeVerifyInternalErrorMessage(_error: unknown): string {
  return 'Internal verification error'
}

function allowRemoteCompilerLoad(): boolean {
  if (process.env.COC_SOLC_ALLOW_REMOTE === '1') return true
  if (process.env.COC_SOLC_ALLOW_REMOTE === '0') return false
  return process.env.NODE_ENV !== 'production'
}

/**
 * Verify a deployed contract's source code by recompiling and comparing bytecode.
 */
export async function verifyContract(params: VerifyParams): Promise<VerifyResult> {
  try {
    if (!params.sourceCode || params.sourceCode.length > MAX_SOLC_SOURCE_CHARS) {
      return { verified: false, matchPct: 0, error: 'Source code payload is too large' }
    }

    // Fetch on-chain bytecode
    const onChainBytecode = await rpcCall<string>('eth_getCode', [params.address, 'latest'])
    if (!onChainBytecode || onChainBytecode === '0x') {
      return { verified: false, matchPct: 0, error: 'No bytecode at address' }
    }

    const versionTag = resolveCompilerVersionTag(params.compilerVersion)
    if (!versionTag || !SOLC_ALLOWED_VERSION_TAGS.has(versionTag)) {
      return { verified: false, matchPct: 0, error: 'Unsupported compiler version' }
    }

    // Resolve the solc package path on the main thread so the worker can
    // require it by absolute path without any module-resolution ambiguity.
    let solcEntry: string
    try {
      const { createRequire } = await import('node:module')
      const requireFn = createRequire(import.meta.url)
      solcEntry = requireFn.resolve('solc')
    } catch {
      return { verified: false, matchPct: 0, error: 'solc compiler not available' }
    }

    // Build solc standard JSON input
    const contractName = params.contractName ?? 'Contract'
    const input = {
      language: 'Solidity',
      sources: {
        [`${contractName}.sol`]: { content: params.sourceCode },
      },
      settings: {
        optimizer: {
          enabled: params.optimize,
          runs: params.optimizeRuns,
        },
        outputSelection: {
          '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object'] },
        },
      },
    }

    const compileResult = await compileInWorker(
      {
        solcEntry,
        versionTag,
        allowRemote: allowRemoteCompilerLoad(),
        isDefault: DEFAULT_COMPILER_VERSIONS.has(params.compilerVersion),
        inputJson: JSON.stringify(input),
      },
      COMPILE_TIMEOUT_MS,
    )

    if (!compileResult.ok) {
      switch (compileResult.code) {
        case 'timeout':
          return { verified: false, matchPct: 0, error: 'Compilation exceeded server execution budget' }
        case 'unavailable':
          return { verified: false, matchPct: 0, error: 'Requested compiler version is unavailable' }
        case 'remote-disabled':
          return {
            verified: false,
            matchPct: 0,
            error: 'Remote compiler loading is disabled in this environment',
          }
        case 'solc-unavailable':
          return { verified: false, matchPct: 0, error: 'solc compiler not available' }
        default:
          return { verified: false, matchPct: 0, error: 'Internal verification error' }
      }
    }

    const output = JSON.parse(compileResult.outputJson)

    // Check for compilation errors
    if (output.errors?.some((e: { severity: string }) => e.severity === 'error')) {
      const errorMsgs = output.errors
        .filter((e: { severity: string }) => e.severity === 'error')
        .map((e: { message: string }) => e.message)
        .join('; ')
      return { verified: false, matchPct: 0, error: `Compilation failed: ${errorMsgs}` }
    }

    // Find the compiled contract
    const contracts = output.contracts?.[`${contractName}.sol`]
    if (!contracts) {
      return { verified: false, matchPct: 0, error: 'No contracts found in compilation output' }
    }

    // Try each contract in the file
    for (const [, contractOutput] of Object.entries(contracts)) {
      const compiled = (contractOutput as {
        evm?: { deployedBytecode?: { object?: string } }
      })
      const deployedBytecode = compiled.evm?.deployedBytecode?.object
      if (!deployedBytecode) continue

      const compiledHex = '0x' + deployedBytecode
      const strippedCompiled = stripMetadata(compiledHex.toLowerCase())
      const strippedOnChain = stripMetadata(onChainBytecode.toLowerCase())

      const matchPct = computeMatchPct(strippedCompiled, strippedOnChain)

      if (strippedCompiled === strippedOnChain) {
        return {
          verified: true,
          matchPct: 100,
          compiledBytecode: compiledHex,
          onChainBytecode,
        }
      }

      if (matchPct > 95) {
        return {
          verified: false,
          matchPct,
          error: 'Only partial bytecode match found',
          compiledBytecode: compiledHex,
          onChainBytecode,
        }
      }
    }

    return { verified: false, matchPct: 0, error: 'Bytecode does not match any compiled contract' }
  } catch (err) {
    return {
      verified: false,
      matchPct: 0,
      error: safeVerifyInternalErrorMessage(err),
    }
  }
}
