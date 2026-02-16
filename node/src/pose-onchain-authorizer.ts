import { Contract, JsonRpcProvider, isAddress } from "ethers"
import { createLogger } from "./logger.ts"

const log = createLogger("pose-onchain-authorizer")

const POSE_MANAGER_ABI = [
  "function operatorNodeCount(address) view returns (uint8)",
] as const

export interface OnchainOperatorResolverOptions {
  rpcUrl: string
  poseManagerAddress: string
  minOperatorNodes?: number
  timeoutMs?: number
  operatorNodeCountFn?: (operator: string) => Promise<number | bigint>
}

const DEFAULT_TIMEOUT_MS = 3_000

export function createOnchainOperatorResolver(
  options: OnchainOperatorResolverOptions,
): (senderId: string) => Promise<boolean> {
  const minOperatorNodes = options.minOperatorNodes ?? 1
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!Number.isInteger(minOperatorNodes) || minOperatorNodes < 1) {
    throw new Error("invalid minOperatorNodes")
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error("invalid timeoutMs")
  }

  let operatorNodeCountFn = options.operatorNodeCountFn
  if (!operatorNodeCountFn) {
    if (!options.rpcUrl || options.rpcUrl.trim().length === 0) {
      throw new Error("missing rpcUrl for on-chain challenger authorizer")
    }
    if (!isAddress(options.poseManagerAddress)) {
      throw new Error("invalid poseManagerAddress for on-chain challenger authorizer")
    }
    const provider = new JsonRpcProvider(options.rpcUrl)
    const contract = new Contract(options.poseManagerAddress, POSE_MANAGER_ABI, provider)
    operatorNodeCountFn = async (operator: string): Promise<number | bigint> => {
      return await contract.operatorNodeCount(operator)
    }
  }

  return async (senderId: string): Promise<boolean> => {
    if (!isAddress(senderId)) return false

    try {
      const rawCount = await withTimeout(operatorNodeCountFn!(senderId), timeoutMs)
      const count = Number(rawCount)
      if (!Number.isFinite(count) || count < 0) return false
      return count >= minOperatorNodes
    } catch (error) {
      log.warn("on-chain operator authorization query failed", {
        senderId,
        error: String(error),
      })
      throw error
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("on-chain operator authorization timeout"))
    }, timeoutMs)

    promise.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
