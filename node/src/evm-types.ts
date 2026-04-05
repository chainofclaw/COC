/**
 * Engine-agnostic EVM types.
 *
 * These types decouple the public API from any specific EVM implementation
 * (EthereumJS, revm, evmone). All engine-specific types should stay internal
 * to the engine implementation; consumers use these shared types only.
 */

/** Supported EVM hardfork versions */
export type EvmHardfork = "shanghai" | "cancun" | "prague"

/** Hardfork schedule entry for config */
export interface EvmHardforkScheduleEntry {
  blockNumber: number
  hardfork: EvmHardfork
}

/** Block-scoped execution environment, pre-computed once per block */
export interface EvmBlockEnv {
  readonly blockNumber: bigint
  readonly timestamp: bigint
  readonly baseFeePerGas: bigint
  readonly excessBlobGas?: bigint
  readonly parentBeaconBlockRoot?: Uint8Array
  /** Opaque engine-internal handle — do not inspect */
  readonly _internal: unknown
}

/** Parameters for eth_call / eth_estimateGas */
export interface CallParams {
  from?: string
  to: string
  data?: string
  value?: string
  gas?: string
}

/** Result of eth_call */
export interface CallResult {
  returnValue: string
  gasUsed: bigint
  failed?: boolean
}
