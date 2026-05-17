/**
 * R2.2 — GovernanceDAO extended-coverage E2E (M8 follow-up)
 *
 * Complements governance-dao-lifecycle.integration.test.ts (which already
 * covers: FactionRegistry HUMAN registration, a single-chamber FreeText
 * propose→vote→queue→execute lifecycle, a Treasury ETH-spend execution via
 * DAO.execute(), and the early-queue / double-execute revert guards).
 *
 * This file adds the governance paths NOT exercised there:
 *   1. Treasury 5% spend cap + 3-of-5 multisig: a within-cap signer
 *      withdrawal succeeds; an over-cap one reverts (ExceedsSpendingCap)
 *      until the DAO grants governanceApprove via a real execute() call;
 *      under-confirmed withdrawals revert (NotEnoughConfirmations).
 *   2. Real bicameral voting: CLAW voters registered via FactionRegistry,
 *      bicameralEnabled = true — a proposal passes only when BOTH chambers
 *      reach approvalPercent, and is rejected when only one chamber does.
 *   3. Rejection paths: a proposal with against-majority and a proposal
 *      with sub-quorum turnout both end Rejected; queue() leaves them
 *      un-queued and execute() reverts (NotQueued).
 *   4. Parameter-change proposal: an execute()-driven call to
 *      Treasury.governanceApprove flips on-chain state (governanceApproved
 *      false → true), proving executionData parameter mutation works.
 *
 * Same hardhat-node-spawn pattern as governance-dao-lifecycle.integration.
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

const hardhatCliRoot = join(repoRoot, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const hardhatCliContracts = join(contractsDir, "node_modules", "hardhat", "internal", "cli", "bootstrap.js")
const hardhatCli = existsSync(hardhatCliRoot) ? hardhatCliRoot : hardhatCliContracts

// Anvil 0..9 default keys (also what hardhat-node prefunds).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
// Indices 1..4: HUMAN-chamber voters / Treasury multisig signers.
const ANVIL_KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 3
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // 4
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 5
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // 6
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // 7
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // 8
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // 9
]

function loadArtifact(name: string): { abi: unknown[]; bytecode: string } {
  const path = join(artifactsDir, `${name}.sol`, `${name}.json`)
  return JSON.parse(readFileSync(path, "utf8"))
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
      server.close((err) => (err ? reject(err) : resolve(port)))
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

/**
 * Deploys FactionRegistry + GovernanceDAO + Treasury, shrinks the voting
 * window to the 1-day minimum and sets timelock to 0, funds the Treasury,
 * and returns ready-to-use contract handles bound to the deployer.
 *
 * The Treasury's 5 multisig signers are anvil wallets 0..4 (the deployer
 * plus indices 1..3 and 4), so the 3-of-5 path is genuinely exercisable.
 */
async function deployGovernanceStack(provider: JsonRpcProvider) {
  const deployer = new Wallet(DEPLOYER_KEY, provider)
  let nonce = await provider.getTransactionCount(deployer.address)
  const txOpts = (): { nonce: number } => ({ nonce: nonce++ })

  const fr = await new ContractFactory(
    loadArtifact("FactionRegistry").abi,
    loadArtifact("FactionRegistry").bytecode,
    deployer,
  ).deploy(txOpts())
  await fr.waitForDeployment()

  const dao = await new ContractFactory(
    loadArtifact("GovernanceDAO").abi,
    loadArtifact("GovernanceDAO").bytecode,
    deployer,
  ).deploy(await fr.getAddress(), txOpts())
  await dao.waitForDeployment()

  // 5 real multisig signers: deployer + anvil 1..4.
  const signerWallets = [deployer, ...ANVIL_KEYS.slice(0, 4).map((k) => new Wallet(k, provider))]
  const signerAddrs = signerWallets.map((w) => w.address) as [string, string, string, string, string]
  const treasury = await new ContractFactory(
    loadArtifact("Treasury").abi,
    loadArtifact("Treasury").bytecode,
    deployer,
  ).deploy(signerAddrs, await dao.getAddress(), txOpts())
  await treasury.waitForDeployment()

  await (await (dao.setTreasury(await treasury.getAddress(), txOpts()) as any)).wait()
  await (await (dao.setVotingPeriod(86400, txOpts()) as any)).wait()
  await (await (dao.setTimelockDelay(0, txOpts()) as any)).wait()

  // Fund treasury with 100 ETH so cap math is round (cap = 5 ETH).
  await (await deployer.sendTransaction({ to: await treasury.getAddress(), value: parseEther("100"), ...txOpts() })).wait()

  return { deployer, txOpts, fr, dao, treasury, signerWallets }
}

