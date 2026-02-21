// Interactive node initialization wizard using @clack/prompts
import * as p from "@clack/prompts"
import crypto from "node:crypto"
import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

import type { NodeType } from "../node-types.ts"
import { NODE_TYPE_PRESETS, NODE_TYPE_LABELS, isValidNodeType } from "../node-types.ts"
import type { NetworkId } from "../network-presets.ts"
import { NETWORK_PRESETS, NETWORK_LABELS, isValidNetworkId } from "../network-presets.ts"
import type { NodeManager, NodeEntry } from "../runtime/node-manager.ts"

export interface InitOptions {
  type?: string
  network?: string
  name?: string
  dataDir?: string
  rpcPort?: number
}

export interface InitResult {
  name: string
  type: NodeType
  network: NetworkId
  dataDir: string
  configPath: string
}

export async function runInitWizard(
  manager: NodeManager,
  opts: InitOptions,
): Promise<InitResult | undefined> {
  const interactive = !opts.type

  if (interactive) {
    p.intro("COC Node Setup")
  }

  // 1. Node type
  let nodeType: NodeType
  if (opts.type) {
    if (!isValidNodeType(opts.type)) {
      if (interactive) p.cancel(`Invalid node type: ${opts.type}`)
      else console.error(`Invalid node type: ${opts.type}`)
      return undefined
    }
    nodeType = opts.type
  } else {
    const typeResult = await p.select({
      message: "Select node type",
      options: (Object.keys(NODE_TYPE_LABELS) as NodeType[]).map((t) => ({
        value: t,
        label: NODE_TYPE_LABELS[t],
        hint: NODE_TYPE_PRESETS[t].services.join(", "),
      })),
    })
    if (p.isCancel(typeResult)) {
      p.cancel("Setup cancelled")
      return undefined
    }
    nodeType = typeResult as NodeType
  }

  // 2. Network
  let network: NetworkId
  if (opts.network) {
    if (!isValidNetworkId(opts.network)) {
      if (interactive) p.cancel(`Invalid network: ${opts.network}`)
      else console.error(`Invalid network: ${opts.network}`)
      return undefined
    }
    network = opts.network
  } else {
    const networkResult = await p.select({
      message: "Select network",
      options: (Object.keys(NETWORK_LABELS) as NetworkId[]).map((n) => ({
        value: n,
        label: NETWORK_LABELS[n],
      })),
    })
    if (p.isCancel(networkResult)) {
      p.cancel("Setup cancelled")
      return undefined
    }
    network = networkResult as NetworkId
  }

  // 3. Node name
  const existingNodes = manager.listNodes()
  const defaultName = generateDefaultName(nodeType, existingNodes)
  let name: string
  if (opts.name) {
    name = opts.name
  } else {
    const nameResult = await p.text({
      message: "Node name",
      defaultValue: defaultName,
      placeholder: defaultName,
      validate: (value) => {
        const v = value.trim() || defaultName
        if (!/^[a-zA-Z0-9_-]+$/.test(v)) {
          return "Name must be alphanumeric with dashes/underscores"
        }
        if (manager.getNode(v)) {
          return `Node "${v}" already exists`
        }
        return undefined
      },
    })
    if (p.isCancel(nameResult)) {
      p.cancel("Setup cancelled")
      return undefined
    }
    name = (nameResult as string).trim() || defaultName
  }

  // Check duplicate name
  if (manager.getNode(name)) {
    const msg = `Node "${name}" already exists`
    if (interactive) p.cancel(msg)
    else console.error(msg)
    return undefined
  }

  // 4. RPC port
  const networkPreset = network !== "custom" ? NETWORK_PRESETS[network] : undefined
  const defaultRpcPort = opts.rpcPort ?? networkPreset?.rpcPort ?? 18780
  let rpcPort: number
  if (opts.rpcPort !== undefined) {
    rpcPort = opts.rpcPort
  } else if (interactive) {
    const portResult = await p.text({
      message: "RPC port",
      defaultValue: String(defaultRpcPort),
      placeholder: String(defaultRpcPort),
      validate: (value) => {
        const n = Number(value.trim() || defaultRpcPort)
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return "Port must be between 1 and 65535"
        }
        return undefined
      },
    })
    if (p.isCancel(portResult)) {
      p.cancel("Setup cancelled")
      return undefined
    }
    rpcPort = Number((portResult as string).trim() || defaultRpcPort)
  } else {
    rpcPort = defaultRpcPort
  }

  // 5. Custom network params
  let customChainId: number | undefined
  let customBootstrapPeers: string | undefined
  if (network === "custom" && interactive) {
    const chainIdResult = await p.text({
      message: "Chain ID",
      defaultValue: "18780",
      placeholder: "18780",
    })
    if (p.isCancel(chainIdResult)) {
      p.cancel("Setup cancelled")
      return undefined
    }
    customChainId = Number((chainIdResult as string).trim() || "18780")

    const peersResult = await p.text({
      message: "Bootstrap peers (comma-separated URLs, or empty)",
      defaultValue: "",
      placeholder: "http://peer1:19780,http://peer2:19780",
    })
    if (p.isCancel(peersResult)) {
      p.cancel("Setup cancelled")
      return undefined
    }
    customBootstrapPeers = (peersResult as string).trim()
  }

  // Build configuration
  const nodeDir = opts.dataDir ?? manager.nodeDir(name)
  const preset = NODE_TYPE_PRESETS[nodeType]
  const chainId = customChainId ?? networkPreset?.chainId ?? 18780
  const p2pPort = networkPreset?.p2pPort ?? 19780
  const wirePort = networkPreset?.wirePort ?? 19781
  const wsPort = networkPreset?.wsPort ?? 18781
  const ipfsPort = networkPreset?.ipfsPort ?? 5001

  // Build peers list
  let peers: Array<{ id: string; url: string }> = []
  if (customBootstrapPeers) {
    peers = customBootstrapPeers
      .split(",")
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((url, i) => ({ id: `peer-${i + 1}`, url }))
  } else if (networkPreset) {
    peers = networkPreset.bootstrapPeers
  }

  let dhtBootstrapPeers: Array<{ id: string; address: string; port: number }> = []
  if (networkPreset) {
    dhtBootstrapPeers = networkPreset.dhtBootstrapPeers
  }

  // Merge config: base defaults + node type overrides + network specifics
  const nodeConfig: Record<string, unknown> = {
    dataDir: nodeDir,
    nodeId: name,
    chainId,
    rpcBind: "127.0.0.1",
    rpcPort,
    wsBind: "127.0.0.1",
    wsPort,
    ipfsBind: "127.0.0.1",
    ipfsPort,
    p2pBind: "127.0.0.1",
    p2pPort,
    wireBind: "127.0.0.1",
    wirePort,
    peers,
    dhtBootstrapPeers,
    blockTimeMs: 3000,
    syncIntervalMs: 5000,
    finalityDepth: 3,
    maxTxPerBlock: 50,
    minGasPriceWei: "1",
    ...preset.configOverrides,
  }

  // Validators for validator type: use node name
  if (nodeType === "validator") {
    nodeConfig.validators = [name]
  }

  // Generate node key
  await mkdir(nodeDir, { recursive: true })
  const nodeKey = "0x" + crypto.randomBytes(32).toString("hex")
  const keyPath = join(nodeDir, "node-key")
  await writeFile(keyPath, nodeKey + "\n", { mode: 0o600 })

  // Write node-config.json
  const configPath = join(nodeDir, "node-config.json")
  await writeFile(configPath, JSON.stringify(nodeConfig, null, 2))

  // Create logs directory
  await mkdir(join(nodeDir, "logs"), { recursive: true })

  // Register node
  const entry: NodeEntry = {
    name,
    type: nodeType,
    network,
    dataDir: nodeDir,
    services: [...preset.services],
    createdAt: new Date().toISOString(),
  }
  manager.registerNode(entry)

  if (interactive) {
    p.note(
      [
        `Type:    ${nodeType}`,
        `Network: ${network}`,
        `Name:    ${name}`,
        `Dir:     ${nodeDir}`,
        `RPC:     http://127.0.0.1:${rpcPort}`,
        `Config:  ${configPath}`,
      ].join("\n"),
      "Node initialized",
    )
    p.outro(`Run "openclaw coc start ${name}" to start the node`)
  } else {
    console.log(`Node "${name}" initialized at ${nodeDir}`)
  }

  return { name, type: nodeType, network, dataDir: nodeDir, configPath }
}

function generateDefaultName(nodeType: NodeType, existing: readonly NodeEntry[]): string {
  const prefix = nodeType === "validator" ? "val" : nodeType === "fullnode" ? "fn" : nodeType
  for (let i = 1; i <= 100; i++) {
    const candidate = `${prefix}-${i}`
    if (!existing.some((n) => n.name === candidate)) {
      return candidate
    }
  }
  return `${prefix}-${Date.now()}`
}
