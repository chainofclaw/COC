import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { CocConfigSchema } from "./src/config-schema.ts"
import { registerCocCommands } from "./src/cli/commands.ts"
import { NodeManager } from "./src/runtime/node-manager.ts"
import { runInitWizard } from "./src/cli/init-wizard.ts"
import { safeRpcQuery } from "./src/runtime/rpc-client.ts"

export function activate(api: OpenClawPluginApi) {
  const logger = api.logger
  logger.info("COC node ops extension loading...")

  let config
  try {
    config = CocConfigSchema.parse(api.pluginConfig ?? {})
  } catch (error) {
    logger.error(`COC config parse failed: ${String(error)}`)
    return
  }

  const nodeManager = new NodeManager(config.dataDir, logger)

  api.registerCli(
    async ({ program }) => {
      await nodeManager.init()
      registerCocCommands(program, config, logger, nodeManager)
      logger.info("COC CLI commands registered")
    },
    { commands: ["coc"] },
  )

  // --- Agent Tools ---

  api.registerTool({
    name: "coc-node-init",
    description: "Initialize a new COC blockchain node instance with specified type and network",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["validator", "fullnode", "archive", "gateway", "dev"],
          description: "Node type",
        },
        network: {
          type: "string",
          enum: ["testnet", "mainnet", "local", "custom"],
          description: "Network to join",
        },
        name: { type: "string", description: "Node name (auto-generated if omitted)" },
        rpcPort: { type: "number", description: "RPC port (default 18780)" },
        dataDir: { type: "string", description: "Custom data directory" },
      },
      required: ["type", "network"],
    },
    async execute(params: { type: string; network: string; name?: string; rpcPort?: number; dataDir?: string }) {
      try {
        await nodeManager.init()
        const result = await runInitWizard(nodeManager, params)
        if (!result) return { success: false, error: "Init wizard returned no result" }
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-list",
    description: "List all managed COC node instances",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        await nodeManager.init()
        const nodes = nodeManager.listNodes()
        return { success: true, nodes }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-start",
    description: "Start a COC node (or all nodes if name is omitted)",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name (starts all if omitted)" },
      },
    },
    async execute(params: { name?: string }) {
      try {
        await nodeManager.init()
        const started: string[] = []
        if (params.name) {
          await nodeManager.startNode(params.name)
          started.push(params.name)
        } else {
          for (const node of nodeManager.listNodes()) {
            await nodeManager.startNode(node.name)
            started.push(node.name)
          }
        }
        return { success: true, started }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-stop",
    description: "Stop a COC node (or all nodes if name is omitted)",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name (stops all if omitted)" },
      },
    },
    async execute(params: { name?: string }) {
      try {
        await nodeManager.init()
        const stopped: string[] = []
        if (params.name) {
          await nodeManager.stopNode(params.name)
          stopped.push(params.name)
        } else {
          const nodes = [...nodeManager.listNodes()].reverse()
          for (const node of nodes) {
            await nodeManager.stopNode(node.name).catch(() => {})
            stopped.push(node.name)
          }
        }
        return { success: true, stopped }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-restart",
    description: "Restart a COC node (or all nodes if name is omitted)",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name (restarts all if omitted)" },
      },
    },
    async execute(params: { name?: string }) {
      try {
        await nodeManager.init()
        const restarted: string[] = []
        if (params.name) {
          await nodeManager.restartNode(params.name)
          restarted.push(params.name)
        } else {
          for (const node of nodeManager.listNodes()) {
            await nodeManager.restartNode(node.name)
            restarted.push(node.name)
          }
        }
        return { success: true, restarted }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-status",
    description: "Get detailed status for a COC node including block height, peer count, and BFT status from live RPC",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name (shows all if omitted)" },
      },
    },
    async execute(params: { name?: string }) {
      try {
        await nodeManager.init()
        if (params.name) {
          const status = await nodeManager.getNodeStatus(params.name)
          return { success: true, statuses: [status] }
        }
        const nodes = nodeManager.listNodes()
        if (nodes.length === 0) return { success: true, statuses: [], message: "No nodes configured" }
        const statuses = await Promise.all(nodes.map((n) => nodeManager.getNodeStatus(n.name)))
        return { success: true, statuses }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-remove",
    description: "Remove a COC node instance and optionally delete its data",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name to remove" },
        keepData: { type: "boolean", description: "Keep data directory (default false)", default: false },
      },
      required: ["name"],
    },
    async execute(params: { name: string; keepData?: boolean }) {
      try {
        await nodeManager.init()
        const removed = await nodeManager.removeNode(params.name, !(params.keepData ?? false))
        return { success: true, removed }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-config",
    description: "View or patch a COC node's configuration. Provide patch object to update settings.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name" },
        patch: {
          type: "object",
          description: "Config fields to update (omit to view current config)",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
    async execute(params: { name: string; patch?: Record<string, unknown> }) {
      try {
        await nodeManager.init()
        if (params.patch && Object.keys(params.patch).length > 0) {
          await nodeManager.updateNodeConfig(params.name, params.patch)
        }
        const config = await nodeManager.getNodeConfig(params.name)
        return { success: true, config }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-node-logs",
    description: "Retrieve recent log output from a COC node service",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name" },
        service: {
          type: "string",
          enum: ["node", "agent", "relayer"],
          description: "Service to read logs from (default node)",
          default: "node",
        },
        lines: { type: "number", description: "Number of log lines to return (default 50)", default: 50 },
      },
      required: ["name"],
    },
    async execute(params: { name: string; service?: "node" | "agent" | "relayer"; lines?: number }) {
      try {
        await nodeManager.init()
        const logTail = await nodeManager.getNodeLogs(params.name, params.service ?? "node", params.lines ?? 50)
        return { success: true, service: params.service ?? "node", logTail }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "coc-rpc-query",
    description:
      "Query a running COC node via JSON-RPC. Supports chain stats, block info, balances, peer count, BFT status, and more. Only read-only methods are allowed.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name (uses first node if omitted)" },
        method: {
          type: "string",
          description:
            "RPC method: eth_blockNumber, eth_getBlockByNumber, eth_getBlockByHash, net_peerCount, coc_chainStats, coc_getBftStatus, eth_getBalance, eth_syncing, eth_getTransactionByHash, eth_getTransactionReceipt",
        },
        params: {
          type: "array",
          description: "RPC method parameters (e.g. [\"0x1\", true] for eth_getBlockByNumber)",
          items: {},
          default: [],
        },
      },
      required: ["method"],
    },
    async execute(toolParams: { name?: string; method: string; params?: unknown[] }) {
      try {
        await nodeManager.init()
        let dataDir: string
        if (toolParams.name) {
          const node = nodeManager.getNode(toolParams.name)
          if (!node) return { success: false, error: `Node "${toolParams.name}" not found` }
          dataDir = node.dataDir
        } else {
          const nodes = nodeManager.listNodes()
          if (nodes.length === 0) return { success: false, error: "No nodes configured" }
          dataDir = nodes[0].dataDir
        }
        const { result } = await safeRpcQuery(dataDir, toolParams.method, toolParams.params ?? [])
        return { success: true, method: toolParams.method, result }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  logger.info("COC extension loaded (10 agent tools registered)")
}
