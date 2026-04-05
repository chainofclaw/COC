/**
 * EVM Engine Factory.
 *
 * Selects and creates the appropriate EVM engine based on configuration.
 * Supports both EthereumJS (current default) and revm (future high-performance engine).
 */

import { EvmChain } from "./evm.ts"
import type { IEvmEngine } from "./evm-engine.ts"
import type { EvmHardfork, EvmHardforkScheduleEntry } from "./evm-types.ts"
import type { PrefundAccount } from "./types.ts"

export type EvmEngineType = "ethereumjs" | "revm"

export interface EvmEngineOpts {
  hardfork?: EvmHardfork
  hardforkSchedule?: EvmHardforkScheduleEntry[]
}

/**
 * Create an EVM engine instance.
 *
 * @param engine - Engine type: "ethereumjs" (stable) or "revm" (experimental)
 * @param chainId - EVM chain ID
 * @param stateManager - Persistent state manager (optional)
 * @param opts - Hardfork configuration
 */
export async function createEvmEngine(
  engine: EvmEngineType,
  chainId: number,
  stateManager?: unknown,
  opts?: EvmEngineOpts,
): Promise<IEvmEngine> {
  switch (engine) {
    case "ethereumjs": {
      // Map EvmHardfork string to EthereumJS Hardfork import dynamically
      const { Hardfork } = await import("@ethereumjs/common")
      const hardfork = opts?.hardfork
        ? mapHardfork(opts.hardfork, Hardfork)
        : undefined
      const schedule = opts?.hardforkSchedule?.map((e) => ({
        blockNumber: e.blockNumber,
        hardfork: mapHardfork(e.hardfork, Hardfork),
      }))
      return EvmChain.create(chainId, stateManager, {
        hardfork,
        hardforkSchedule: schedule,
      }) as Promise<IEvmEngine>
    }
    case "revm": {
      // Delegate to EthereumJS for now — revm WASM integration is stage 3+
      // When revm WASM bindings are available, replace with:
      //   const { RevmEngine } = await import("./revm-engine.ts")
      //   return RevmEngine.create(chainId, stateManager, opts)
      const { Hardfork } = await import("@ethereumjs/common")
      const hardfork = opts?.hardfork
        ? mapHardfork(opts.hardfork, Hardfork)
        : undefined
      const schedule = opts?.hardforkSchedule?.map((e) => ({
        blockNumber: e.blockNumber,
        hardfork: mapHardfork(e.hardfork, Hardfork),
      }))
      const evm = await EvmChain.create(chainId, stateManager, {
        hardfork,
        hardforkSchedule: schedule,
      })
      // Tag the engine for identification
      ;(evm as unknown as Record<string, string>)._engineType = "revm-proxy"
      return evm as IEvmEngine
    }
    default:
      throw new Error(`unsupported EVM engine: ${engine}`)
  }
}

function mapHardfork(hf: EvmHardfork, HardforkEnum: Record<string, string>): string {
  const mapping: Record<EvmHardfork, string> = {
    shanghai: HardforkEnum.Shanghai ?? "shanghai",
    cancun: HardforkEnum.Cancun ?? "cancun",
    prague: HardforkEnum.Prague ?? "prague",
  }
  return mapping[hf] ?? hf
}
