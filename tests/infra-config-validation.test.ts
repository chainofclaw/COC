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
const HARDHAT_PRIVATE_KEY = /0x(?:ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80|59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d|5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a|7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6|47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a|8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba|92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e|dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97|2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6)\b/i
const DEPLOYMENT_ADMIN_CONFIGS = [
  "docker/testnet-configs/node-1.json",
  "docker/testnet-configs/node-2.json",
  "docker/testnet-configs/node-3.json",
  "docker/testnet-configs/sync-node.json",
  "docker/systemd/native-configs/node-1.json",
  "docker/systemd/native-configs/node-2.json",
  "docker/systemd/native-configs/node-3.json",
  "ops/testnet/node-config-1.json",
  "ops/testnet/node-config-2.json",
  "ops/testnet/node-config-3.json",
]

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

describe("Security: secret hygiene", () => {
  it("deployment docs do not include a literal faucet private key", async () => {
    const deployment = await readFile(join(ROOT, "docs", "DEPLOYMENT.md"), "utf-8")

    assert.doesNotMatch(
      deployment,
      /COC_FAUCET_PRIVATE_KEY=0x[0-9a-fA-F]{64}/,
      "deployment docs must not include a literal COC_FAUCET_PRIVATE_KEY",
    )
    assert.doesNotMatch(
      deployment,
      /私钥\s*`0x[0-9a-fA-F]{64}`/,
      "deployment docs must not show real private keys inline",
    )
  })

  it("testnet compose requires faucet key injection and keeps IPFS HTTP local-only", async () => {
    const compose = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")

    assert.ok(
      compose.includes("COC_FAUCET_PRIVATE_KEY=${COC_FAUCET_KEY:?"),
      "testnet faucet must require COC_FAUCET_KEY instead of falling back to a public key",
    )
    assert.doesNotMatch(
      compose,
      /COC_FAUCET_PRIVATE_KEY=\$\{COC_FAUCET_KEY:-0x[0-9a-fA-F]{64}\}/,
      "testnet faucet must not include a literal default private key",
    )
    assert.ok(
      compose.includes('"127.0.0.1:28786:5001"'),
      "IPFS HTTP API should bind to localhost by default",
    )
    assert.doesNotMatch(
      compose,
      /^\s*-\s*"28786:5001"/m,
      "IPFS HTTP API must not publish on all interfaces by default",
    )
  })

  it("testnet prover services use canonical COC_NODE_KEY env var", async () => {
    const compose = await readFile(join(DOCKER_DIR, "docker-compose.testnet.yml"), "utf-8")

    assert.doesNotMatch(
      compose,
      /^\s*-\s*COC_NODE_PK=/m,
      "prover services must not set legacy COC_NODE_PK",
    )
    assert.match(compose, /COC_NODE_KEY=\$\{COC_NODE1_KEY:/)
    assert.match(compose, /COC_NODE_KEY=\$\{COC_NODE2_KEY:/)
    assert.match(compose, /COC_NODE_KEY=\$\{COC_NODE3_KEY:/)
  })

  it("deployment compose files do not ship literal node or runtime private keys", async () => {
    const files = [
      "docker-compose.testnet.yml",
      "docker-compose.external.yml",
      "docker-compose.light.yml",
    ]

    for (const file of files) {
      const content = await readFile(join(DOCKER_DIR, file), "utf-8")
      assert.doesNotMatch(
        content,
        /^\s*-\s*COC_(?:NODE_KEY|OPERATOR_PK|SLASHER_PK)=0x[0-9a-fA-F]{64}$/m,
        `${file} must not include literal deployment private keys`,
      )
      assert.doesNotMatch(
        content,
        /COC_(?:NODE_KEY|OPERATOR_PK|SLASHER_PK)=\$\{[A-Z0-9_]+:-0x[0-9a-fA-F]{64}\}/,
        `${file} must not include literal private-key fallbacks`,
      )
      assert.doesNotMatch(
        content,
        HARDHAT_PRIVATE_KEY,
        `${file} must not publish Hardhat private keys in deployment config`,
      )
    }
  })

  it("native systemd env templates do not publish validator private keys or IPFS admin API", async () => {
    const files = [
      "systemd/native-env/node-1.env",
      "systemd/native-env/node-2.env",
      "systemd/native-env/node-3.env",
      "systemd/native-env/node-multiserver.env.template",
    ]

    for (const file of files) {
      const content = await readFile(join(DOCKER_DIR, file), "utf-8")
      assert.doesNotMatch(
        content,
        /^COC_NODE_KEY=0x[0-9a-fA-F]{64}$/m,
        `${file} must not include a literal validator private key`,
      )
    }

    const node1 = await readFile(join(DOCKER_DIR, "systemd/native-env/node-1.env"), "utf-8")
    assert.match(node1, /^COC_IPFS_BIND=127\.0\.0\.1$/m)
    assert.doesNotMatch(node1, /^COC_IPFS_BIND=0\.0\.0\.0$/m)

    const multiServer = await readFile(join(DOCKER_DIR, "systemd/native-env/node-multiserver.env.template"), "utf-8")
    assert.match(multiServer, /^COC_IPFS_BIND=127\.0\.0\.1$/m)
    assert.doesNotMatch(multiServer, /^COC_IPFS_BIND=0\.0\.0\.0$/m)
  })

  it("monitoring compose requires Grafana password injection and local-only ports", async () => {
    const compose = await readFile(join(DOCKER_DIR, "docker-compose.monitoring.yml"), "utf-8")

    assert.ok(
      compose.includes("GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:?"),
      "Grafana admin password must be provided by deployment environment",
    )
    assert.doesNotMatch(
      compose,
      /GF_SECURITY_ADMIN_PASSWORD=(?:admin|password|cocprowl)/,
      "monitoring compose must not ship a fixed weak Grafana password",
    )
    assert.ok(compose.includes('"127.0.0.1:9090:9090"'))
    assert.ok(compose.includes('"127.0.0.1:3100:3000"'))
    assert.doesNotMatch(compose, /^\s*-\s*"9090:9090"/m)
    assert.doesNotMatch(compose, /^\s*-\s*"3100:3000"/m)
  })

  it("public-RPC automation scripts do not default to literal private keys", async () => {
    const files = [
      "scripts/synthetic/active-probe.mjs",
      "scripts/synthetic/stress-probe.mjs",
      "scripts/synthetic/remediate.mjs",
      "contracts/stake-validator.mjs",
      "contracts/unstake-validator.mjs",
    ]

    for (const relative of files) {
      const content = await readFile(join(ROOT, relative), "utf-8")
      assert.doesNotMatch(
        content,
        /process\.env\.[A-Z0-9_]+\s*(?:\|\||\?\?)\s*['"]0x[0-9a-fA-F]{64}['"]/,
        `${relative} must not use a literal private key fallback`,
      )
      assert.ok(
        content.includes("resolvePrivateKeyForRpc"),
        `${relative} should gate dev private key fallback by RPC target`,
      )
    }
  })

  it("live/testnet stress scripts do not ship Hardhat private-key defaults", async () => {
    const files = [
      "scripts/testnet-tps.ts",
      "scripts/cron-stress-worker.ts",
      "scripts/synthetic/ecosystem.config.cjs",
    ]

    for (const relative of files) {
      const content = await readFile(join(ROOT, relative), "utf-8")
      assert.doesNotMatch(
        content,
        HARDHAT_PRIVATE_KEY,
        `${relative} must not embed public Hardhat keys for live/testnet automation`,
      )
    }
  })

  it("deployment admin RPC defaults are disabled", async () => {
    for (const relative of DEPLOYMENT_ADMIN_CONFIGS) {
      const config = await readJsonConfig(join(ROOT, relative))
      assert.equal(config.enableAdminRpc, false, `${relative} must default enableAdminRpc to false`)
    }

    const generator = await readFile(join(ROOT, "scripts", "generate-genesis.sh"), "utf-8")
    assert.match(
      generator,
      /COC_ENABLE_ADMIN_RPC \?\? 'false'/,
      "generated configs must default admin RPC to disabled",
    )
    assert.doesNotMatch(
      generator,
      /COC_ENABLE_ADMIN_RPC \?\? 'true'/,
      "generated configs must not default admin RPC to enabled",
    )
  })

  it("public nginx edge blocks admin and debug method namespaces", async () => {
    const nginx = await readFile(join(DOCKER_DIR, "nginx", "coc-rpc.conf"), "utf-8")

    assert.match(nginx, /\(debug_\|admin_\)/, "nginx must block debug_ and admin_ namespaces")
    assert.doesNotMatch(nginx, /request_body ~\* "debug_"/, "nginx must not block only debug_")
  })

  it("gcloud operator CIDR is not world-open by default", async () => {
    const example = await readFile(join(ROOT, "scripts", "gcloud", "config.env.example"), "utf-8")
    const bootstrap = await readFile(join(ROOT, "scripts", "gcloud", "00-bootstrap-project.sh"), "utf-8")

    assert.doesNotMatch(
      example,
      /^export COC_GCP_OPERATOR_IP_CIDR="0\.0\.0\.0\/0"/m,
      "gcloud example must not default management ports to the whole internet",
    )
    assert.ok(
      example.includes("REPLACE_WITH_YOUR_OPERATOR_IP/32"),
      "gcloud example should force an operator-specific CIDR",
    )
    assert.ok(
      bootstrap.includes("COC_GCP_ALLOW_OPEN_OPERATOR_CIDR"),
      "bootstrap script should require an explicit escape hatch for 0.0.0.0/0",
    )
    assert.match(
      bootstrap,
      /refusing to open RPC\/SSH\/metrics management ports to 0\.0\.0\.0\/0/,
      "bootstrap script should fail closed for world-open management CIDRs",
    )
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