/** Fast-forward the hardhat clock past the (already shrunk) voting window. */
async function fastForwardPastVoting(provider: JsonRpcProvider): Promise<void> {
  await provider.send("evm_increaseTime", [86401])
  await provider.send("evm_mine", [])
}

/**
 * Net balance change of `address` caused by the tx mined in `receipt`,
 * measured at the receipt's block versus its parent. Explicit block tags
 * sidestep ethers v6's "latest" balance caching, which can otherwise
 * report a stale value immediately after tx.wait() resolves.
 */
async function balanceDeltaOf(
  provider: JsonRpcProvider,
  address: string,
  receipt: { blockNumber: number },
): Promise<bigint> {
  const at = await provider.getBalance(address, receipt.blockNumber)
  const before = await provider.getBalance(address, receipt.blockNumber - 1)
  return at - before
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scenario 1 — Treasury 5% spend cap + 3-of-5 multisig
 * ──────────────────────────────────────────────────────────────────────── */
test("Treasury: 3-of-5 multisig + 5% spend cap (within-cap ok, over-cap needs governance)",
  { timeout: 120_000 },
  async () => {
    const port = await getFreePort()
    const node = await startHardhatNode(port)
    let provider: JsonRpcProvider | null = null
    try {
      provider = new JsonRpcProvider(node.url)
      const { deployer, txOpts, fr, dao, treasury, signerWallets } = await deployGovernanceStack(provider)
      const treasuryAddr = await treasury.getAddress()

      // Prefund the 4 non-deployer signers so they can send confirmations.
      for (const w of signerWallets.slice(1)) {
        await (await deployer.sendTransaction({ to: w.address, value: parseEther("1"), ...txOpts() })).wait()
      }
      // Per-signer nonce tracker (each signer's first tx is nonce 0).
      const signerNonce = new Map<string, number>()
      const next = (w: Wallet): { nonce: number } => {
        const n = signerNonce.get(w.address) ?? 0
        signerNonce.set(w.address, n + 1)
        return { nonce: n }
      }
      // deployer shares its tracked nonce with txOpts() — keep it consistent.
      const proposeAs = signerWallets[0]! // deployer

      // ── 1a. Within-cap withdrawal (cap = 5% of 100 = 5 ETH) ──────────────
      // Recipient is a pure-numeric address — no EIP-55 checksum ambiguity.
      const recipient = "0x0000000000000000000000000000000000001234"
      const inCapAmount = parseEther("4") // < 5 ETH cap

      // proposeWithdrawal from deployer counts confirmation #1.
      await (await (treasury.connect(proposeAs).proposeWithdrawal(recipient, inCapAmount, txOpts()) as any)).wait()
      const wId0 = 0n

      // ── 1b. Under-confirmed execute reverts (only 1/3 confirmations) ─────
      await assert.rejects(
        () => treasury.connect(proposeAs).getFunction("executeWithdrawal").staticCall(wId0),
        (err: Error) => /NotEnoughConfirmations|reverted/i.test(err.message),
        "executeWithdrawal must revert with only 1 confirmation",
      )

      // Signers 1 and 2 confirm → reaches 3/5.
      await (await (treasury.connect(signerWallets[1]!).confirmWithdrawal(wId0, next(signerWallets[1]!)) as any)).wait()
      await (await (treasury.connect(signerWallets[2]!).confirmWithdrawal(wId0, next(signerWallets[2]!)) as any)).wait()

      // Now 3/5 — within-cap withdrawal executes.
      const execRcpt0 = await (await (treasury.connect(proposeAs).executeWithdrawal(wId0, txOpts()) as any)).wait()
      assert.equal(
        await balanceDeltaOf(provider, recipient, execRcpt0),
        inCapAmount,
        "recipient received within-cap 4 ETH",
      )

      // ── 1c. Over-cap withdrawal reverts even with 3/5 confirmations ──────
      // Treasury balance is now 96 ETH → cap = 4.8 ETH. Request 20 ETH.
      const overCapAmount = parseEther("20")
      await (await (treasury.connect(proposeAs).proposeWithdrawal(recipient, overCapAmount, txOpts()) as any)).wait()
      const wId1 = 1n
      await (await (treasury.connect(signerWallets[1]!).confirmWithdrawal(wId1, next(signerWallets[1]!)) as any)).wait()
      await (await (treasury.connect(signerWallets[2]!).confirmWithdrawal(wId1, next(signerWallets[2]!)) as any)).wait()

      await assert.rejects(
        () => treasury.connect(proposeAs).getFunction("executeWithdrawal").staticCall(wId1),
        (err: Error) => /ExceedsSpendingCap|reverted/i.test(err.message),
        "over-cap withdrawal must revert without governance approval",
      )

      // ── 1d. DAO grants governanceApprove via a real execute() proposal ──
      await (await (fr.connect(deployer).registerHuman(txOpts()) as any)).wait()
      const treasuryIface = new Interface(loadArtifact("Treasury").abi as any)
      const approveData = treasuryIface.encodeFunctionData("governanceApprove", [wId1])
      await (await (dao.connect(deployer).createProposal(
        3, // ProposalType.TreasurySpend
        "Approve over-cap Treasury withdrawal #1",
        keccak256(toUtf8Bytes("governance ratifies the 20 ETH over-cap withdrawal")),
        treasuryAddr,
        approveData,
        0,
        txOpts(),
      ) as any)).wait()
      const proposalId = 1n
      await (await (dao.connect(deployer).vote(proposalId, 1, txOpts()) as any)).wait()
      await fastForwardPastVoting(provider)
      await (await (dao.connect(deployer).queue(proposalId, txOpts()) as any)).wait()
      await (await (dao.connect(deployer).execute(proposalId, txOpts()) as any)).wait()

      // ── 1e. After governance approval the over-cap withdrawal succeeds ──
      const execRcpt1 = await (await (treasury.connect(proposeAs).executeWithdrawal(wId1, txOpts()) as any)).wait()
      assert.equal(
        await balanceDeltaOf(provider, recipient, execRcpt1),
        overCapAmount,
        "over-cap 20 ETH paid after governance approval",
      )
    } finally {
      provider?.destroy()
      await node.stop()
    }
  })

/* ─────────────────────────────────────────────────────────────────────────
 * Scenario 2 — Real bicameral (two-chamber) voting
 * ──────────────────────────────────────────────────────────────────────── */
test("GovernanceDAO bicameral: passes only when BOTH HUMAN and CLAW chambers approve",
  { timeout: 120_000 },
  async () => {
    const port = await getFreePort()
    const node = await startHardhatNode(port)
    let provider: JsonRpcProvider | null = null
    try {
      provider = new JsonRpcProvider(node.url)
      const { deployer, txOpts, fr, dao } = await deployGovernanceStack(provider)

      // Enable bicameral mode — both chambers must independently hit 60%.
      await (await (dao.connect(deployer).setBicameralEnabled(true, txOpts()) as any)).wait()
      assert.equal(await dao.bicameralEnabled(), true)

      // 2 HUMAN voters (anvil 1,2) + 2 CLAW voters (anvil 3,4).
      const humans = ANVIL_KEYS.slice(0, 2).map((k) => new Wallet(k, provider!))
      const claws = ANVIL_KEYS.slice(2, 4).map((k) => new Wallet(k, provider!))
      for (const w of [...humans, ...claws]) {
        await (await deployer.sendTransaction({ to: w.address, value: parseEther("1"), ...txOpts() })).wait()
      }
      // deployer registers HUMAN too (3 HUMAN total).
      await (await (fr.connect(deployer).registerHuman(txOpts()) as any)).wait()
      for (const w of humans) {
        await (await (fr.connect(w).registerHuman({ nonce: 0 }) as any)).wait()
      }
      // CLAW registration needs an ECDSA attestation. FactionRegistry expects
      // a signature recoverable to msg.sender over the eth-signed-message of
      // keccak256(abi.encodePacked(agentId, msg.sender)). ethers' signMessage
      // applies the "\x19Ethereum Signed Message:\n" prefix, so signing the
      // raw 32-byte inner hash reproduces the contract's expectation exactly.
      for (let i = 0; i < claws.length; i++) {
        const w = claws[i]!
        const agentId = keccak256(toUtf8Bytes(`coc-agent-${i}`))
        // abi.encodePacked(bytes32, address) == 32-byte hash || 20-byte addr
        const packed = agentId + w.address.slice(2).toLowerCase()
        const innerHash = keccak256(packed)
        const attestation = await w.signMessage(Buffer.from(innerHash.slice(2), "hex"))
        await (await (fr.connect(w).registerClaw(agentId, attestation, { nonce: 0 }) as any)).wait()
      }
      assert.equal(await fr.humanCount(), 3n, "3 HUMAN registered")
      assert.equal(await fr.clawCount(), 2n, "2 CLAW registered")

      const proposalIface = (proposer: Wallet, title: string) =>
        dao.connect(proposer).createProposal(
          5, // FreeText — lifecycle only, no execution side effect
          title,
          keccak256(toUtf8Bytes(title)),
          ZeroAddress,
          "0x",
          0,
          txOpts(),
        ) as any

      // ── 2a. Only HUMAN chamber approves → bicameral FAILS ───────────────
      // Proposal 1: all 3 HUMAN FOR, both CLAW AGAINST.
      await (await proposalIface(deployer, "Bicameral: human-only support")).wait()
      const p1 = 1n
      await (await (dao.connect(deployer).vote(p1, 1, txOpts()) as any)).wait()
      await (await (dao.connect(humans[0]!).vote(p1, 1, { nonce: 1 }) as any)).wait()
      await (await (dao.connect(humans[1]!).vote(p1, 1, { nonce: 1 }) as any)).wait()
      await (await (dao.connect(claws[0]!).vote(p1, 0, { nonce: 1 }) as any)).wait()
      await (await (dao.connect(claws[1]!).vote(p1, 0, { nonce: 1 }) as any)).wait()

      await fastForwardPastVoting(provider)
      await (await (dao.connect(deployer).queue(p1, txOpts()) as any)).wait()
      assert.equal(
        await dao.getProposalState(p1),
        2n, // Rejected
        "human-only-approved proposal must be Rejected under bicameral",
      )
      await assert.rejects(
        () => dao.getFunction("execute").staticCall(p1),
        (err: Error) => /NotQueued|reverted/i.test(err.message),
        "execute() must revert for a bicameral-rejected proposal",
      )

      // ── 2b. BOTH chambers approve → bicameral PASSES ────────────────────
      // Proposal 2: all 3 HUMAN FOR, both CLAW FOR.
      await (await proposalIface(deployer, "Bicameral: both chambers support")).wait()
      const p2 = 2n
      await (await (dao.connect(deployer).vote(p2, 1, txOpts()) as any)).wait()
      await (await (dao.connect(humans[0]!).vote(p2, 1, { nonce: 2 }) as any)).wait()
      await (await (dao.connect(humans[1]!).vote(p2, 1, { nonce: 2 }) as any)).wait()
      await (await (dao.connect(claws[0]!).vote(p2, 1, { nonce: 2 }) as any)).wait()
      await (await (dao.connect(claws[1]!).vote(p2, 1, { nonce: 2 }) as any)).wait()

      await fastForwardPastVoting(provider)
      await (await (dao.connect(deployer).queue(p2, txOpts()) as any)).wait()
      assert.equal(await dao.getProposalState(p2), 3n, "both-chambers proposal must be Queued")
      await (await (dao.connect(deployer).execute(p2, txOpts()) as any)).wait()
      assert.equal(await dao.getProposalState(p2), 4n, "both-chambers proposal Executed")
    } finally {
      provider?.destroy()
      await node.stop()
    }
  })

/* ─────────────────────────────────────────────────────────────────────────
 * Scenario 3 — Rejection paths (against-majority + sub-quorum)
 * ──────────────────────────────────────────────────────────────────────── */
test("GovernanceDAO rejection paths: against-majority and sub-quorum proposals cannot be enacted",
  { timeout: 120_000 },
  async () => {
    const port = await getFreePort()
    const node = await startHardhatNode(port)
    let provider: JsonRpcProvider | null = null
    try {
      provider = new JsonRpcProvider(node.url)
      const { deployer, txOpts, fr, dao } = await deployGovernanceStack(provider)

      // 5 HUMAN voters: deployer + anvil 1..4 (single-chamber / simple majority).
      const voters = ANVIL_KEYS.slice(0, 4).map((k) => new Wallet(k, provider!))
      for (const w of voters) {
        await (await deployer.sendTransaction({ to: w.address, value: parseEther("1"), ...txOpts() })).wait()
      }
      await (await (fr.connect(deployer).registerHuman(txOpts()) as any)).wait()
      for (const w of voters) {
        await (await (fr.connect(w).registerHuman({ nonce: 0 }) as any)).wait()
      }
      assert.equal(await fr.humanCount(), 5n, "5 HUMAN registered")

      const mkProposal = (title: string) =>
        dao.connect(deployer).createProposal(
          5, title, keccak256(toUtf8Bytes(title)), ZeroAddress, "0x", 0, txOpts(),
        ) as any

      // ── 3a. Against-majority: 5 votes cast (quorum met), 1 FOR / 4 AGAINST ─
      await (await mkProposal("Rejection: against-majority")).wait()
      const p1 = 1n
      await (await (dao.connect(deployer).vote(p1, 1, txOpts()) as any)).wait() // FOR
      for (const w of voters) {
        await (await (dao.connect(w).vote(p1, 0, { nonce: 1 }) as any)).wait() // AGAINST
      }
      const totals1 = await dao.getVoteTotals(p1)
      assert.equal(totals1[0], 1n, "1 forVotesHuman")
      assert.equal(totals1[1], 4n, "4 againstVotesHuman")

      await fastForwardPastVoting(provider)
      // getProposalState should already report Rejected (approval 20% < 60%).
      assert.equal(await dao.getProposalState(p1), 2n, "against-majority proposal Rejected pre-queue")
      await (await (dao.connect(deployer).queue(p1, txOpts()) as any)).wait()
      assert.equal(await dao.getProposalState(p1), 2n, "still Rejected after queue()")
      await assert.rejects(
        () => dao.getFunction("execute").staticCall(p1),
        (err: Error) => /NotQueued|reverted/i.test(err.message),
        "execute() must revert for an against-majority proposal",
      )

      // ── 3b. Sub-quorum: only 1 of 5 registered voters turns out (20% < 40%) ─
      await (await mkProposal("Rejection: sub-quorum turnout")).wait()
      const p2 = 2n
      await (await (dao.connect(deployer).vote(p2, 1, txOpts()) as any)).wait() // single FOR vote
      const totals2 = await dao.getVoteTotals(p2)
      assert.equal(totals2[0], 1n, "1 forVotesHuman")

      await fastForwardPastVoting(provider)
      assert.equal(await dao.getProposalState(p2), 2n, "sub-quorum proposal Rejected (turnout below quorum)")
      await (await (dao.connect(deployer).queue(p2, txOpts()) as any)).wait()
      assert.equal(await dao.getProposalState(p2), 2n, "sub-quorum still Rejected after queue()")
      await assert.rejects(
        () => dao.getFunction("execute").staticCall(p2),
        (err: Error) => /NotQueued|reverted/i.test(err.message),
        "execute() must revert for a sub-quorum proposal",
      )
    } finally {
      provider?.destroy()
      await node.stop()
    }
  })

/* ─────────────────────────────────────────────────────────────────────────
 * Scenario 4 — Parameter-change proposal (executionData mutates on-chain state)
 * ──────────────────────────────────────────────────────────────────────── */
test("GovernanceDAO parameter-change: execute() runs executionData and mutates target state",
  { timeout: 120_000 },
  async () => {
    const port = await getFreePort()
    const node = await startHardhatNode(port)
    let provider: JsonRpcProvider | null = null
    try {
      provider = new JsonRpcProvider(node.url)
      const { deployer, txOpts, fr, dao, treasury, signerWallets } = await deployGovernanceStack(provider)
      const treasuryAddr = await treasury.getAddress()

      // Prepare an over-cap Treasury withdrawal proposal whose
      // `governanceApproved` flag is the parameter the DAO will flip.
      await (await deployer.sendTransaction({ to: signerWallets[1]!.address, value: parseEther("1"), ...txOpts() })).wait()
      // Pure-numeric address — avoids EIP-55 checksum validation.
      const recipient = "0x0000000000000000000000000000000000005678"
      const overCap = parseEther("50") // > 5 ETH cap on 100 ETH balance
      await (await (treasury.connect(deployer).proposeWithdrawal(recipient, overCap, txOpts()) as any)).wait()
      const wId = 0n

      // Read the parameter BEFORE the governance proposal executes.
      // Treasury.proposals(id) returns the public-mapping tuple; the
      // `governanceApproved` bool is the 5th field (index 4).
      const treasuryReader = new Contract(treasuryAddr, loadArtifact("Treasury").abi as any, provider)
      const preState = await treasuryReader.proposals(wId)
      assert.equal(preState[4], false, "governanceApproved starts false")

      // ── Governance proposal that calls Treasury.governanceApprove(wId) ──
      await (await (fr.connect(deployer).registerHuman(txOpts()) as any)).wait()
      const treasuryIface = new Interface(loadArtifact("Treasury").abi as any)
      const execData = treasuryIface.encodeFunctionData("governanceApprove", [wId])

      await (await (dao.connect(deployer).createProposal(
        2, // ProposalType.ParameterChange
        "ParameterChange: enable over-cap Treasury withdrawal #0",
        keccak256(toUtf8Bytes("flip Treasury proposal #0 governanceApproved to true")),
        treasuryAddr,
        execData,
        0,
        txOpts(),
      ) as any)).wait()
      const proposalId = 1n

      await (await (dao.connect(deployer).vote(proposalId, 1, txOpts()) as any)).wait()
      await fastForwardPastVoting(provider)
      await (await (dao.connect(deployer).queue(proposalId, txOpts()) as any)).wait()
      assert.equal(await dao.getProposalState(proposalId), 3n, "parameter-change proposal Queued")

      // Parameter is still unchanged until execute() runs.
      const midState = await treasuryReader.proposals(wId)
      assert.equal(midState[4], false, "governanceApproved still false before execute()")

      await (await (dao.connect(deployer).execute(proposalId, txOpts()) as any)).wait()
      assert.equal(await dao.getProposalState(proposalId), 4n, "parameter-change proposal Executed")

      // ── Assert the parameter ACTUALLY changed on the target contract ────
      const postState = await treasuryReader.proposals(wId)
      assert.equal(postState[4], true, "governanceApproved flipped to true by execute()")
    } finally {
      provider?.destroy()
      await node.stop()
    }
  })
