/**
 * Solidity source code verification.
 * Compiles source with solc-js and compares bytecode against on-chain deployment.
 */

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
const COMPILE_WARN_THRESHOLD_MS = Number(process.env.COC_VERIFY_COMPILE_WARN_MS ?? 15000)
const MAX_SOLC_SOURCE_CHARS = Number(process.env.COC_VERIFY_MAX_SOURCE_CHARS ?? 100_000)

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

    // Load solc compiler — use loadRemoteVersion for specific versions, fallback to bundled
    let solc: {
      compile: (input: string) => string
    }
    try {
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const solcModule = require('solc') as {
        default?: { compile: (input: string) => string; loadRemoteVersion?: (version: string, callback: (err: Error | null, snapshot: { compile: (input: string) => string } | null) => void) => void }
        compile?: (input: string) => string
        loadRemoteVersion?: (version: string, callback: (err: Error | null, snapshot: { compile: (input: string) => string } | null) => void) => void
      }
      const baseSolc = solcModule.default ?? solcModule
      const versionTag = resolveCompilerVersionTag(params.compilerVersion)
      if (!versionTag || !SOLC_ALLOWED_VERSION_TAGS.has(versionTag)) {
        return { verified: false, matchPct: 0, error: 'Unsupported compiler version' }
      }

      solc = baseSolc as { compile: (input: string) => string }
      const loadRemote = baseSolc.loadRemoteVersion
      if (allowRemoteCompilerLoad() && loadRemote) {
        const remoteLoaded = await new Promise<{ compile: (input: string) => string } | null>((resolve) => {
          loadRemote(versionTag, (err, snapshot) => {
            if (err || !snapshot) {
              resolve(null)
            } else {
              resolve(snapshot)
            }
          })
        })
        if (remoteLoaded) {
          solc = remoteLoaded
        } else if (params.compilerVersion !== '0.8.28' && params.compilerVersion !== 'v0.8.28+commit.7893614a') {
          return { verified: false, matchPct: 0, error: 'Requested compiler version is unavailable' }
        }
      } else if (params.compilerVersion !== '0.8.28' && params.compilerVersion !== 'v0.8.28+commit.7893614a') {
        return { verified: false, matchPct: 0, error: 'Remote compiler loading is disabled in this environment' }
      }
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

    const compileStartedAt = Date.now()
    const output = JSON.parse(solc.compile(JSON.stringify(input)))
    if (Date.now() - compileStartedAt > COMPILE_WARN_THRESHOLD_MS) {
      return { verified: false, matchPct: 0, error: 'Compilation exceeded server execution budget' }
    }

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
      error: err instanceof Error ? err.message : 'Unknown verification error',
    }
  }
}
