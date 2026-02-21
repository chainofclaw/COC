// Multi-node instance manager
import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises"
import { join } from "node:path"
import type { PluginLogger } from "openclaw/plugin-sdk"

import type { NodeType } from "../node-types.ts"
import type { NetworkId } from "../network-presets.ts"
import { CocProcessManager } from "./process-manager.ts"
import { resolveDataDir } from "../shared/paths.ts"

export interface NodeEntry {
  name: string
  type: NodeType
  network: NetworkId
  dataDir: string
  services: ("node" | "agent" | "relayer")[]
  createdAt: string
}

export interface NodeStatus {
  name: string
  running: boolean
  pid?: number
  blockHeight?: number
  peerCount?: number
  bftActive?: boolean
  services: Record<string, { running: boolean; pid?: number }>
}

interface NodesRegistry {
  nodes: NodeEntry[]
}

export class NodeManager {
  private readonly baseDir: string
  private readonly registryPath: string
  private readonly logger: PluginLogger
  private readonly processManager: CocProcessManager
  private registry: NodesRegistry

  constructor(baseDir: string, logger: PluginLogger) {
    this.baseDir = resolveDataDir(baseDir)
    this.registryPath = join(this.baseDir, "nodes.json")
    this.logger = logger
    this.processManager = new CocProcessManager(logger)
    this.registry = { nodes: [] }
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await mkdir(join(this.baseDir, "nodes"), { recursive: true })
    await this.loadRegistry()
  }

  // --- Registry operations ---

  listNodes(): readonly NodeEntry[] {
    return this.registry.nodes
  }

  getNode(name: string): NodeEntry | undefined {
    return this.registry.nodes.find((n) => n.name === name)
  }

  registerNode(entry: NodeEntry): void {
    const existing = this.registry.nodes.findIndex((n) => n.name === entry.name)
    if (existing >= 0) {
      this.registry.nodes = [
        ...this.registry.nodes.slice(0, existing),
        entry,
        ...this.registry.nodes.slice(existing + 1),
      ]
    } else {
      this.registry.nodes = [...this.registry.nodes, entry]
    }
    // fire-and-forget save
    this.saveRegistry().catch((err) => this.logger.error(`Failed to save registry: ${err}`))
  }

  async removeNode(name: string, deleteData: boolean): Promise<boolean> {
    const node = this.getNode(name)
    if (!node) return false

    // Stop running processes first
    await this.stopNode(name).catch(() => {})

    if (deleteData) {
      try {
        await rm(node.dataDir, { recursive: true, force: true })
      } catch (err) {
        this.logger.warn(`Failed to delete data dir: ${err}`)
      }
    }

    this.registry = {
      ...this.registry,
      nodes: this.registry.nodes.filter((n) => n.name !== name),
    }
    await this.saveRegistry()
    return true
  }

  nodeDir(name: string): string {
    return join(this.baseDir, "nodes", name)
  }

  // --- Lifecycle ---

  async startNode(name: string): Promise<void> {
    const node = this.getNode(name)
    if (!node) throw new Error(`Node "${name}" not found`)

    const processConfig = this.buildProcessConfig(node)

    for (const service of node.services) {
      await this.processManager.start(service, processConfig)
    }
  }

  async stopNode(name: string): Promise<void> {
    const node = this.getNode(name)
    if (!node) throw new Error(`Node "${name}" not found`)

    // Stop in reverse order
    const reversed = [...node.services].reverse()
    for (const service of reversed) {
      await this.processManager.stop(service, node.dataDir).catch(() => {})
    }
  }

  async restartNode(name: string): Promise<void> {
    await this.stopNode(name)
    // Brief pause for port release
    await new Promise((r) => setTimeout(r, 500))
    await this.startNode(name)
  }

  async getNodeStatus(name: string): Promise<NodeStatus> {
    const node = this.getNode(name)
    if (!node) throw new Error(`Node "${name}" not found`)

    const services: Record<string, { running: boolean; pid?: number }> = {}
    let anyRunning = false
    let mainPid: number | undefined

    for (const service of node.services) {
      const st = await this.processManager.status(service, node.dataDir)
      services[service] = st
      if (st.running) {
        anyRunning = true
        if (service === "node") mainPid = st.pid
      }
    }

    const result: NodeStatus = {
      name,
      running: anyRunning,
      pid: mainPid,
      services,
    }

    // Query RPC for live stats if node is running
    if (anyRunning) {
      const rpcInfo = await this.queryRpcStatus(node).catch(() => undefined)
      if (rpcInfo) {
        result.blockHeight = rpcInfo.blockHeight
        result.peerCount = rpcInfo.peerCount
        result.bftActive = rpcInfo.bftActive
      }
    }

    return result
  }

  // --- Config ---

  async getNodeConfig(name: string): Promise<Record<string, unknown>> {
    const node = this.getNode(name)
    if (!node) throw new Error(`Node "${name}" not found`)
    const configPath = join(node.dataDir, "node-config.json")
    const raw = await readFile(configPath, "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  }

  async updateNodeConfig(name: string, patch: Record<string, unknown>): Promise<void> {
    const current = await this.getNodeConfig(name)
    const updated = { ...current, ...patch }
    const node = this.getNode(name)!
    const configPath = join(node.dataDir, "node-config.json")
    await writeFile(configPath, JSON.stringify(updated, null, 2))
  }

  // --- Internal ---

  private async loadRegistry(): Promise<void> {
    try {
      const raw = await readFile(this.registryPath, "utf-8")
      const parsed = JSON.parse(raw) as NodesRegistry
      if (Array.isArray(parsed.nodes)) {
        this.registry = parsed
      }
    } catch {
      this.registry = { nodes: [] }
    }
  }

  private async saveRegistry(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await writeFile(this.registryPath, JSON.stringify(this.registry, null, 2))
  }

  private buildProcessConfig(node: NodeEntry) {
    return {
      runtimeDir: undefined,
      dataDir: node.dataDir,
      nodePort: 18780,
      nodeBind: "127.0.0.1",
      agentIntervalMs: 60000,
      agentBatchSize: 5,
      agentSampleSize: 2,
      relayerIntervalMs: 60000,
      nodeUrl: "http://127.0.0.1:18780",
      l1RpcUrl: undefined,
      l2RpcUrl: undefined,
    }
  }

  private async queryRpcStatus(node: NodeEntry): Promise<{
    blockHeight: number
    peerCount: number
    bftActive: boolean
  } | undefined> {
    // Read config to get actual RPC port
    let rpcPort = 18780
    try {
      const configPath = join(node.dataDir, "node-config.json")
      const raw = await readFile(configPath, "utf-8")
      const cfg = JSON.parse(raw) as Record<string, unknown>
      if (typeof cfg.rpcPort === "number") rpcPort = cfg.rpcPort
    } catch {
      // use default
    }

    const url = `http://127.0.0.1:${rpcPort}`
    try {
      const [heightRes, peerRes] = await Promise.all([
        rpcCall(url, "eth_blockNumber", []),
        rpcCall(url, "net_peerCount", []),
      ])

      const blockHeight = typeof heightRes === "string"
        ? Number.parseInt(heightRes, 16)
        : 0
      const peerCount = typeof peerRes === "string"
        ? Number.parseInt(peerRes, 16)
        : 0

      return { blockHeight, peerCount, bftActive: false }
    } catch {
      return undefined
    }
  }
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3000),
  })
  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}
