// Node type presets for COC blockchain nodes

export type NodeType = "validator" | "fullnode" | "archive" | "gateway" | "dev"

export interface NodeTypePreset {
  description: string
  configOverrides: Record<string, unknown>
  services: ("node" | "agent" | "relayer")[]
}

export const NODE_TYPE_PRESETS: Record<NodeType, NodeTypePreset> = {
  validator: {
    description: "Validator node - participates in BFT consensus and block production",
    configOverrides: {
      enableBft: true,
      enableWireProtocol: true,
      enableDht: true,
      enableSnapSync: true,
      storage: { backend: "leveldb" },
      p2pInboundAuthMode: "enforce",
    },
    services: ["node", "agent"],
  },
  fullnode: {
    description: "Full node - syncs all blocks, provides RPC, no block production",
    configOverrides: {
      enableBft: false,
      enableWireProtocol: true,
      enableDht: true,
      enableSnapSync: true,
      storage: { backend: "leveldb" },
      validators: [],
      p2pInboundAuthMode: "enforce",
    },
    services: ["node"],
  },
  archive: {
    description: "Archive node - full history, pruning disabled",
    configOverrides: {
      enableBft: false,
      enableWireProtocol: true,
      enableDht: true,
      enableSnapSync: true,
      storage: { backend: "leveldb", enablePruning: false },
      validators: [],
      p2pInboundAuthMode: "enforce",
    },
    services: ["node"],
  },
  gateway: {
    description: "Gateway node - lightweight RPC proxy, in-memory storage",
    configOverrides: {
      enableBft: false,
      enableWireProtocol: false,
      enableDht: false,
      enableSnapSync: false,
      storage: { backend: "memory" },
      validators: [],
      p2pInboundAuthMode: "off",
    },
    services: ["node"],
  },
  dev: {
    description: "Dev node - local development with test accounts, single-node",
    configOverrides: {
      enableBft: false,
      enableWireProtocol: false,
      enableDht: false,
      enableSnapSync: false,
      storage: { backend: "leveldb" },
      validators: ["dev-node"],
      p2pInboundAuthMode: "off",
      prefund: [
        { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", balanceEth: "10000" },
        { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", balanceEth: "10000" },
        { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", balanceEth: "10000" },
      ],
    },
    services: ["node"],
  },
} as const

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  validator: "Validator (BFT consensus, block production)",
  fullnode: "Full Node (sync + RPC, no production)",
  archive: "Archive (full history, no pruning)",
  gateway: "Gateway (lightweight RPC proxy)",
  dev: "Dev (local development, test accounts)",
}

export function isValidNodeType(value: string): value is NodeType {
  return value in NODE_TYPE_PRESETS
}
