// Network configuration presets for COC blockchain

export type NetworkId = "testnet" | "mainnet" | "local" | "custom"

export interface NetworkPreset {
  chainId: number
  bootstrapPeers: Array<{ id: string; url: string }>
  dhtBootstrapPeers: Array<{ id: string; address: string; port: number }>
  validators: string[]
  rpcPort: number
  p2pPort: number
  wirePort: number
  wsPort: number
  ipfsPort: number
}

export const NETWORK_PRESETS: Record<Exclude<NetworkId, "custom">, NetworkPreset> = {
  testnet: {
    chainId: 18780,
    bootstrapPeers: [
      { id: "boot-1", url: "http://testnet-boot1.coc.network:19780" },
      { id: "boot-2", url: "http://testnet-boot2.coc.network:19780" },
    ],
    dhtBootstrapPeers: [
      { id: "boot-1", address: "testnet-boot1.coc.network", port: 19781 },
      { id: "boot-2", address: "testnet-boot2.coc.network", port: 19781 },
    ],
    validators: [],
    rpcPort: 18780,
    p2pPort: 19780,
    wirePort: 19781,
    wsPort: 18781,
    ipfsPort: 5001,
  },
  mainnet: {
    chainId: 1,
    bootstrapPeers: [],
    dhtBootstrapPeers: [],
    validators: [],
    rpcPort: 18780,
    p2pPort: 19780,
    wirePort: 19781,
    wsPort: 18781,
    ipfsPort: 5001,
  },
  local: {
    chainId: 18780,
    bootstrapPeers: [],
    dhtBootstrapPeers: [],
    validators: ["node-1"],
    rpcPort: 18780,
    p2pPort: 19780,
    wirePort: 19781,
    wsPort: 18781,
    ipfsPort: 5001,
  },
}

export const NETWORK_LABELS: Record<NetworkId, string> = {
  testnet: "Testnet (public test network)",
  mainnet: "Mainnet (not yet launched)",
  local: "Local (localhost, auto ports)",
  custom: "Custom (specify all parameters)",
}

export function isValidNetworkId(value: string): value is NetworkId {
  return value === "testnet" || value === "mainnet" || value === "local" || value === "custom"
}

export function getNetworkPreset(id: Exclude<NetworkId, "custom">): NetworkPreset {
  return NETWORK_PRESETS[id]
}
