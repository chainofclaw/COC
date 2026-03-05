// Contract reader for PoSe v2.
// Reads challenge nonces, chain tips, and reward roots from contracts with caching.

import type { Hex32 } from "../../services/common/pose-types.ts"
import { requestJson } from "./http-client.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"

export interface ContractReaderConfig {
  l2RpcUrl: string
  poseManagerV2Address?: string
  cacheTtlMs?: number
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class ContractReader {
  private readonly config: ContractReaderConfig
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly cacheTtlMs: number

  constructor(config: ContractReaderConfig) {
    this.config = config
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000
  }

  async getChallengeNonce(epochId: bigint): Promise<bigint> {
    const key = `nonce:${epochId}`
    const cached = this.getCached<bigint>(key)
    if (cached !== undefined) return cached

    // Call challengeNonces(epochId) on the contract via eth_call
    const data = encodeFunctionCall("challengeNonces(uint64)", [epochId])
    const result = await this.ethCall(data)
    const nonce = BigInt(result)
    this.setCache(key, nonce)
    return nonce
  }

  async getChainTip(): Promise<{ hash: Hex32; number: bigint }> {
    const key = "chainTip"
    const cached = this.getCached<{ hash: Hex32; number: bigint }>(key)
    if (cached !== undefined) return cached

    const response = await this.rpcCall("eth_getBlockByNumber", ["latest", false])
    const tip = {
      hash: response.hash as Hex32,
      number: BigInt(response.number),
    }
    this.setCache(key, tip)
    return tip
  }

  async getEpochRewardRoot(epochId: bigint): Promise<Hex32> {
    const key = `rewardRoot:${epochId}`
    const cached = this.getCached<Hex32>(key)
    if (cached !== undefined) return cached

    const data = encodeFunctionCall("epochRewardRoots(uint64)", [epochId])
    const result = await this.ethCall(data)
    const root = `0x${result.slice(2).padStart(64, "0")}` as Hex32
    this.setCache(key, root)
    return root
  }

  private async ethCall(data: string): Promise<string> {
    if (!this.config.poseManagerV2Address) {
      throw new Error("poseManagerV2Address not configured")
    }
    return this.rpcCall("eth_call", [
      { to: this.config.poseManagerV2Address, data },
      "latest",
    ]) as Promise<string>
  }

  private async rpcCall(method: string, params: unknown[]): Promise<any> {
    const response = await requestJson(
      this.config.l2RpcUrl,
      "POST",
      { jsonrpc: "2.0", id: 1, method, params },
    )
    const body = response.json as { result: unknown; error?: { message: string } }
    if (body?.error) {
      throw new Error(`RPC error: ${body.error.message}`)
    }
    return body?.result
  }

  private getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value as T
  }

  private setCache(key: string, value: unknown): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    })
  }
}

// Simple ABI encoding for single-param view calls
function encodeFunctionCall(sig: string, params: bigint[]): string {
  const fnSelector = sig.slice(0, sig.indexOf("("))
  const selectorHash = simpleKeccak256(fnSelector + sig.slice(sig.indexOf("(")))
  let data = "0x" + selectorHash.slice(0, 8)
  for (const p of params) {
    data += p.toString(16).padStart(64, "0")
  }
  return data
}

function simpleKeccak256(input: string): string {
  return keccak256Hex(Buffer.from(input, "utf8"))
}
