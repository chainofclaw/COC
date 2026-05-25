// DIDRegistry — #11 stale ephemeral identities + credentials across soul
// re-registration. Companion to #721 (delegations) and #722 (the PR that
// closed it). Same re-anchoring discipline applied to two other authority
// surfaces hanging off the same SoulRegistry parent:
//
//   - ephemeralIdentities[id]:  sub-identities the parent agent issued
//                               (created_at scoped); previously trusted
//                               by downstream verifiers that read the
//                               mapping directly. New view
//                               `isEphemeralValid(id)` rejects when
//                               `createdAt < soul.registeredAt`.
//   - credentials[id]:           verifiable-credential anchors issued by
//                               an issuer agent. Old issuer-owner's
//                               credentials previously stayed live after
//                               the issuer agent was recovered to a new
//                               owner. New view `isCredentialValid(id)`
//                               rejects when `issuedAt < soul.registeredAt`.

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

const CREATE_EPHEMERAL_TYPES = {
  CreateEphemeralIdentity: [
    { name: "parentAgentId", type: "bytes32" },
    { name: "ephemeralId", type: "bytes32" },
    { name: "ephemeralAddress", type: "address" },
    { name: "scopeHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
}

const ANCHOR_CREDENTIAL_TYPES = {
  AnchorCredential: [
    { name: "credentialHash", type: "bytes32" },
    { name: "issuerAgentId", type: "bytes32" },
    { name: "subjectAgentId", type: "bytes32" },
    { name: "credentialCid", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
}

function domain(name, chainId, addr) {
  return { name, version: DOMAIN_VERSION, chainId, verifyingContract: addr }
}

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32))
}

async function registerSoul(soul, soulDomain, signer, agentId, identityCid) {
  const nonce = await soul.nonces(agentId)
  const sig = await signer.signTypedData(soulDomain, REGISTER_SOUL_TYPES, {
    agentId, identityCid, owner: signer.address, nonce,
  })
  await soul.connect(signer).registerSoul(agentId, identityCid, sig)
}

async function createEphemeral(did, didDomain, signer, args) {
  const { parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt } = args
  const nonce = await did.nonces(parentAgentId)
  const sig = await signer.signTypedData(didDomain, CREATE_EPHEMERAL_TYPES, {
    parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, nonce,
  })
  await did.connect(signer).createEphemeralIdentity(
    parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, sig,
  )
}

async function anchorCredential(did, didDomain, signer, args) {
  const { credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt } = args
  const nonce = await did.nonces(issuerAgentId)
  const sig = await signer.signTypedData(didDomain, ANCHOR_CREDENTIAL_TYPES, {
    credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, nonce,
  })
  await did.connect(signer).anchorCredential(
    credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, sig,
  )
  // Contract derives credentialId = keccak256(credentialHash, issuerAgentId, nonce)
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint64"],
      [credentialHash, issuerAgentId, nonce],
    ),
  )
}

