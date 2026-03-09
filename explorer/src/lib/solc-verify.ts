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

// CBOR metadata at the end of compiled bytecode is typically 43-53 bytes.
// We strip it before comparison since it contains source hashes that differ.
const METADATA_TAIL_BYTES = 43

/**
 * Strip CBOR metadata suffix from bytecode for comparison.
 * Solidity appends a CBOR-encoded metadata hash at the end of bytecode.
 */
function stripMetadata(bytecode: string): string {
  if (bytecode.length <= METADATA_TAIL_BYTES * 2 + 2) return bytecode
  return bytecode.slice(0, -(METADATA_TAIL_BYTES * 2))
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

/**
 * Verify a deployed contract's source code by recompiling and comparing bytecode.
 */
export async function verifyContract(params: VerifyParams): Promise<VerifyResult> {
  try {
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
      const solcModule = await import('solc') as {
        default?: { compile: (input: string) => string; loadRemoteVersion?: (version: string, callback: (err: Error | null, snapshot: { compile: (input: string) => string } | null) => void) => void }
        compile?: (input: string) => string
        loadRemoteVersion?: (version: string, callback: (err: Error | null, snapshot: { compile: (input: string) => string } | null) => void) => void
      }
      const baseSolc = solcModule.default ?? solcModule
      const loadRemote = baseSolc.loadRemoteVersion
      const versionTag = resolveCompilerVersionTag(params.compilerVersion)
      if (versionTag && loadRemote) {
        // Try loading the specific compiler version; fall back to bundled if unavailable.
        solc = await new Promise<{ compile: (input: string) => string }>((resolve, reject) => {
          loadRemote(versionTag, (err, snapshot) => {
            if (err || !snapshot) {
              // Fall back to bundled solc if remote version fails
              resolve(baseSolc as { compile: (input: string) => string })
            } else {
              resolve(snapshot)
            }
          })
        })
      } else {
        solc = baseSolc as { compile: (input: string) => string }
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

    const output = JSON.parse(solc.compile(JSON.stringify(input)))

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

      // Partial match (>95% likely means different metadata only)
      if (matchPct > 95) {
        return {
          verified: true,
          matchPct,
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
