/**
 * Infrastructure & Configuration Validation Tests
 *
 * Validates Docker configs, testnet node configs, and compose files
 * for consistency, correctness, and production readiness.
 *
 * Refs: #6, #7, #9
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile, access, readdir } from "node:fs/promises"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const DOCKER_DIR = join(ROOT, "docker")
const TESTNET_CONFIGS = join(DOCKER_DIR, "testnet-configs")

// Helper to read JSON config
async function readJsonConfig(path: string): Promise<Record<string, unknown>> {
  const content = await readFile(path, "utf-8")
  return JSON.parse(content) as Record<string, unknown>
}

// Helper to check file exists
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe("Docker: Dockerfile validation", () => {
  const dockerfiles = [
    "Dockerfile.node",
    "Dockerfile.explorer",
    "Dockerfile.website",
    "Dockerfile.faucet",
  ]

  for (const df of dockerfiles) {
    it(`${df} exists and has required structure`, async () => {
      const path = join(DOCKER_DIR, df)
      assert.ok(await fileExists(path), `${df} should exist`)

      const content = await readFile(path, "utf-8")
      const lines = content.split("\n")

      // Must use node:22-slim as base
      const fromLines = lines.filter((l) => l.startsWith("FROM "))
      assert.ok(fromLines.length >= 1, `${df} should have at least one FROM`)
      assert.ok(
        fromLines.some((l) => l.includes("node:22-slim")),
        `${df} should use node:22-slim base image`,
      )

      // Must have EXPOSE
      const exposeLines = lines.filter((l) => l.startsWith("EXPOSE "))
      assert.ok(exposeLines.length >= 1, `${df} should EXPOSE ports`)

      // Must have HEALTHCHECK
      const healthLines = lines.filter((l) => l.includes("HEALTHCHECK"))
      assert.ok(healthLines.length >= 1, `${df} should have HEALTHCHECK`)
    })
  }

  it("Dockerfile.node is multi-stage build", async () => {
    const content = await readFile(join(DOCKER_DIR, "Dockerfile.node"), "utf-8")
    const fromLines = content.split("\n").filter((l) => l.startsWith("FROM "))
    assert.ok(fromLines.length >= 2, "Dockerfile.node should have multi-stage build (>= 2 FROM)")
  })

  it("Dockerfile.node exposes all required ports", async () => {
    const content = await readFile(join(DOCKER_DIR, "Dockerfile.node"), "utf-8")
    const requiredPorts = ["18780", "18781", "19780", "19781", "9100"]

    for (const port of requiredPorts) {
      assert.ok(content.includes(port), `Dockerfile.node should expose port ${port}`)
    }
  })

  it("Dockerfile.node supports COC_DATA_DIR", async () => {
    const content = await readFile(join(DOCKER_DIR, "Dockerfile.node"), "utf-8")
    assert.ok(content.includes("COC_DATA_DIR"), "Should support COC_DATA_DIR env var")
  })

  it("Dockerfile.explorer uses Next.js standalone output", async () => {
    const content = await readFile(join(DOCKER_DIR, "Dockerfile.explorer"), "utf-8")
    assert.ok(content.includes("standalone"), "Should use Next.js standalone output")
    assert.ok(content.includes(".next/static"), "Should copy static assets")
  })
})

describe("Docker: Compose file validation", () => {
  it("docker-compose.yml exists with required services", async () => {
    const content = await readFile(join(DOCKER_DIR, "docker-compose.yml"), "utf-8")

    assert.ok(content.includes("node:"), "Should define node service")
    assert.ok(content.includes("explorer:"), "Should define explorer service")
    assert.ok(content.includes("coc-internal"), "Should have internal network")
    assert.ok(content.includes("volumes:"), "Should have volume definitions")
  })

  it("docker-compose.testnet.yml exists with 3 node services", async () => {
    const content = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")

    assert.ok(content.includes("node-1:"), "Should define node-1")
    assert.ok(content.includes("node-2:"), "Should define node-2")
    assert.ok(content.includes("node-3:"), "Should define node-3")
    assert.ok(content.includes("explorer:"), "Should define explorer")
    assert.ok(content.includes("faucet:"), "Should define faucet")
  })

  it("testnet compose uses correct node configs", async () => {
    const content = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")

    assert.ok(content.includes("node-1.json"), "node-1 should use node-1.json config")
    assert.ok(content.includes("node-2.json"), "node-2 should use node-2.json config")
    assert.ok(content.includes("node-3.json"), "node-3 should use node-3.json config")
  })

  it("testnet compose has separate networks for P2P and RPC", async () => {
    const content = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")

    assert.ok(content.includes("coc-p2p"), "Should have P2P network")
    assert.ok(content.includes("coc-rpc"), "Should have RPC network")
  })

  it("testnet compose maps unique host ports per node", async () => {
    const content = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")

    // Extract port mappings from the ports: sections only (format: "HOST:CONTAINER")
    const portLines = content.split("\n").filter((l) => l.trim().startsWith("- \"") && l.includes(":"))
    const hostPorts = portLines
      .map((l) => {
        const match = l.trim().match(/^- "(\d+):(\d+)"$/)
        return match ? match[1] : null
      })
      .filter((p): p is string => p !== null)

    const uniquePorts = new Set(hostPorts)
    assert.equal(uniquePorts.size, hostPorts.length, "All host port mappings should be unique")
  })

  it("monitoring compose exists", async () => {
    const path = join(DOCKER_DIR, "docker-compose.monitoring.yml")
    assert.ok(await fileExists(path), "docker-compose.monitoring.yml should exist")

    const content = await readFile(path, "utf-8")
    assert.ok(content.includes("prometheus"), "Should include Prometheus")
    assert.ok(content.includes("grafana"), "Should include Grafana")
  })
})

describe("Testnet: Node config consistency", () => {
  const configPaths = [
    join(TESTNET_CONFIGS, "node-1.json"),
    join(TESTNET_CONFIGS, "node-2.json"),
    join(TESTNET_CONFIGS, "node-3.json"),
  ]

  it("all 3 node configs exist", async () => {
    for (const path of configPaths) {
      assert.ok(await fileExists(path), `${path} should exist`)
    }
  })

  it("all nodes share the same chainId", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    const chainIds = configs.map((c) => c.chainId)
    assert.ok(
      chainIds.every((id) => id === chainIds[0]),
      `All nodes should have the same chainId, got: ${chainIds}`,
    )
  })

  it("all nodes share the same validator set", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    const validatorSets = configs.map((c) => JSON.stringify(c.validators))
    assert.ok(
      validatorSets.every((vs) => vs === validatorSets[0]),
      "All nodes should have the same validator set",
    )
  })

  it("each node has a unique nodeId", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    const nodeIds = configs.map((c) => c.nodeId as string)
    const uniqueIds = new Set(nodeIds)
    assert.equal(uniqueIds.size, nodeIds.length, "Each node should have a unique nodeId")
  })

  it("each node's nodeId is in the validator set", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      const validators = config.validators as string[]
      assert.ok(
        validators.includes(config.nodeId as string),
        `nodeId ${config.nodeId} should be in the validator set`,
      )
    }
  })

  it("peer lists exclude the node itself", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      const peers = config.peers as Array<{ id: string }>
      const peerIds = peers.map((p) => p.id)
      assert.ok(
        !peerIds.includes(config.nodeId as string),
        `Node ${config.nodeId} should not be in its own peer list`,
      )
    }
  })

  it("each node peers with all other nodes", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      const peers = config.peers as Array<{ id: string }>
      const otherNodes = configs.filter((c) => c.nodeId !== config.nodeId)
      assert.equal(
        peers.length,
        otherNodes.length,
        `Node ${config.nodeId} should peer with ${otherNodes.length} other nodes, got ${peers.length}`,
      )
    }
  })

  it("all nodes have BFT enabled", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      assert.equal(config.enableBft, true, `Node ${config.nodeId} should have enableBft: true`)
    }
  })

  it("all nodes have wire protocol enabled", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      assert.equal(
        config.enableWireProtocol,
        true,
        `Node ${config.nodeId} should have enableWireProtocol: true`,
      )
    }
  })

  it("all nodes have DHT enabled with bootstrap peers", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      assert.equal(config.enableDht, true, `Node ${config.nodeId} should have enableDht: true`)
      const dhtPeers = config.dhtBootstrapPeers as Array<{ id: string }>
      assert.ok(
        dhtPeers && dhtPeers.length > 0,
        `Node ${config.nodeId} should have dhtBootstrapPeers`,
      )
    }
  })

  it("DHT bootstrap peers exclude the node itself", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    for (const config of configs) {
      const dhtPeers = config.dhtBootstrapPeers as Array<{ id: string }>
      const dhtPeerIds = dhtPeers.map((p) => p.id)
      assert.ok(
        !dhtPeerIds.includes(config.nodeId as string),
        `Node ${config.nodeId} should not be in its own DHT bootstrap list`,
      )
    }
  })

  it("all nodes share the same block parameters", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    const blockTimes = configs.map((c) => c.blockTimeMs)
    const finalityDepths = configs.map((c) => c.finalityDepth)
    const maxTxs = configs.map((c) => c.maxTxPerBlock)

    assert.ok(blockTimes.every((t) => t === blockTimes[0]), "All nodes should have same blockTimeMs")
    assert.ok(finalityDepths.every((d) => d === finalityDepths[0]), "All nodes should have same finalityDepth")
    assert.ok(maxTxs.every((m) => m === maxTxs[0]), "All nodes should have same maxTxPerBlock")
  })

  it("all nodes share the same prefund configuration", async () => {
    const configs = await Promise.all(configPaths.map(readJsonConfig))
    const prefunds = configs.map((c) => JSON.stringify(c.prefund))
    assert.ok(
      prefunds.every((p) => p === prefunds[0]),
      "All nodes should have the same prefund configuration",
    )
  })
})

describe("Testnet: Compose-Config alignment", () => {
  it("compose node keys correspond to config nodeIds", async () => {
    const compose = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")
    const configs = await Promise.all([
      readJsonConfig(join(TESTNET_CONFIGS, "node-1.json")),
      readJsonConfig(join(TESTNET_CONFIGS, "node-2.json")),
      readJsonConfig(join(TESTNET_CONFIGS, "node-3.json")),
    ])

    // Hardhat standard keys map to specific addresses
    const keyToAddress: Record<string, string> = {
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80":
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d":
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a":
        "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    }

    for (const [key, expectedAddr] of Object.entries(keyToAddress)) {
      if (compose.includes(key)) {
        // Find which config has this address as nodeId
        const matchingConfig = configs.find(
          (c) => (c.nodeId as string).toLowerCase() === expectedAddr.toLowerCase(),
        )
        assert.ok(
          matchingConfig,
          `Key ${key.slice(0, 10)}... should correspond to a node config with nodeId ${expectedAddr}`,
        )
      }
    }
  })
})

describe("Infrastructure: Supporting files", () => {
  it(".dockerignore exists", async () => {
    assert.ok(
      await fileExists(join(DOCKER_DIR, ".dockerignore")),
      ".dockerignore should exist in docker/",
    )
  })

  it("prometheus alerts config exists", async () => {
    const path = join(DOCKER_DIR, "prometheus", "alerts.yml")
    assert.ok(await fileExists(path), "prometheus/alerts.yml should exist")

    const content = await readFile(path, "utf-8")
    assert.ok(content.includes("BlockProductionStopped"), "Should have BlockProductionStopped alert")
    assert.ok(content.includes("ConsensusDegraded"), "Should have ConsensusDegraded alert")
    assert.ok(content.includes("NodeOffline"), "Should have NodeOffline alert")
  })

  it("grafana dashboards directory exists", async () => {
    const path = join(DOCKER_DIR, "grafana")
    assert.ok(await fileExists(path), "grafana/ directory should exist")
  })

  it("nginx config exists", async () => {
    const path = join(DOCKER_DIR, "nginx")
    assert.ok(await fileExists(path), "nginx/ directory should exist")
  })

  it("systemd service template exists", async () => {
    const path = join(DOCKER_DIR, "systemd")
    assert.ok(await fileExists(path), "systemd/ directory should exist")
  })
})

describe("Scripts: Devnet & Operations", () => {
  const requiredScripts = [
    "scripts/generate-genesis.sh",
    "scripts/generate-validator-keys.sh",
    "scripts/tps-bench.ts",
  ]

  for (const script of requiredScripts) {
    it(`${script} exists`, async () => {
      assert.ok(
        await fileExists(join(ROOT, script)),
        `${script} should exist`,
      )
    })
  }

  it("devnet scripts exist and are executable", async () => {
    const devnetScripts = await readdir(join(ROOT, "scripts"))
    const hasDevnet = devnetScripts.some((f) => f.includes("devnet"))
    assert.ok(hasDevnet, "Should have at least one devnet script")
  })
})
