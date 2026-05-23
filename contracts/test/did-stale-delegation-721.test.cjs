// DIDRegistry — #721 stale delegations across soul re-registration.
//
// SoulRegistry has no callback into DIDRegistry, and DIDRegistry's
// `isDelegationValid` historically trusted the per-record state captured
// at grant time. Combined, that left every delegation issued by the
// previous owner of an agentId valid after the soul was deactivated and
// re-registered to a new owner. The fix re-anchors each hop in
// `isDelegationValid` to `SoulRegistry.getSoul(d.delegator).registeredAt`
// so the new owner does not inherit stale capabilities.

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const SOUL_DOMAIN_NAME = "COCSoulRegistry"
const DID_DOMAIN_NAME = "COCDIDRegistry"
const DOMAIN_VERSION = "1"

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

function buildDomain(name, chainId, addr) {
  return { name, version: DOMAIN_VERSION, chainId, verifyingContract: addr }
}

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32))
}

function computeDelegationId(delegator, delegatee, nonce, chainId) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint64", "uint256"],
      [delegator, delegatee, nonce, chainId],
    ),
  )
}

async function registerSoul(soul, soulDomain, signer, agentId, identityCid) {
  const nonce = await soul.nonces(agentId)
  const sig = await signer.signTypedData(soulDomain, REGISTER_SOUL_TYPES, {
    agentId, identityCid, owner: signer.address, nonce,
  })
  await soul.connect(signer).registerSoul(agentId, identityCid, sig)
}

async function grantDelegation(did, didDomain, signer, args) {
  const { delegator, delegatee, scopeHash, expiresAt } = args
  const nonce = await did.nonces(delegator)
  const sig = await signer.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
    delegator,
    delegatee,
    parentDelegation: ethers.ZeroHash,
    scopeHash,
    expiresAt,
    depth: 0,
    nonce,
  })
  await did.connect(signer).grantDelegation(
    delegator, delegatee, ethers.ZeroHash, scopeHash, expiresAt, 0, sig,
  )
  const { chainId } = await ethers.provider.getNetwork()
  return computeDelegationId(delegator, delegatee, nonce, chainId)
}

describe("DIDRegistry — #721 stale delegations across soul re-registration", function () {
  let soulRegistry, didRegistry, soulDomain, didDomain
  let deployer, alice, bob, mallory

  beforeEach(async function () {
    ;[deployer, alice, bob, mallory] = await ethers.getSigners()

    const SoulFactory = await ethers.getContractFactory("SoulRegistry")
    soulRegistry = await upgrades.deployProxy(
      SoulFactory, [deployer.address],
      { initializer: "initialize", kind: "uups" },
    )
    await soulRegistry.waitForDeployment()

    const DIDFactory = await ethers.getContractFactory("DIDRegistry")
    didRegistry = await upgrades.deployProxy(
      DIDFactory, [await soulRegistry.getAddress(), deployer.address],
      { initializer: "initialize", kind: "uups" },
    )
    await didRegistry.waitForDeployment()

    const { chainId } = await ethers.provider.getNetwork()
    soulDomain = buildDomain(SOUL_DOMAIN_NAME, chainId, await soulRegistry.getAddress())
    didDomain = buildDomain(DID_DOMAIN_NAME, chainId, await didRegistry.getAddress())
  })

  it("invalidates a delegation issued by the previous owner once the soul is re-registered", async function () {
    const agentId = randomBytes32()
    const delegatee = randomBytes32()
    const scopeHash = randomBytes32()

    // Alice registers and issues D1 from X to Mallory's agentId.
    await registerSoul(soulRegistry, soulDomain, alice, agentId, randomBytes32())
    const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 365 * 24 * 3600
    const d1 = await grantDelegation(didRegistry, didDomain, alice, {
      delegator: agentId, delegatee, scopeHash, expiresAt,
    })
    expect(await didRegistry.isDelegationValid(d1)).to.equal(true)

    // Alice deactivates the soul; the delegation record is left in
    // DIDRegistry storage (no callback).
    await soulRegistry.connect(alice).deactivateSoul(agentId)
    // Soul is now inactive — the delegator's soul guard should already
    // reject; double-checking once after the deactivation step before the
    // re-registration to make the staleness sequence explicit.
    expect(await didRegistry.isDelegationValid(d1)).to.equal(false)

    // Bob re-registers the same agentId — without the fix, D1 would
    // become valid again because none of its per-record fields changed
    // and `globalRevocationEpoch[agentId]` is DIDRegistry-local.
    await registerSoul(soulRegistry, soulDomain, bob, agentId, randomBytes32())
    expect(await didRegistry.isDelegationValid(d1)).to.equal(false)
  })

  it("accepts a delegation that the new owner grants after re-registration", async function () {
    const agentId = randomBytes32()
    const delegatee = randomBytes32()
    const scopeHash = randomBytes32()

    // Old incarnation comes and goes.
    await registerSoul(soulRegistry, soulDomain, alice, agentId, randomBytes32())
    await soulRegistry.connect(alice).deactivateSoul(agentId)

    // New owner registers the same agentId and issues a fresh delegation.
    await registerSoul(soulRegistry, soulDomain, bob, agentId, randomBytes32())
    const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 365 * 24 * 3600
    const d2 = await grantDelegation(didRegistry, didDomain, bob, {
      delegator: agentId, delegatee, scopeHash, expiresAt,
    })
    expect(await didRegistry.isDelegationValid(d2)).to.equal(true)
  })
})
