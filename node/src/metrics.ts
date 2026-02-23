// Prometheus-compatible metrics collector for COC node
// Outputs metrics in Prometheus text exposition format

export interface MetricsSource {
  getBlockHeight: () => number | bigint | Promise<number | bigint>
  getLastBlockTimestamp?: () => number
  getPreviousBlockTimestamp?: () => number
  getTxPoolPending: () => number
  getTxPoolQueued: () => number
  getPeersConnected: () => number
  getWireConnections?: () => number
  getBftRoundHeight?: () => number | bigint
  getConsensusState?: () => "healthy" | "degraded" | "recovering"
  getDhtPeers?: () => number
  getP2PAuthRejected?: () => number
}

interface CounterEntry {
  value: number
  help: string
}

interface GaugeEntry {
  value: number
  help: string
}

interface HistogramEntry {
  sum: number
  count: number
  buckets: Map<number, number>
  help: string
}

export class MetricsCollector {
  private counters = new Map<string, CounterEntry>()
  private gauges = new Map<string, GaugeEntry>()
  private histograms = new Map<string, HistogramEntry>()
  private source: MetricsSource | null = null
  private startTime = Date.now()

  setSource(source: MetricsSource): void {
    this.source = source
  }

  incCounter(name: string, help: string, delta = 1): void {
    const existing = this.counters.get(name)
    if (existing) {
      this.counters.set(name, { ...existing, value: existing.value + delta })
    } else {
      this.counters.set(name, { value: delta, help })
    }
  }

  setGauge(name: string, help: string, value: number): void {
    this.gauges.set(name, { value, help })
  }

  observeHistogram(name: string, help: string, value: number, bucketBounds: number[]): void {
    const existing = this.histograms.get(name)
    // Find the smallest bucket bound that fits this value; overflow goes to largest bucket
    const sorted = bucketBounds.slice().sort((a, b) => a - b)
    const targetBound = sorted.find((b) => value <= b) ?? sorted[sorted.length - 1]
    if (existing) {
      const updated = {
        ...existing,
        sum: existing.sum + value,
        count: existing.count + 1,
        buckets: new Map(existing.buckets),
      }
      if (targetBound !== undefined) {
        updated.buckets.set(targetBound, (updated.buckets.get(targetBound) ?? 0) + 1)
      }
      this.histograms.set(name, updated)
    } else {
      const buckets = new Map<number, number>()
      for (const bound of bucketBounds) {
        buckets.set(bound, bound === targetBound ? 1 : 0)
      }
      this.histograms.set(name, { sum: value, count: 1, buckets, help })
    }
  }

  async collect(): Promise<void> {
    if (!this.source) return

    const height = await Promise.resolve(this.source.getBlockHeight())
    this.setGauge("coc_block_height", "Current block height", Number(height))

    this.setGauge("coc_tx_pool_pending", "Pending transactions in mempool", this.source.getTxPoolPending())
    this.setGauge("coc_tx_pool_queued", "Queued transactions in mempool", this.source.getTxPoolQueued())
    this.setGauge("coc_peers_connected", "Number of connected P2P peers", this.source.getPeersConnected())

    if (this.source.getWireConnections) {
      this.setGauge("coc_wire_connections", "Number of wire protocol connections", this.source.getWireConnections())
    }

    if (this.source.getBftRoundHeight) {
      this.setGauge("coc_bft_round_height", "Current BFT round height", Number(this.source.getBftRoundHeight()))
    }

    if (this.source.getConsensusState) {
      const stateMap = { healthy: 0, degraded: 1, recovering: 2 }
      const state = this.source.getConsensusState()
      this.setGauge("coc_consensus_state", "Consensus state (0=healthy, 1=degraded, 2=recovering)", stateMap[state] ?? -1)
    }

    if (this.source.getDhtPeers) {
      this.setGauge("coc_dht_peers_total", "Number of DHT routing table peers", this.source.getDhtPeers())
    }

    if (this.source.getP2PAuthRejected) {
      this.setGauge("coc_p2p_auth_rejected_total", "Total P2P auth rejected requests", this.source.getP2PAuthRejected())
    }

    // Block time histogram
    if (this.source.getLastBlockTimestamp && this.source.getPreviousBlockTimestamp) {
      const last = this.source.getLastBlockTimestamp()
      const prev = this.source.getPreviousBlockTimestamp()
      if (last > 0 && prev > 0) {
        const intervalSec = (last - prev) / 1000
        this.observeHistogram(
          "coc_block_time_seconds",
          "Block production interval in seconds",
          intervalSec,
          [1, 2, 3, 5, 10, 30, 60],
        )
      }
    }

    // Process metrics
    const mem = process.memoryUsage()
    this.setGauge("coc_process_memory_bytes", "Process RSS memory in bytes", mem.rss)
    this.setGauge("coc_process_heap_bytes", "Process heap used in bytes", mem.heapUsed)
    this.setGauge("coc_uptime_seconds", "Process uptime in seconds", (Date.now() - this.startTime) / 1000)
  }

  serialize(): string {
    const lines: string[] = []

    for (const [name, entry] of this.gauges) {
      lines.push(`# HELP ${name} ${entry.help}`)
      lines.push(`# TYPE ${name} gauge`)
      lines.push(`${name} ${entry.value}`)
    }

    for (const [name, entry] of this.counters) {
      lines.push(`# HELP ${name} ${entry.help}`)
      lines.push(`# TYPE ${name} counter`)
      lines.push(`${name} ${entry.value}`)
    }

    for (const [name, entry] of this.histograms) {
      lines.push(`# HELP ${name} ${entry.help}`)
      lines.push(`# TYPE ${name} histogram`)
      const sortedBounds = [...entry.buckets.keys()].sort((a, b) => a - b)
      let cumulative = 0
      for (const bound of sortedBounds) {
        cumulative += entry.buckets.get(bound) ?? 0
        lines.push(`${name}_bucket{le="${bound}"} ${cumulative}`)
      }
      lines.push(`${name}_bucket{le="+Inf"} ${entry.count}`)
      lines.push(`${name}_sum ${entry.sum}`)
      lines.push(`${name}_count ${entry.count}`)
    }

    return lines.join("\n") + "\n"
  }
}

// Singleton for global access
export const metrics = new MetricsCollector()