describe("DIDRegistry — #11 stale ephemerals & credentials across soul re-registration", function () {
  let soulRegistry, didRegistry, soulDomain, didDomain
  let deployer, alice, bob

  beforeEach(async function () {
    ;[deployer, alice, bob] = await ethers.getSigners()

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
    soulDomain = domain(SOUL_DOMAIN_NAME, chainId, await soulRegistry.getAddress())
    didDomain = domain(DID_DOMAIN_NAME, chainId, await didRegistry.getAddress())
  })

  describe("ephemeralIdentities", function () {
    it("isEphemeralValid is true while the parent soul is still in its original tenure", async function () {
      const parent = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, alice, parent, randomBytes32())
      const ephId = randomBytes32()
      const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 7 * 24 * 3600
      await createEphemeral(didRegistry, didDomain, alice, {
        parentAgentId: parent, ephemeralId: ephId,
        ephemeralAddress: alice.address, scopeHash: randomBytes32(), expiresAt,
      })
      expect(await didRegistry.isEphemeralValid(ephId)).to.equal(true)
    })

    it("invalidates an ephemeral once the parent soul is re-registered to a new owner", async function () {
      const parent = randomBytes32()
      // Alice's tenure.
      await registerSoul(soulRegistry, soulDomain, alice, parent, randomBytes32())
      const ephId = randomBytes32()
      const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 365 * 24 * 3600
      await createEphemeral(didRegistry, didDomain, alice, {
        parentAgentId: parent, ephemeralId: ephId,
        ephemeralAddress: alice.address, scopeHash: randomBytes32(), expiresAt,
      })
      expect(await didRegistry.isEphemeralValid(ephId)).to.equal(true)

      // Soul recovered: Alice deactivates, Bob re-registers same agentId.
      // Pre-fix the raw mapping read would still show `active=true` and the
      // expiresAt in the future, silently inheriting Alice's authority.
      await soulRegistry.connect(alice).deactivateSoul(parent)
      // Bump block time by 1s so Bob's registeredAt is strictly greater
      // than the ephemeral's createdAt (ensures the stale check trips
      // even if the same block).
      await ethers.provider.send("evm_increaseTime", [2])
      await ethers.provider.send("evm_mine", [])
      await registerSoul(soulRegistry, soulDomain, bob, parent, randomBytes32())

      expect(await didRegistry.isEphemeralValid(ephId)).to.equal(false,
        "ephemeral created before the most-recent parent registration must be rejected")
    })

    it("isEphemeralValid is false for an unknown ephemeralId", async function () {
      expect(await didRegistry.isEphemeralValid(randomBytes32())).to.equal(false)
    })
  })

  describe("credentials", function () {
    it("isCredentialValid is true while the issuer soul is still in its original tenure", async function () {
      const issuer = randomBytes32()
      const subject = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, alice, issuer, randomBytes32())
      const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 7 * 24 * 3600
      const credentialId = await anchorCredential(didRegistry, didDomain, alice, {
        credentialHash: randomBytes32(),
        issuerAgentId: issuer, subjectAgentId: subject,
        credentialCid: randomBytes32(), expiresAt,
      })
      expect(await didRegistry.isCredentialValid(credentialId)).to.equal(true)
    })

    it("invalidates a credential once the issuer soul is re-registered to a new owner", async function () {
      const issuer = randomBytes32()
      const subject = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, alice, issuer, randomBytes32())
      const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 365 * 24 * 3600
      const credentialId = await anchorCredential(didRegistry, didDomain, alice, {
        credentialHash: randomBytes32(),
        issuerAgentId: issuer, subjectAgentId: subject,
        credentialCid: randomBytes32(), expiresAt,
      })
      expect(await didRegistry.isCredentialValid(credentialId)).to.equal(true)

      // Recover the issuer agent to Bob.
      await soulRegistry.connect(alice).deactivateSoul(issuer)
      await ethers.provider.send("evm_increaseTime", [2])
      await ethers.provider.send("evm_mine", [])
      await registerSoul(soulRegistry, soulDomain, bob, issuer, randomBytes32())

      expect(await didRegistry.isCredentialValid(credentialId)).to.equal(false,
        "credential issued before the most-recent issuer registration must be rejected")
    })

    it("isCredentialValid still rejects an explicitly-revoked credential", async function () {
      const issuer = randomBytes32()
      const subject = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, alice, issuer, randomBytes32())
      const expiresAt = (await ethers.provider.getBlock("latest")).timestamp + 365 * 24 * 3600
      const credentialId = await anchorCredential(didRegistry, didDomain, alice, {
        credentialHash: randomBytes32(),
        issuerAgentId: issuer, subjectAgentId: subject,
        credentialCid: randomBytes32(), expiresAt,
      })
      await didRegistry.connect(alice).revokeCredential(credentialId)
      expect(await didRegistry.isCredentialValid(credentialId)).to.equal(false)
    })

    it("isCredentialValid is false for an unknown credentialId", async function () {
      expect(await didRegistry.isCredentialValid(randomBytes32())).to.equal(false)
    })
  })
})
