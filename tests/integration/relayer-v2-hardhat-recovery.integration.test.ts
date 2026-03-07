import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  keccak256,
  parseEther,
  solidityPacked,
  toUtf8Bytes,
} from "ethers"
import type { SlashEvidence } from "../../services/verifier/anti-cheat-policy.ts"
import { EvidenceStore } from "../../runtime/lib/evidence-store.ts"
import { PendingChallengeStore } from "../../runtime/lib/pending-challenge-store.ts"
import { PoseV2DisputeExecutor } from "../../runtime/lib/pose-v2-dispute-executor.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")
const contractsDir = join(repoRoot, "contracts")
const hardhatCli = join(repoRoot, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const poseArtifact = JSON.parse(
  readFileSync(
    join(
      repoRoot,
      "contracts",
      "artifacts",
      "contracts-src",
      "settlement",
      "PoSeManagerV2.sol",
      "PoSeManagerV2.json",
    ),
    "utf8",
  ),
) as { abi: unknown[]; bytecode: string }

const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

function pairHash(a: string, b: string): string {
  const [x, y] = a <= b ? [a, b] : [b, a]
  return keccak256(solidityPacked(["bytes32", "bytes32"], [x, y]))
}

function hashEvidenceLeaf(leaf: {
  epoch: bigint
  nodeId: string
  nonce: string
  tipHash: string
  tipHeight: bigint
  latencyMs: number
  resultCode: number
  witnessBitmap: number
}): string {
  return keccak256(
    solidityPacked(
      ["uint64", "bytes32", "bytes16", "bytes32", "uint64", "uint32", "uint8", "uint32"],
      [leaf.epoch, leaf.nodeId, leaf.nonce, leaf.tipHash, leaf.tipHeight, leaf.latencyMs, leaf.resultCode, leaf.witnessBitmap],
    ),
  )
}

function buildSummaryHash(epochId: bigint, merkleRoot: string, sampleProofs: Array<{ leafIndex: number; leaf: string }>): string {
  let rolling = `0x${"0".repeat(64)}`
  for (const proof of sampleProofs) {
    rolling = keccak256(solidityPacked(["bytes32", "uint32", "bytes32"], [rolling, proof.leafIndex, proof.leaf]))
  }
  return keccak256(
    solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, merkleRoot, rolling, sampleProofs.length]),
  )
}

function createLogger() {
  return {
    info(_message: string, _data?: Record<string, unknown>) {},
    warn(_message: string, _data?: Record<string, unknown>) {},
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("failed to allocate free port"))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
    server.on("error", reject)
  })
}

async function startHardhatNode(port: number): Promise<{ process: ChildProcessWithoutNullStreams; url: string; logs: () => string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [hardhatCli, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: contractsDir,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""
  child.stdout.on("data", (chunk) => { output += String(chunk) })
  child.stderr.on("data", (chunk) => { output += String(chunk) })

  const url = `http://127.0.0.1:${port}`
  const provider = new JsonRpcProvider(url)
  const startedAt = Date.now()

  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`hardhat node exited early with code ${child.exitCode}\n${output}`)
    }
    try {
      await provider.getBlockNumber()
      return {
        process: child,
        url,
        logs: () => output,
        stop: async () => {
          if (child.exitCode !== null) return
          child.kill("SIGTERM")
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              if (child.exitCode === null) child.kill("SIGKILL")
            }, 3_000)
            child.once("exit", () => {
              clearTimeout(timer)
              resolve()
            })
          })
        },
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  child.kill("SIGKILL")
  throw new Error(`hardhat node did not start in time\n${output}`)
}

