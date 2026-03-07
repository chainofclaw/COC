export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  factor?: number
  jitterMs?: number
  shouldRetry?: (error: unknown, attempt: number) => boolean
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "shouldRetry" | "onRetry">> = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  factor: 2,
  jitterMs: 50,
}

export async function retryAsync<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_OPTIONS, ...options }
  let attempt = 0
  for (;;) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= cfg.retries || options.shouldRetry?.(error, attempt) === false) {
        throw error
      }
      const delayMs = Math.min(
        cfg.maxDelayMs,
        Math.round(cfg.baseDelayMs * (cfg.factor ** attempt) + Math.random() * cfg.jitterMs),
      )
      options.onRetry?.(error, attempt + 1, delayMs)
      await sleep(delayMs)
      attempt += 1
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
