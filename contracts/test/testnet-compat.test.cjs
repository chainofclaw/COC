/**
 * COC Testnet Compatibility Tests
 *
 * Validates EVM compatibility on a live COC network:
 *   - Native ETH/COC transfers between multiple accounts
 *   - ERC-20 token full lifecycle
 *   - ERC-721 NFT minting and transfers
 *   - Staking contract (deposit/withdraw/rewards)
 *   - Multi-sig wallet (submit/confirm/execute)
 *
 * Run locally:  npx hardhat test test/testnet-compat.test.cjs
 * Run on testnet: COC_RPC_URL=http://199.192.16.79:28780 \
 *   DEPLOYER_PRIVATE_KEY=0xac09... npx hardhat test test/testnet-compat.test.cjs --network coc
 */
const { expect } = require("chai")
const { ethers } = require("hardhat")

const FUND_AMOUNT = ethers.parseEther("10")
const NUM_TEST_WALLETS = 10

describe("COC Testnet Compatibility", function () {
  this.timeout(300_000) // 5 min for testnet latency

  let deployer
  let wallets

  before(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0]

    // Create deterministic test wallets
    wallets = []
    for (let i = 0; i < NUM_TEST_WALLETS; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider)
      wallets.push(w)
    }

    // Fund test wallets from deployer
    console.log(`    Funding ${NUM_TEST_WALLETS} test wallets...`)
    for (const w of wallets) {
      const tx = await deployer.sendTransaction({ to: w.address, value: FUND_AMOUNT })
      await tx.wait()
    }
    console.log(`    All wallets funded with ${ethers.formatEther(FUND_AMOUNT)} ETH each`)
  })

  // ─── 1. Native ETH Transfers ───

  describe("1. Native ETH Transfers", function () {
    it("sends ETH between test wallets", async function () {
      const sender = wallets[0]
      const receiver = wallets[1]
      const amount = ethers.parseEther("1")

      const balBefore = await ethers.provider.getBalance(receiver.address)
      const tx = await sender.sendTransaction({ to: receiver.address, value: amount })
      const receipt = await tx.wait()

      const balAfter = await ethers.provider.getBalance(receiver.address)
      expect(balAfter - balBefore).to.equal(amount)

      console.log(`      gas: ${receipt.gasUsed}, block: ${receipt.blockNumber}`)
    })

    it("batch transfers between 10 wallets", async function () {
      const results = []
      for (let i = 0; i < wallets.length; i++) {
        const sender = wallets[i]
        const receiver = wallets[(i + 1) % wallets.length]
        const tx = await sender.sendTransaction({ to: receiver.address, value: ethers.parseEther("0.1") })
        const receipt = await tx.wait()
        results.push({ gas: receipt.gasUsed, block: receipt.blockNumber })
      }
      console.log(`      ${results.length} transfers, avg gas: ${results.reduce((s, r) => s + r.gas, 0n) / BigInt(results.length)}`)
    })

    it("verifies balance consistency after batch", async function () {
      for (const w of wallets) {
        const bal = await ethers.provider.getBalance(w.address)
        expect(bal).to.be.gt(0n)
      }
    })
  })

  // ─── 2. ERC-20 Token ───

  describe("2. ERC-20 Token", function () {
    let token

    before(async function () {
      const Factory = await ethers.getContractFactory("ERC20Mock", deployer)
      token = await Factory.deploy(ethers.parseEther("100000000"))
      await token.waitForDeployment()
      console.log(`      ERC20Mock deployed at ${await token.getAddress()}`)
    })

    it("has correct initial state", async function () {
      expect(await token.name()).to.equal("Test Token")
      expect(await token.symbol()).to.equal("TEST")
      expect(await token.decimals()).to.equal(18n)
      expect(await token.totalSupply()).to.equal(ethers.parseEther("100000000"))
      expect(await token.balanceOf(deployer.address)).to.equal(ethers.parseEther("100000000"))
    })

    it("transfer works", async function () {
      const amount = ethers.parseEther("1000")
      const tx = await token.transfer(wallets[0].address, amount)
      const receipt = await tx.wait()
      expect(await token.balanceOf(wallets[0].address)).to.equal(amount)
      console.log(`      transfer gas: ${receipt.gasUsed}`)
    })

    it("approve + transferFrom works", async function () {
      const amount = ethers.parseEther("500")
      const tokenAsW0 = token.connect(wallets[0])

      await (await tokenAsW0.approve(wallets[1].address, amount)).wait()
      expect(await token.allowance(wallets[0].address, wallets[1].address)).to.equal(amount)

      const tokenAsW1 = token.connect(wallets[1])
      const tx = await tokenAsW1.transferFrom(wallets[0].address, wallets[2].address, amount)
      const receipt = await tx.wait()

      expect(await token.balanceOf(wallets[2].address)).to.equal(amount)
      console.log(`      transferFrom gas: ${receipt.gasUsed}`)
    })

    it("batch transfers (10 accounts x 10 transfers)", async function () {
      // Distribute tokens to all wallets
      for (const w of wallets) {
        await (await token.transfer(w.address, ethers.parseEther("100"))).wait()
      }

      let totalGas = 0n
      let count = 0
      for (let i = 0; i < wallets.length; i++) {
        const sender = wallets[i]
        const receiver = wallets[(i + 1) % wallets.length]
        for (let j = 0; j < 10; j++) {
          const tx = await token.connect(sender).transfer(receiver.address, ethers.parseEther("1"))
          const receipt = await tx.wait()
          totalGas += receipt.gasUsed
          count++
        }
      }
      console.log(`      ${count} token transfers, avg gas: ${totalGas / BigInt(count)}`)
    })

    it("emits Transfer events (eth_getLogs)", async function () {
      const filter = token.filters.Transfer()
      const logs = await token.queryFilter(filter)
      expect(logs.length).to.be.gt(0)
      console.log(`      ${logs.length} Transfer events found`)
    })

    it("mint and burn work", async function () {
      const supplyBefore = await token.totalSupply()
      await (await token.mint(wallets[0].address, ethers.parseEther("1000"))).wait()
      expect(await token.totalSupply()).to.equal(supplyBefore + ethers.parseEther("1000"))

      const tokenAsW0 = token.connect(wallets[0])
      await (await tokenAsW0.burn(ethers.parseEther("100"))).wait()
      expect(await token.totalSupply()).to.equal(supplyBefore + ethers.parseEther("900"))
    })
  })

  // ─── 3. ERC-721 NFT ───

  describe("3. ERC-721 NFT", function () {
    let nft

    before(async function () {
      const Factory = await ethers.getContractFactory("ERC721Mock", deployer)
      nft = await Factory.deploy()
      await nft.waitForDeployment()
      console.log(`      ERC721Mock deployed at ${await nft.getAddress()}`)
    })

    it("batch mint 100 NFTs", async function () {
      let totalGas = 0n
      for (let i = 1; i <= 100; i++) {
        const tx = await nft.mint(deployer.address, i)
        const receipt = await tx.wait()
        totalGas += receipt.gasUsed
      }
      expect(await nft.balanceOf(deployer.address)).to.equal(100n)
      console.log(`      100 mints, avg gas: ${totalGas / 100n}`)
    })

    it("transferFrom works", async function () {
      const tx = await nft.transferFrom(deployer.address, wallets[0].address, 1)
      const receipt = await tx.wait()
      expect(await nft.ownerOf(1)).to.equal(wallets[0].address)
      console.log(`      transferFrom gas: ${receipt.gasUsed}`)
    })

    it("approve + delegated transfer works", async function () {
      await (await nft.connect(wallets[0]).approve(wallets[1].address, 1)).wait()
      expect(await nft.getApproved(1)).to.equal(wallets[1].address)

      await (await nft.connect(wallets[1]).transferFrom(wallets[0].address, wallets[2].address, 1)).wait()
      expect(await nft.ownerOf(1)).to.equal(wallets[2].address)
    })

    it("setApprovalForAll works", async function () {
      await (await nft.setApprovalForAll(wallets[3].address, true)).wait()
      expect(await nft.isApprovedForAll(deployer.address, wallets[3].address)).to.equal(true)

      // Operator can transfer any of deployer's NFTs
      await (await nft.connect(wallets[3]).transferFrom(deployer.address, wallets[4].address, 50)).wait()
      expect(await nft.ownerOf(50)).to.equal(wallets[4].address)
    })

    it("supportsInterface (ERC-165)", async function () {
      expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true) // ERC-721
      expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true) // ERC-165
      expect(await nft.supportsInterface("0xffffffff")).to.equal(false) // invalid
    })

    it("burn works", async function () {
      const nftAsW2 = nft.connect(wallets[2])
      await (await nftAsW2.burn(1)).wait()
      expect(await nft.ownerOf(1)).to.equal(ethers.ZeroAddress)
    })
  })

  // ─── 4. Staking Contract ───

  describe("4. Staking Contract", function () {
    let staking

    before(async function () {
      const Factory = await ethers.getContractFactory("SimpleStaking", deployer)
      staking = await Factory.deploy()
      await staking.waitForDeployment()

      // Fund contract for rewards
      await (await deployer.sendTransaction({
        to: await staking.getAddress(),
        value: ethers.parseEther("100"),
      })).wait()

      console.log(`      SimpleStaking deployed at ${await staking.getAddress()}`)
    })

    it("stake from 3 accounts", async function () {
      const amounts = ["5", "3", "2"]
      for (let i = 0; i < 3; i++) {
        const tx = await staking.connect(wallets[i]).stake({ value: ethers.parseEther(amounts[i]) })
        const receipt = await tx.wait()
        console.log(`      wallet[${i}] staked ${amounts[i]} ETH, gas: ${receipt.gasUsed}`)
      }
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("10"))
    })

    it("getStakeInfo returns correct data", async function () {
      const info = await staking.getStakeInfo(wallets[0].address)
      expect(info.amount).to.equal(ethers.parseEther("5"))
      expect(info.stakedAt).to.be.gt(0n)
    })

    it("unstake returns funds", async function () {
      const balBefore = await ethers.provider.getBalance(wallets[0].address)
      const tx = await staking.connect(wallets[0]).unstake(ethers.parseEther("2"))
      const receipt = await tx.wait()
      const balAfter = await ethers.provider.getBalance(wallets[0].address)

      // Balance should increase by ~2 ETH (minus gas)
      const gasCost = receipt.gasUsed * receipt.gasPrice
      expect(balAfter + gasCost - balBefore).to.be.closeTo(ethers.parseEther("2"), ethers.parseEther("0.01"))

      const info = await staking.getStakeInfo(wallets[0].address)
      expect(info.amount).to.equal(ethers.parseEther("3"))
      console.log(`      unstake gas: ${receipt.gasUsed}`)
    })
  })

  // ─── 5. MultiSig Wallet ───

  describe("5. MultiSig Wallet", function () {
    let multisig
    let msigOwners

    before(async function () {
      msigOwners = wallets.slice(0, 5)
      const ownerAddrs = msigOwners.map((w) => w.address)

      const Factory = await ethers.getContractFactory("MultiSigWallet", deployer)
      multisig = await Factory.deploy(ownerAddrs, 3) // 3-of-5
      await multisig.waitForDeployment()

      // Fund the multisig
      await (await deployer.sendTransaction({
        to: await multisig.getAddress(),
        value: ethers.parseEther("10"),
      })).wait()

      console.log(`      MultiSigWallet (3/5) deployed at ${await multisig.getAddress()}`)
    })

    it("submit + 3 confirms + execute succeeds", async function () {
      const recipient = wallets[9].address
      const balBefore = await ethers.provider.getBalance(recipient)

      // Submit
      const submitTx = await multisig.connect(msigOwners[0]).submitTransaction(
        recipient, ethers.parseEther("1"), "0x",
      )
      const submitReceipt = await submitTx.wait()
      const txId = 0

      // Confirm by 3 owners
      for (let i = 0; i < 3; i++) {
        await (await multisig.connect(msigOwners[i]).confirmTransaction(txId)).wait()
      }

      // Execute
      const execTx = await multisig.connect(msigOwners[0]).executeTransaction(txId)
      const execReceipt = await execTx.wait()

      const balAfter = await ethers.provider.getBalance(recipient)
      expect(balAfter - balBefore).to.equal(ethers.parseEther("1"))

      console.log(`      submit gas: ${submitReceipt.gasUsed}, execute gas: ${execReceipt.gasUsed}`)
    })

    it("2 confirms is not enough to execute", async function () {
      await (await multisig.connect(msigOwners[0]).submitTransaction(
        wallets[9].address, ethers.parseEther("1"), "0x",
      )).wait()
      const txId = 1

      await (await multisig.connect(msigOwners[0]).confirmTransaction(txId)).wait()
      await (await multisig.connect(msigOwners[1]).confirmTransaction(txId)).wait()

      await expect(
        multisig.connect(msigOwners[0]).executeTransaction(txId),
      ).to.be.revertedWith("Not enough confirmations")
    })

    it("revoke + re-confirm flow works", async function () {
      const txId = 1

      // Revoke one confirmation
      await (await multisig.connect(msigOwners[1]).revokeConfirmation(txId)).wait()
      const tx = await multisig.transactions(txId)
      expect(tx.confirmCount).to.equal(1n)

      // Re-confirm by different owners to reach threshold
      await (await multisig.connect(msigOwners[2]).confirmTransaction(txId)).wait()
      await (await multisig.connect(msigOwners[3]).confirmTransaction(txId)).wait()

      // Now should execute
      await (await multisig.connect(msigOwners[0]).executeTransaction(txId)).wait()
      const txAfter = await multisig.transactions(txId)
      expect(txAfter.executed).to.equal(true)
    })
  })
})
