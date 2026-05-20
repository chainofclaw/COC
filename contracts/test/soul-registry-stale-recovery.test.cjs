/**
 * Security regression: a soul re-registered on a recycled agentId must NOT
 * inherit recovery-critical state from the previous incarnation.
 *
 * Bug: `deactivateSoul` only flips `active` and drops the owner binding;
 * `registerSoul` permits re-registering an inactive agentId. But `_guardians`
 * and `resurrectionConfigs` are keyed by agentId and were never cleared, so a
 * freshly registered soul silently inherited the old owner's guardians and
 * resurrection key. Those stale guardians could `initiateRecovery` and seize
 * the new soul.
 *
 * Fix: `registerSoul` clears `_guardians` + `resurrectionConfigs` for the
 * agentId; `completeRecovery` rejects requests predating the current
 * registration and refuses inactive souls.
 */
const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const DOMAIN_NAME = "COCSoulRegistry"
const DOMAIN_VERSION = "1"

const REGISTER_SOUL_TYPES = {
  RegisterSoul: [
    { name: "agentId", type: "bytes32" },
    { name: "identityCid", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
}

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32))
}

describe("Security: SoulRegistry stale recovery state", function () {
  let registry, domain
  let alice, bob, guardian, guardian2, attacker

  async function register(signer, agentId, identityCid, nonce) {
    const sig = await signer.signTypedData(domain, REGISTER_SOUL_TYPES, {
      agentId,
      identityCid,
      owner: signer.address,
      nonce,
    })
    return registry.connect(signer).registerSoul(agentId, identityCid, sig)
  }

  beforeEach(async function () {
    ;[alice, bob, guardian, guardian2, attacker] = await ethers.getSigners()
    const Factory = await ethers.getContractFactory("SoulRegistry")
    registry = await upgrades.deployProxy(
      Factory,
      [alice.address],
      { initializer: "initialize", kind: "uups" },
    )
    await registry.waitForDeployment()
    const net = await ethers.provider.getNetwork()
    domain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: net.chainId, verifyingContract: await registry.getAddress() }
  })

  it("a re-registered soul starts with zero guardians", async function () {
    const agentId = randomBytes32()
    await register(alice, agentId, randomBytes32(), 0)
    await registry.connect(alice).addGuardian(agentId, guardian.address)
    expect(await registry.getActiveGuardianCount(agentId)).to.equal(1n)

    await registry.connect(alice).deactivateSoul(agentId)
    // Bob recycles the agentId (nonce advanced to 1 by Alice's registration).
    await register(bob, agentId, randomBytes32(), 1)

    // A brand-new soul must NOT inherit the prior owner's guardian.
    expect(await registry.getActiveGuardianCount(agentId)).to.equal(0n)
  })

  it("a stale guardian cannot initiate recovery on a re-registered soul", async function () {
    const agentId = randomBytes32()
    await register(alice, agentId, randomBytes32(), 0)
    await registry.connect(alice).addGuardian(agentId, guardian.address)
    await registry.connect(alice).deactivateSoul(agentId)
    await register(bob, agentId, randomBytes32(), 1)

    // The old guardian must have no authority over Bob's fresh soul.
    await expect(
      registry.connect(guardian).initiateRecovery(agentId, attacker.address),
    ).to.be.revertedWithCustomError(registry, "NotGuardian")

    // And ownership is unchanged — Bob still owns it.
    expect((await registry.getSoul(agentId)).owner).to.equal(bob.address)
  })

  it("a re-registered soul carries no resurrection config", async function () {
    const agentId = randomBytes32()
    await register(alice, agentId, randomBytes32(), 0)
    await registry.connect(alice).configureResurrection(agentId, randomBytes32(), 3600)
    expect((await registry.getResurrectionConfig(agentId)).configured).to.equal(true)

    await registry.connect(alice).deactivateSoul(agentId)
    await register(bob, agentId, randomBytes32(), 1)

    // The prior owner's resurrection key must not survive into the new soul.
    expect((await registry.getResurrectionConfig(agentId)).configured).to.equal(false)
  })

  it("legitimate re-registration by the same owner still works", async function () {
    const agentId = randomBytes32()
    await register(alice, agentId, randomBytes32(), 0)
    await registry.connect(alice).deactivateSoul(agentId)
    await register(alice, agentId, randomBytes32(), 1)
    const soul = await registry.getSoul(agentId)
    expect(soul.owner).to.equal(alice.address)
    expect(soul.active).to.equal(true)
  })

  it("a pending recovery from a previous owner epoch cannot execute after ownership changes", async function () {
    const agentId = randomBytes32()
    await register(alice, agentId, randomBytes32(), 0)
    await registry.connect(alice).addGuardian(agentId, guardian.address)
    await registry.connect(alice).addGuardian(agentId, guardian2.address)

    const staleTx = await registry.connect(guardian).initiateRecovery(agentId, attacker.address)
    const staleReceipt = await staleTx.wait()
    const staleRequestId = staleReceipt.logs.find((log) => log.fragment?.name === "RecoveryInitiated").args[0]
    await registry.connect(guardian2).approveRecovery(staleRequestId)

    const validTx = await registry.connect(guardian).initiateRecovery(agentId, bob.address)
    const validReceipt = await validTx.wait()
    const validRequestId = validReceipt.logs.find((log) => log.fragment?.name === "RecoveryInitiated").args[0]
    await registry.connect(guardian2).approveRecovery(validRequestId)

    await ethers.provider.send("evm_increaseTime", [86401])
    await ethers.provider.send("evm_mine")

    await registry.completeRecovery(validRequestId)
    expect((await registry.getSoul(agentId)).owner).to.equal(bob.address)

    await expect(
      registry.completeRecovery(staleRequestId),
    ).to.be.revertedWithCustomError(registry, "RecoveryNotFound")
    expect((await registry.getSoul(agentId)).owner).to.equal(bob.address)
  })
})
