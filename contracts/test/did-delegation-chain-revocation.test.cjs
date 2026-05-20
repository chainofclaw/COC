/**
 * Security regression: DIDRegistry delegation revocation must be transitive.
 *
 * Bug: `isDelegationValid()` inspected only the single delegation record —
 * never its ancestors. And `grantDelegation()` accepted a parent that had been
 * emergency-revoked via `revokeAllDelegations()` (it checked only the per-record
 * `revoked` bool, not `globalRevocationEpoch`). Consequences:
 *   - revoking a parent left every descendant reporting `isDelegationValid` true;
 *   - a delegatee could keep extending the chain off an emergency-revoked link.
 *
 * Fix: `isDelegationValid()` walks the parent chain (bounded by
 * MAX_DELEGATION_DEPTH); `grantDelegation()` rejects a globally-revoked parent.
 */
const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const SOUL_DOMAIN = { name: "COCSoulRegistry", version: "1" }
const DID_DOMAIN = { name: "COCDIDRegistry", version: "1" }

const REGISTER_SOUL_TYPES = {
  RegisterSoul: [
    { name: "agentId", type: "bytes32" },
    { name: "identityCid", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
}
const GRANT_DELEGATION_TYPES = {
  GrantDelegation: [
    { name: "delegator", type: "bytes32" },
    { name: "delegatee", type: "bytes32" },
    { name: "parentDelegation", type: "bytes32" },
    { name: "scopeHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "depth", type: "uint8" },
    { name: "nonce", type: "uint64" },
  ],
}
const REVOKE_DELEGATION_TYPES = {
  RevokeDelegation: [
    { name: "delegationId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
}

const rnd = () => ethers.hexlify(ethers.randomBytes(32))
const mine = (s) => ethers.provider.send("evm_increaseTime", [s]).then(() => ethers.provider.send("evm_mine"))

describe("Security: DIDRegistry delegation chain revocation", function () {
  let soul, did, soulDomain, didDomain
  let ownerA, ownerB
  let aId, bId

  async function registerSoul(signer, agentId) {
    const nonce = await soul.nonces(agentId)
    const identityCid = rnd()
    const sig = await signer.signTypedData(soulDomain, REGISTER_SOUL_TYPES, {
      agentId, identityCid, owner: signer.address, nonce,
    })
    await soul.connect(signer).registerSoul(agentId, identityCid, sig)
  }

  async function grant(signer, delegator, delegatee, parent, expiresAt, depth) {
    const nonce = await did.nonces(delegator)
    const scopeHash = rnd()
    const sig = await signer.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
      delegator, delegatee, parentDelegation: parent, scopeHash, expiresAt, depth, nonce,
    })
    return did.connect(signer).grantDelegation(delegator, delegatee, parent, scopeHash, expiresAt, depth, sig)
  }

  async function grantId(signer, delegator, delegatee, parent, expiresAt, depth) {
    const tx = await grant(signer, delegator, delegatee, parent, expiresAt, depth)
    const rc = await tx.wait()
    const ev = rc.logs.find((l) => l.fragment && l.fragment.name === "DelegationGranted")
    return ev.args[0]
  }

  async function revoke(signer, delegator, delegationId) {
    const nonce = await did.nonces(delegator)
    const sig = await signer.signTypedData(didDomain, REVOKE_DELEGATION_TYPES, { delegationId, nonce })
    await did.connect(signer).revokeDelegation(delegationId, sig)
  }

  beforeEach(async function () {
    ;[ownerA, ownerB] = await ethers.getSigners()
    const Soul = await ethers.getContractFactory("SoulRegistry")
    soul = await upgrades.deployProxy(
      Soul,
      [ownerA.address],
      { initializer: "initialize", kind: "uups" },
    )
    await soul.waitForDeployment()
    const Did = await ethers.getContractFactory("DIDRegistry")
    did = await upgrades.deployProxy(
      Did,
      [await soul.getAddress(), ownerA.address],
      { initializer: "initialize", kind: "uups" },
    )
    await did.waitForDeployment()
    const net = await ethers.provider.getNetwork()
    soulDomain = { ...SOUL_DOMAIN, chainId: net.chainId, verifyingContract: await soul.getAddress() }
    didDomain = { ...DID_DOMAIN, chainId: net.chainId, verifyingContract: await did.getAddress() }

    aId = rnd()
    bId = rnd()
    await registerSoul(ownerA, aId)
    await registerSoul(ownerB, bId)
  })

  it("revoking a parent delegation invalidates its child", async function () {
    const exp = (await ethers.provider.getBlock("latest")).timestamp + 100_000
    const cId = rnd()
    const ab = await grantId(ownerA, aId, bId, ethers.ZeroHash, exp, 0)
    const bc = await grantId(ownerB, bId, cId, ab, exp, 1)
    expect(await did.isDelegationValid(bc)).to.equal(true)

    await revoke(ownerA, aId, ab)

    expect(await did.isDelegationValid(ab)).to.equal(false)
    // The child's authority derives from a now-revoked parent — it must fall too.
    expect(await did.isDelegationValid(bc)).to.equal(false)
  })

  it("emergency revokeAllDelegations invalidates descendant delegations", async function () {
    const exp = (await ethers.provider.getBlock("latest")).timestamp + 100_000
    const cId = rnd()
    const ab = await grantId(ownerA, aId, bId, ethers.ZeroHash, exp, 0)
    const bc = await grantId(ownerB, bId, cId, ab, exp, 1)

    await did.connect(ownerA).revokeAllDelegations(aId)

    expect(await did.isDelegationValid(ab)).to.equal(false)
    expect(await did.isDelegationValid(bc)).to.equal(false)
  })

  it("emergency revokeAllDelegations invalidates a delegation granted in the same block", async function () {
    const exp = (await ethers.provider.getBlock("latest")).timestamp + 100_000
    const nonce = await did.nonces(aId)
    const scopeHash = rnd()
    const sig = await ownerA.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
      delegator: aId,
      delegatee: bId,
      parentDelegation: ethers.ZeroHash,
      scopeHash,
      expiresAt: exp,
      depth: 0,
      nonce,
    })
    const txNonce = await ethers.provider.getTransactionCount(ownerA.address)

    await ethers.provider.send("evm_setAutomine", [false])
    try {
      const grantTx = await did.connect(ownerA).grantDelegation(
        aId,
        bId,
        ethers.ZeroHash,
        scopeHash,
        exp,
        0,
        sig,
        { nonce: txNonce },
      )
      const revokeTx = await did.connect(ownerA).revokeAllDelegations(aId, { nonce: txNonce + 1 })
      await ethers.provider.send("evm_mine")

      const grantRc = await grantTx.wait()
      await revokeTx.wait()
      const ev = grantRc.logs.find((l) => l.fragment && l.fragment.name === "DelegationGranted")
      const delegationId = ev.args[0]

      expect(await did.isDelegationValid(delegationId)).to.equal(false)
    } finally {
      await ethers.provider.send("evm_setAutomine", [true])
      await ethers.provider.send("evm_mine")
    }
  })

  it("a chain cannot be extended off an emergency-revoked parent", async function () {
    const exp = (await ethers.provider.getBlock("latest")).timestamp + 100_000
    const ab = await grantId(ownerA, aId, bId, ethers.ZeroHash, exp, 0)
    await did.connect(ownerA).revokeAllDelegations(aId)
    await mine(61) // clear B's per-delegator rate limit window

    const dId = rnd()
    await expect(
      grant(ownerB, bId, dId, ab, exp, 1),
    ).to.be.revertedWithCustomError(did, "DelegationAlreadyRevoked")
  })

  it("a fully valid chain still reports every link valid", async function () {
    const exp = (await ethers.provider.getBlock("latest")).timestamp + 100_000
    const cId = rnd()
    const ab = await grantId(ownerA, aId, bId, ethers.ZeroHash, exp, 0)
    const bc = await grantId(ownerB, bId, cId, ab, exp, 1)
    expect(await did.isDelegationValid(ab)).to.equal(true)
    expect(await did.isDelegationValid(bc)).to.equal(true)
  })
})