async function registerNode(manager: Contract, funder: { sendTransaction: (tx: { to: string; value: bigint }) => Promise<unknown> }, provider: JsonRpcProvider): Promise<{ operator: Wallet; nodeId: string; bond: bigint }> {
  const operator = Wallet.createRandom().connect(provider)
  const bond = parseEther("1")
  await funder.sendTransaction({ to: operator.address, value: parseEther("5") })

  const pubkey = operator.signingKey.publicKey
  const nodeId = keccak256(pubkey)
  const serviceCommitment = keccak256(toUtf8Bytes("svc-hardhat"))
  const endpointCommitment = keccak256(toUtf8Bytes(`ep-hardhat-${Date.now()}-${Math.random()}`))
  const metadataHash = keccak256(toUtf8Bytes("meta-hardhat"))
  const ownershipDigest = keccak256(solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address]))
  const ownershipSig = await operator.signMessage(Buffer.from(ownershipDigest.slice(2), "hex"))

  await (await manager.connect(operator).registerNode(
    nodeId,
    pubkey,
    7,
    serviceCommitment,
    endpointCommitment,
    metadataHash,
    ownershipSig,
    "0x",
    { value: bond },
  )).wait()

  return { operator, nodeId, bond }
}

function buildFaultEvidence(batchId: string, leaf: {
  epoch: bigint
  nodeId: string
  nonce: string
  tipHash: string
  tipHeight: bigint
  latencyMs: number
  resultCode: number
  witnessBitmap: number
}, leafHash: string): SlashEvidence {
  return {
    nodeId: leaf.nodeId,
    reasonCode: 3,
    evidenceHash: leafHash,
    rawEvidence: {
      protocolVersion: 2,
      batchId,
      merkleProof: [leafHash],
      evidenceLeaf: {
        epoch: leaf.epoch.toString(),
        nodeId: leaf.nodeId,
        nonce: leaf.nonce,
        tipHash: leaf.tipHash,
        tipHeight: leaf.tipHeight.toString(),
        latencyMs: leaf.latencyMs,
        resultCode: leaf.resultCode,
        witnessBitmap: leaf.witnessBitmap,
      },
      evidenceLeafHash: leafHash,
      faultType: 4,
    },
  }
}

function extractBatchId(manager: Contract, receipt: { logs?: readonly unknown[] }): string {
  const log = (receipt.logs ?? []).find((entry) => {
    try {
      return manager.interface.parseLog(entry as never)?.name === "BatchSubmittedV2"
    } catch {
      return false
    }
  })
  if (!log) throw new Error("BatchSubmittedV2 event not found")
  const parsed = manager.interface.parseLog(log as never)
  return String(parsed?.args?.batchId ?? parsed?.args?.[1])
}

class CrashOnceOpenChallengeContract {
  readonly interface
  private crashed = false
  private readonly inner: Contract

  constructor(inner: Contract) {
    this.inner = inner
    this.interface = inner.interface
  }

  async openChallenge(commitHash: string, overrides: { value: bigint }) {
    const tx = await this.inner.openChallenge(commitHash, overrides)
    if (this.crashed) return tx
    this.crashed = true
    return {
      hash: tx.hash,
      wait: async () => {
        await tx.wait()
        throw new Error("simulated relayer crash after openChallenge mined")
      },
    }
  }

  revealChallenge(...args: any[]) {
    return this.inner.revealChallenge(...args)
  }

  settleChallenge(...args: any[]) {
    return this.inner.settleChallenge(...args)
  }

  challenges(...args: any[]) {
    return this.inner.challenges(...args)
  }
}

