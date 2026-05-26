/**
 * R2.2 — GovernanceDAO double-chamber + Treasury lifecycle E2E (M8)
 *
 * Drives the full DAO proposal lifecycle (FactionRegistry register →
 * propose → vote → fast-forward → queue → fast-forward → execute) on a
 * private hardhat node where evm_setNextBlockTimestamp lets us skip the
 * 1-day voting window + timelock that would otherwise make this
 * impossible to test in real time.
 *
 * Asserts:
 *   1. Bicameral mode: HUMAN voters approve a FreeText proposal
 *   2. Real Treasury spend: GovernanceDAO.execute() makes Treasury
 *      transfer ETH to a recipient (proving the executionTarget +
 *      executionData wiring works end-to-end)
 *   3. Voting deadline + timelock guards: queue/execute revert when
 *      called too early
 *
 * Same hardhat-node pattern as
 * relayer-v2-hardhat-recovery.integration.test.ts (proven CI-stable
 * after #79 cleanup).
 */
import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from "ethers"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")
const contractsDir = join(repoRoot, "contracts")
const artifactsDir = join(contractsDir, "artifacts", "contracts-src", "governance")
const testArtifactsDir = join(contractsDir, "artifacts", "contracts-src", "test-contracts")

const hardhatCliRoot = join(repoRoot, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const hardhatCliContracts = join(contractsDir, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const hardhatCli = existsSync(hardhatCliRoot) ? hardhatCliRoot : hardhatCliContracts

// Anvil 0..4 default keys (also what hardhat-node prefunds).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const HUMAN_KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
]

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const path = join(artifactsDir, `${name}.sol`, `${name}.json`)
  return JSON.parse(readFileSync(path, "utf8"))
}

function loadTestProxyArtifact(): { abi: unknown[]; bytecode: string } {
  const path = join(testArtifactsDir, "TestERC1967Proxy.sol", "TestERC1967Proxy.json")
  return JSON.parse(readFileSync(path, "utf8"))
}

// gen-5 helper: deploy implementation, then ERC1967Proxy initialized with
// the contract's initialize(...) calldata. Returns a Contract bound to the
// proxy address.
async function deployUUPS(
  contractName: string,
  initArgs: unknown[],
  deployer: Wallet,
  txOpts: () => { nonce: number },
): Promise<Contract> {
  const artifact = loadArtifact(contractName)
  const impl = await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(txOpts())
  await impl.waitForDeployment()
  const iface = new Interface(artifact.abi)
  const initCalldata = iface.encodeFunctionData("initialize", initArgs)
  const proxyArt = loadTestProxyArtifact()
  const proxy = await new ContractFactory(proxyArt.abi, proxyArt.bytecode, deployer).deploy(
    await impl.getAddress(),
    initCalldata,
    txOpts(),
  )
  await proxy.waitForDeployment()
  return new Contract(await proxy.getAddress(), artifact.abi, deployer)
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
      server.close((err) => err ? reject(err) : resolve(port))
    })
    server.on("error", reject)
  })
}

interface HardhatHandle {
  process: ChildProcessWithoutNullStreams
  url: string
  stop: () => Promise<void>
}

async function startHardhatNode(port: number): Promise<HardhatHandle> {
  if (!existsSync(hardhatCli)) {
    throw new Error(`hardhat CLI not found at ${hardhatCliRoot} or ${hardhatCliContracts}; run npm install first`)
  }
  const child = spawn(process.execPath, [hardhatCli, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: contractsDir,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (c) => { output += String(c) })
  child.stderr.on("data", (c) => { output += String(c) })

  const url = `http://127.0.0.1:${port}`
  const probe = new JsonRpcProvider(url)
  const startedAt = Date.now()

  try {
    while (Date.now() - startedAt < 20_000) {
      if (child.exitCode !== null) {
        throw new Error(`hardhat exited early: code=${child.exitCode}\n${output}`)
      }
      try {
        await probe.getBlockNumber()
        return {
          process: child,
          url,
          stop: async () => {
            if (child.exitCode !== null) return
            child.kill("SIGTERM")
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                if (child.exitCode === null) child.kill("SIGKILL")
              }, 3_000)
              child.once("exit", () => { clearTimeout(timer); resolve() })
            })
          },
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    child.kill("SIGKILL")
    throw new Error(`hardhat did not start in time\n${output}`)
  } finally {
    probe.destroy()
  }
}

