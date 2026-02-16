// COC Testnet Faucet - Core logic
import { JsonRpcProvider, Wallet, parseEther, formatEther } from "ethers"

export interface FaucetConfig {
  rpcUrl: string
  privateKey: string
  dripAmountEth: string
  dailyGlobalLimitEth: string
  perAddressCooldownMs: number
}

interface DripRecord {
  lastDripMs: number
  count: number
}

export interface FaucetStatus {
  balance: string
  totalDrips: number
  dailyDrips: number
  dailyLimit: string
  dripAmount: string
}

export class Faucet {
  private readonly provider: JsonRpcProvider
  private readonly wallet: Wallet
  private readonly dripAmountWei: bigint
  private readonly dailyLimitWei: bigint
  private readonly cooldownMs: number

  // address → last drip record
  private readonly records = new Map<string, DripRecord>()
  private dailyDripTotal = 0n
  private dailyDripCount = 0
  private dailyResetMs = this.nextMidnight()
  private totalDrips = 0

  constructor(config: FaucetConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl)
    this.wallet = new Wallet(config.privateKey, this.provider)
    this.dripAmountWei = parseEther(config.dripAmountEth)
    this.dailyLimitWei = parseEther(config.dailyGlobalLimitEth)
    this.cooldownMs = config.perAddressCooldownMs
  }

  get address(): string {
    return this.wallet.address
  }

  async requestDrip(toAddress: string): Promise<{ txHash: string; amount: string }> {
    // Validate address format
    if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
      throw new FaucetError("Invalid address format", 400)
    }

    // Check daily reset
    this.maybeResetDaily()

    // Check per-address cooldown
    const normalized = toAddress.toLowerCase()
    const record = this.records.get(normalized)
    if (record) {
      const elapsed = Date.now() - record.lastDripMs
      if (elapsed < this.cooldownMs) {
        const remainingMs = this.cooldownMs - elapsed
        const remainingMin = Math.ceil(remainingMs / 60_000)
        throw new FaucetError(
          `Rate limited. Try again in ${remainingMin} minutes.`,
          429,
        )
      }
    }

    // Check daily global limit
    if (this.dailyDripTotal + this.dripAmountWei > this.dailyLimitWei) {
      throw new FaucetError("Daily faucet limit reached. Try again tomorrow.", 429)
    }

    // Check faucet balance
    const balance = await this.provider.getBalance(this.wallet.address)
    if (balance < this.dripAmountWei) {
      throw new FaucetError("Faucet balance too low", 503)
    }

    // Send transaction
    const tx = await this.wallet.sendTransaction({
      to: toAddress,
      value: this.dripAmountWei,
    })

    // Update records
    this.records.set(normalized, { lastDripMs: Date.now(), count: (record?.count ?? 0) + 1 })
    this.dailyDripTotal += this.dripAmountWei
    this.dailyDripCount++
    this.totalDrips++

    return {
      txHash: tx.hash,
      amount: formatEther(this.dripAmountWei),
    }
  }

  async getStatus(): Promise<FaucetStatus> {
    this.maybeResetDaily()
    const balance = await this.provider.getBalance(this.wallet.address)
    return {
      balance: formatEther(balance),
      totalDrips: this.totalDrips,
      dailyDrips: this.dailyDripCount,
      dailyLimit: formatEther(this.dailyLimitWei),
      dripAmount: formatEther(this.dripAmountWei),
    }
  }

  private maybeResetDaily(): void {
    if (Date.now() >= this.dailyResetMs) {
      this.dailyDripTotal = 0n
      this.dailyDripCount = 0
      this.dailyResetMs = this.nextMidnight()
    }
  }

  private nextMidnight(): number {
    const now = new Date()
    const tomorrow = new Date(now)
    tomorrow.setUTCHours(24, 0, 0, 0)
    return tomorrow.getTime()
  }
}

export class FaucetError extends Error {
  readonly statusCode: number
  constructor(
    message: string,
    statusCode: number,
  ) {
    super(message)
    this.name = "FaucetError"
    this.statusCode = statusCode
  }
}