test("relayer v2 recovery works against real Hardhat JSON-RPC + deployed PoSeManagerV2", async () => {
  const port = await getFreePort()
  const node = await startHardhatNode(port)
  const tempDir = mkdtempSync(join(tmpdir(), "coc-hardhat-recovery-"))
  const evidencePath = join(tempDir, "evidence-agent.jsonl")
  const pendingPath = join(tempDir, "pending-challenges-v2.json")

  try {
    const provider = new JsonRpcProvider(node.url)
    const deployerWallet = new Wallet(DEPLOYER_KEY, provider)
    const txSigner = new NonceManager(deployerWallet)
    const factory = new ContractFactory(poseArtifact.abi, poseArtifact.bytecode, txSigner)
    const manager = await factory.deploy()
    await manager.waitForDeployment()

    const network = await provider.getNetwork()
    await (await manager.initialize(network.chainId, await manager.getAddress(), parseEther("0.01"))).wait()
    await (await manager.setAllowEmptyWitnessSubmission(true)).wait()

    const registered = await registerNode(manager, txSigner, provider)

    const latestBlock = await provider.getBlock("latest")
    assert.ok(latestBlock)
    const epochId = BigInt(Math.floor(Number(latestBlock!.timestamp) / 3600))

    const leaf = {
      epoch: epochId,
      nodeId: registered.nodeId,
      nonce: `0x${"11".repeat(16)}`,
      tipHash: keccak256(toUtf8Bytes("hardhat-tip")),
      tipHeight: 1000n,
      latencyMs: 1500,
      resultCode: 7,
      witnessBitmap: 0,
    }
    const leafHash = hashEvidenceLeaf(leaf)
    const merkleRoot = pairHash(leafHash, leafHash)
    const sampleProofs = [{ leaf: leafHash, merkleProof: [leafHash], leafIndex: 0 }]
    const summaryHash = buildSummaryHash(epochId, merkleRoot, sampleProofs)

    const submitTx = await manager.submitBatchV2(epochId, merkleRoot, summaryHash, sampleProofs, 0, [])
    const batchId = extractBatchId(manager, await submitTx.wait())

    const evidenceStore = new EvidenceStore(1000, evidencePath)
    evidenceStore.push(buildFaultEvidence(batchId, leaf, leafHash))
    assert.equal(evidenceStore.size, 1)

    let currentEpoch = Number(epochId)
    const crashExecutor = new PoseV2DisputeExecutor({
      contract: new CrashOnceOpenChallengeContract(manager.connect(txSigner)) as never,
      provider,
      signer: deployerWallet,
      challengeBondWei: parseEther("0.01"),
      store: new PendingChallengeStore(pendingPath),
      logger: createLogger(),
      getCurrentEpoch: () => currentEpoch,
    })

    const drained = evidenceStore.drain()
    assert.equal(drained.length, 1)
    await crashExecutor.processPending()
    await crashExecutor.processEvidenceBatch(drained)

    const persistedAfterCrash = new PendingChallengeStore(pendingPath).list()
    assert.equal(persistedAfterCrash.length, 1)
    assert.equal(persistedAfterCrash[0]?.state, "opening")
    assert.ok(persistedAfterCrash[0]?.openTxHash)

    const recoveryExecutor = new PoseV2DisputeExecutor({
      contract: manager.connect(txSigner) as never,
      provider,
      signer: deployerWallet,
      challengeBondWei: parseEther("0.01"),
      store: new PendingChallengeStore(pendingPath),
      logger: createLogger(),
      getCurrentEpoch: () => currentEpoch,
    })

    let persistedAfterReveal = new PendingChallengeStore(pendingPath).list()
    for (let i = 0; i < 3; i += 1) {
      await recoveryExecutor.processPending()
      persistedAfterReveal = new PendingChallengeStore(pendingPath).list()
      if (persistedAfterReveal[0]?.state === "revealed") break
    }
    assert.equal(persistedAfterReveal.length, 1)
    assert.equal(persistedAfterReveal[0]?.state, "revealed")
    assert.ok(persistedAfterReveal[0]?.challengeId)

    await provider.send("evm_increaseTime", [5 * 3600])
    await provider.send("evm_mine", [])
    const advancedBlock = await provider.getBlock("latest")
    assert.ok(advancedBlock)
    currentEpoch = Math.floor(Number(advancedBlock!.timestamp) / 3600)

    let remaining = new PendingChallengeStore(pendingPath).size
    for (let i = 0; i < 3; i += 1) {
      await recoveryExecutor.processPending()
      remaining = new PendingChallengeStore(pendingPath).size
      if (remaining === 0) break
    }
    assert.equal(remaining, 0)

    const challengeId = persistedAfterReveal[0]!.challengeId!
    const challengeRecord = await manager.challenges(challengeId)
    assert.equal(challengeRecord.revealed, true)
    assert.equal(challengeRecord.settled, true)

    const nodeRecord = await manager.getNode(registered.nodeId)
    assert.equal(nodeRecord.bondAmount, parseEther("0.95"))
  } finally {
    await node.stop()
  }
})