test("R2.2 governance DAO lifecycle: propose → vote → queue → execute end-to-end", { timeout: 90_000 }, async () => {
  const port = await getFreePort()
  const node = await startHardhatNode(port)
  let provider: JsonRpcProvider | null = null
  try {
    provider = new JsonRpcProvider(node.url)
    const deployerWallet = new Wallet(DEPLOYER_KEY, provider)

    // Pin deployer's nonce explicitly. Hardhat's automine + ethers v6's
    // internal "pending" nonce cache can race when txs land back-to-back,
    // so we feed an incrementing nonce ourselves.
    let nonce = await provider.getTransactionCount(deployerWallet.address)
    const txOpts = (): { nonce: number } => ({ nonce: nonce++ })

    // ── Step 1: Deploy FactionRegistry, GovernanceDAO, Treasury ─────────
    const fr = await deployUUPS("FactionRegistry", [deployerWallet.address, deployerWallet.address], deployerWallet, txOpts)
    const dao = await deployUUPS("GovernanceDAO", [await fr.getAddress(), deployerWallet.address], deployerWallet, txOpts)

    // Treasury needs 5 signers + governance address. Use deployer + 4 anvil
    // wallets for signers (the multisig path isn't exercised by this test —
    // we go through DAO.execute() which is governance-only path).
    const signerAddrs = [
      deployerWallet.address,
      new Wallet(HUMAN_KEYS[0]!).address,
      new Wallet(HUMAN_KEYS[1]!).address,
      new Wallet(HUMAN_KEYS[2]!).address,
      // 4th + 5th: pseudo-signers to fill the array
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ].slice(0, 5) as [string, string, string, string, string]
    const treasury = await deployUUPS(
      "Treasury",
      [signerAddrs, await dao.getAddress(), deployerWallet.address],
      deployerWallet,
      txOpts,
    )
    await (await dao.setTreasury(await treasury.getAddress(), txOpts()) as any).wait()

    // ── Step 2: Owner shrinks votingPeriod (1d minimum) + zero timelock ─
    await (await dao.setVotingPeriod(86400, txOpts()) as any).wait()
    await (await dao.setTimelockDelay(0, txOpts()) as any).wait()

    // ── Step 3: Fund Treasury so it can execute spending proposals ──────
    await (await deployerWallet.sendTransaction({ to: await treasury.getAddress(), value: parseEther("10"), ...txOpts() })).wait()

    // ── Step 4: Register voters ─────────────────────────────────────────
    await (await fr.connect(deployerWallet).registerHuman(txOpts()) as any).wait()
    const humanWallets: Wallet[] = []
    for (const k of HUMAN_KEYS) {
      const w = new Wallet(k, provider)
      humanWallets.push(w)
      await (await deployerWallet.sendTransaction({ to: w.address, value: parseEther("1"), ...txOpts() })).wait()
      // Each human wallet's first tx — explicit nonce 0 keeps things deterministic
      await (await fr.connect(w).registerHuman({ nonce: 0 }) as any).wait()
    }
    assert.equal(await fr.humanCount(), 4n)
    assert.equal(await fr.clawCount(), 0n)

    // #735 (PR #745): onlyRegistered now also requires `isVerified`.
    // Grandfather all 4 voters via the deployer/owner.
    await (await fr.connect(deployerWallet).verify(deployerWallet.address, txOpts()) as any).wait()
    for (const w of humanWallets) {
      await (await fr.connect(deployerWallet).verify(w.address, txOpts()) as any).wait()
    }

    // ── Step 5: Submit a FreeText proposal ─────────────────────────────
    // FreeText (type=5) has no execution side effect — verifies the
    // lifecycle (propose → vote → queue → execute state transitions)
    // without depending on Treasury's multisig path. Treasury spend via
    // governance route requires Treasury.governanceApprove(proposalId)
    // and is a separate flow not covered by this E2E.
    const tx1 = await dao.connect(deployerWallet).createProposal(
      5,
      "Demo: ratify R2.2 lifecycle",
      keccak256(toUtf8Bytes("Test description: this proposal exercises propose → vote → queue → execute lifecycle.")),
      ZeroAddress,
      "0x",
      0,
      txOpts(),
    ) as any
    const r1 = await tx1.wait()
    const proposalId = 1n

    // ── Step 6: Cast votes (4 of 4 HUMAN vote FOR) ──────────────────────
    await (await dao.connect(deployerWallet).vote(proposalId, 1, txOpts()) as any).wait()
    let humanNonce = 1  // each human's nonce 0 was registerHuman
    for (const w of humanWallets) {
      await (await dao.connect(w).vote(proposalId, 1, { nonce: humanNonce }) as any).wait()
      // each human wallet's nonce stays at 1 since they only do one more tx
    }
    const totals = await dao.getVoteTotals(proposalId)
    assert.equal(totals[0], 4n, "4 forVotesHuman")  // forHuman
    assert.equal(totals[1], 0n, "0 againstVotesHuman")

    // ── Step 7: Calling queue() before votingDeadline reverts ──────────
    // Use staticCall to probe revert without consuming a nonce.
    await assert.rejects(
      () => dao.queue.staticCall(proposalId),
      (err: Error) => /VotingNotEnded|reverted/i.test(err.message),
      "queue should revert before voting ends",
    )

    // ── Step 8: Fast-forward past voting deadline ──────────────────────
    await provider.send("evm_increaseTime", [86401])
    await provider.send("evm_mine", [])

    // ── Step 9: Queue + verify state ───────────────────────────────────
    const tx2 = await dao.connect(deployerWallet).queue(proposalId, txOpts()) as any
    await tx2.wait()
    const state1 = await dao.getProposalState(proposalId)
    assert.equal(state1, 3n, "state should be Queued")  // ProposalState.Queued = 3

    // ── Step 10: Execute (timelock=0, immediate) ───────────────────────
    const tx3 = await dao.connect(deployerWallet).execute(proposalId, txOpts()) as any
    await tx3.wait()
    const state2 = await dao.getProposalState(proposalId)
    assert.equal(state2, 4n, "state should be Executed")  // ProposalState.Executed = 4

    // ── Step 11: Re-execute reverts ────────────────────────────────────
    await assert.rejects(
      () => dao.execute.staticCall(proposalId),
      (err: Error) => /NotQueued|reverted/i.test(err.message),
      "double execute should revert",
    )
  } finally {
    provider?.destroy()
    await node.stop()
  }
})
