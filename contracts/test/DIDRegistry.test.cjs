/**
 * DIDRegistry Test Suite
 *
 * Covers: DID document management, verification method rotation,
 * delegation lifecycle, ephemeral identities, lineage, credentials.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// ---------------------------------------------------------------------------
//  EIP-712 Helpers
// ---------------------------------------------------------------------------

const SOUL_DOMAIN_NAME = "COCSoulRegistry"
const SOUL_DOMAIN_VERSION = "1"

const DID_DOMAIN_NAME = "COCDIDRegistry"
const DID_DOMAIN_VERSION = "1"

function buildSoulDomain(chainId, contractAddress) {
  return { name: SOUL_DOMAIN_NAME, version: SOUL_DOMAIN_VERSION, chainId, verifyingContract: contractAddress }
}

function buildDIDDomain(chainId, contractAddress) {
  return { name: DID_DOMAIN_NAME, version: DID_DOMAIN_VERSION, chainId, verifyingContract: contractAddress }
}

const REGISTER_SOUL_TYPES = {
  RegisterSoul: [
    { name: "agentId", type: "bytes32" },
    { name: "identityCid", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
}

const UPDATE_DID_DOCUMENT_TYPES = {
  UpdateDIDDocument: [
    { name: "agentId", type: "bytes32" },
    { name: "newDocumentCid", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
}

const ADD_VERIFICATION_METHOD_TYPES = {
  AddVerificationMethod: [
    { name: "agentId", type: "bytes32" },
    { name: "keyId", type: "bytes32" },
    { name: "keyAddress", type: "address" },
    { name: "keyPurpose", type: "uint8" },
    { name: "nonce", type: "uint64" },
  ],
}

const REVOKE_VERIFICATION_METHOD_TYPES = {
  RevokeVerificationMethod: [
    { name: "agentId", type: "bytes32" },
    { name: "keyId", type: "bytes32" },
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

const CREATE_EPHEMERAL_IDENTITY_TYPES = {
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

// ---------------------------------------------------------------------------
//  Utilities
// ---------------------------------------------------------------------------

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32))
}

async function futureTimestamp(seconds = 3600) {
  const block = await ethers.provider.getBlock("latest")
  return block.timestamp + seconds
}

async function mineSeconds(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds])
  await ethers.provider.send("evm_mine")
}

// ---------------------------------------------------------------------------
//  Deployment
// ---------------------------------------------------------------------------

async function deployContracts() {
  const SoulFactory = await ethers.getContractFactory("SoulRegistry")
  const soulRegistry = await SoulFactory.deploy()
  await soulRegistry.waitForDeployment()
  const soulAddress = await soulRegistry.getAddress()

  const DIDFactory = await ethers.getContractFactory("DIDRegistry")
  const didRegistry = await DIDFactory.deploy(soulAddress)
  await didRegistry.waitForDeployment()
  const didAddress = await didRegistry.getAddress()

  const network = await ethers.provider.getNetwork()
  const soulDomain = buildSoulDomain(network.chainId, soulAddress)
  const didDomain = buildDIDDomain(network.chainId, didAddress)

  return { soulRegistry, didRegistry, soulDomain, didDomain, soulAddress, didAddress }
}

async function registerSoul(soulRegistry, soulDomain, signer, agentId, identityCid) {
  const nonce = await soulRegistry.nonces(agentId)
  const sig = await signer.signTypedData(soulDomain, REGISTER_SOUL_TYPES, {
    agentId,
    identityCid,
    owner: signer.address,
    nonce,
  })
  await soulRegistry.connect(signer).registerSoul(agentId, identityCid, sig)
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("DIDRegistry", function () {
  let soulRegistry, didRegistry, soulDomain, didDomain
  let owner, other, stranger
  let agentId, identityCid

  beforeEach(async function () {
    ;[owner, other, stranger] = await ethers.getSigners()
    const deployed = await deployContracts()
    soulRegistry = deployed.soulRegistry
    didRegistry = deployed.didRegistry
    soulDomain = deployed.soulDomain
    didDomain = deployed.didDomain

    agentId = randomBytes32()
    identityCid = randomBytes32()
    await registerSoul(soulRegistry, soulDomain, owner, agentId, identityCid)
  })

  // -----------------------------------------------------------------------
  //  DID Document
  // -----------------------------------------------------------------------

  describe("updateDIDDocument", function () {
    it("should update DID document CID with valid signature", async function () {
      const newCid = randomBytes32()
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, UPDATE_DID_DOCUMENT_TYPES, {
        agentId,
        newDocumentCid: newCid,
        nonce,
      })

      await expect(didRegistry.connect(owner).updateDIDDocument(agentId, newCid, sig))
        .to.emit(didRegistry, "DIDDocumentUpdated")
        .withArgs(agentId, newCid)

      expect(await didRegistry.didDocumentCid(agentId)).to.equal(newCid)
    })

    it("should reject non-owner", async function () {
      const newCid = randomBytes32()
      const sig = await stranger.signTypedData(didDomain, UPDATE_DID_DOCUMENT_TYPES, {
        agentId,
        newDocumentCid: newCid,
        nonce: 0,
      })
      await expect(didRegistry.connect(stranger).updateDIDDocument(agentId, newCid, sig))
        .to.be.revertedWithCustomError(didRegistry, "NotOwner")
    })

    it("should reject invalid signature", async function () {
      const newCid = randomBytes32()
      // Sign with wrong data
      const sig = await owner.signTypedData(didDomain, UPDATE_DID_DOCUMENT_TYPES, {
        agentId,
        newDocumentCid: randomBytes32(), // different CID
        nonce: 0,
      })
      await expect(didRegistry.connect(owner).updateDIDDocument(agentId, newCid, sig))
        .to.be.revertedWithCustomError(didRegistry, "InvalidSignature")
    })
  })

  // -----------------------------------------------------------------------
  //  Verification Methods
  // -----------------------------------------------------------------------

  describe("addVerificationMethod", function () {
    it("should add a new key with valid signature", async function () {
      const keyId = ethers.keccak256(ethers.toUtf8Bytes("operational"))
      const keyAddress = other.address
      const keyPurpose = 0x03 // auth + assertion
      const nonce = await didRegistry.nonces(agentId)

      const sig = await owner.signTypedData(didDomain, ADD_VERIFICATION_METHOD_TYPES, {
        agentId,
        keyId,
        keyAddress,
        keyPurpose,
        nonce,
      })

      await expect(didRegistry.connect(owner).addVerificationMethod(agentId, keyId, keyAddress, keyPurpose, sig))
        .to.emit(didRegistry, "VerificationMethodAdded")
        .withArgs(agentId, keyId, keyAddress, keyPurpose)

      const methods = await didRegistry.getVerificationMethods(agentId)
      expect(methods.length).to.equal(1)
      expect(methods[0].keyId).to.equal(keyId)
      expect(methods[0].keyAddress).to.equal(keyAddress)
      expect(methods[0].keyPurpose).to.equal(keyPurpose)
      expect(methods[0].active).to.equal(true)
    })

    it("should reject duplicate active keyId", async function () {
      const keyId = ethers.keccak256(ethers.toUtf8Bytes("operational"))
      const keyPurpose = 0x01

      // Add first key
      let nonce = await didRegistry.nonces(agentId)
      let sig = await owner.signTypedData(didDomain, ADD_VERIFICATION_METHOD_TYPES, {
        agentId, keyId, keyAddress: other.address, keyPurpose, nonce,
      })
      await didRegistry.connect(owner).addVerificationMethod(agentId, keyId, other.address, keyPurpose, sig)

      // Try adding same keyId again
      nonce = await didRegistry.nonces(agentId)
      sig = await owner.signTypedData(didDomain, ADD_VERIFICATION_METHOD_TYPES, {
        agentId, keyId, keyAddress: stranger.address, keyPurpose, nonce,
      })
      await expect(didRegistry.connect(owner).addVerificationMethod(agentId, keyId, stranger.address, keyPurpose, sig))
        .to.be.revertedWithCustomError(didRegistry, "KeyAlreadyExists")
    })

    it("should reject zero keyId", async function () {
      const sig = await owner.signTypedData(didDomain, ADD_VERIFICATION_METHOD_TYPES, {
        agentId, keyId: ethers.ZeroHash, keyAddress: other.address, keyPurpose: 0x01, nonce: 0,
      })
      await expect(didRegistry.connect(owner).addVerificationMethod(agentId, ethers.ZeroHash, other.address, 0x01, sig))
        .to.be.revertedWithCustomError(didRegistry, "InvalidKeyId")
    })
  })

  describe("revokeVerificationMethod", function () {
    it("should revoke an active key", async function () {
      const keyId = ethers.keccak256(ethers.toUtf8Bytes("toRevoke"))

      // Add key
      let nonce = await didRegistry.nonces(agentId)
      let sig = await owner.signTypedData(didDomain, ADD_VERIFICATION_METHOD_TYPES, {
        agentId, keyId, keyAddress: other.address, keyPurpose: 0x01, nonce,
      })
      await didRegistry.connect(owner).addVerificationMethod(agentId, keyId, other.address, 0x01, sig)

      // Revoke key
      nonce = await didRegistry.nonces(agentId)
      sig = await owner.signTypedData(didDomain, REVOKE_VERIFICATION_METHOD_TYPES, {
        agentId, keyId, nonce,
      })

      await expect(didRegistry.connect(owner).revokeVerificationMethod(agentId, keyId, sig))
        .to.emit(didRegistry, "VerificationMethodRevoked")
        .withArgs(agentId, keyId)

      const active = await didRegistry.getActiveVerificationMethods(agentId)
      expect(active.length).to.equal(0)
    })

    it("should reject revoking non-existent key", async function () {
      const keyId = randomBytes32()
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, REVOKE_VERIFICATION_METHOD_TYPES, {
        agentId, keyId, nonce,
      })
      await expect(didRegistry.connect(owner).revokeVerificationMethod(agentId, keyId, sig))
        .to.be.revertedWithCustomError(didRegistry, "KeyNotFound")
    })
  })

  // -----------------------------------------------------------------------
  //  Delegations
  // -----------------------------------------------------------------------

  describe("grantDelegation", function () {
    let delegateeId

    beforeEach(async function () {
      delegateeId = randomBytes32()
      // Register delegatee soul
      await registerSoul(soulRegistry, soulDomain, other, delegateeId, randomBytes32())
    })

    it("should grant a root delegation with valid signature", async function () {
      const scopeHash = randomBytes32()
      const expiresAt = await futureTimestamp(7200)
      const nonce = await didRegistry.nonces(agentId)

      const sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId,
        delegatee: delegateeId,
        parentDelegation: ethers.ZeroHash,
        scopeHash,
        expiresAt,
        depth: 0,
        nonce,
      })

      await expect(
        didRegistry.connect(owner).grantDelegation(agentId, delegateeId, ethers.ZeroHash, scopeHash, expiresAt, 0, sig)
      ).to.emit(didRegistry, "DelegationGranted")

      const delegationIds = await didRegistry.getAgentDelegations(agentId)
      expect(delegationIds.length).to.equal(1)

      const d = await didRegistry.delegations(delegationIds[0])
      expect(d.delegator).to.equal(agentId)
      expect(d.delegatee).to.equal(delegateeId)
      expect(d.depth).to.equal(0)
      expect(d.revoked).to.equal(false)
    })

    it("should reject delegation with past expiry", async function () {
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId,
        delegatee: delegateeId,
        parentDelegation: ethers.ZeroHash,
        scopeHash: randomBytes32(),
        expiresAt: 1, // past timestamp
        depth: 0,
        nonce,
      })
      await expect(
        didRegistry.connect(owner).grantDelegation(agentId, delegateeId, ethers.ZeroHash, randomBytes32(), 1, 0, sig)
      ).to.be.revertedWithCustomError(didRegistry, "InvalidExpiry")
    })

    it("should reject delegation exceeding max depth", async function () {
      const expiresAt = await futureTimestamp(7200)
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId,
        delegatee: delegateeId,
        parentDelegation: ethers.ZeroHash,
        scopeHash: randomBytes32(),
        expiresAt,
        depth: 4, // exceeds MAX_DELEGATION_DEPTH=3
        nonce,
      })
      await expect(
        didRegistry.connect(owner).grantDelegation(agentId, delegateeId, ethers.ZeroHash, randomBytes32(), expiresAt, 4, sig)
      ).to.be.revertedWithCustomError(didRegistry, "DelegationTooDeep")
    })

    it("should enforce rate limiting", async function () {
      const expiresAt = await futureTimestamp(7200)

      // First delegation
      const scopeHash1 = randomBytes32()
      let nonce = await didRegistry.nonces(agentId)
      let sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId, delegatee: delegateeId, parentDelegation: ethers.ZeroHash,
        scopeHash: scopeHash1, expiresAt, depth: 0, nonce,
      })
      await didRegistry.connect(owner).grantDelegation(agentId, delegateeId, ethers.ZeroHash, scopeHash1, expiresAt, 0, sig)

      // Second delegation immediately (should be rate limited)
      const delegateeId2 = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, stranger, delegateeId2, randomBytes32())
      const scopeHash2 = randomBytes32()
      nonce = await didRegistry.nonces(agentId)
      sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId, delegatee: delegateeId2, parentDelegation: ethers.ZeroHash,
        scopeHash: scopeHash2, expiresAt, depth: 0, nonce,
      })
      await expect(
        didRegistry.connect(owner).grantDelegation(agentId, delegateeId2, ethers.ZeroHash, scopeHash2, expiresAt, 0, sig)
      ).to.be.revertedWithCustomError(didRegistry, "DelegationRateLimited")
    })
  })

  describe("revokeDelegation", function () {
    it("should revoke an active delegation", async function () {
      const delegateeId = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, other, delegateeId, randomBytes32())

      const scopeHash = randomBytes32()
      const expiresAt = await futureTimestamp(7200)
      let nonce = await didRegistry.nonces(agentId)
      let sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId, delegatee: delegateeId, parentDelegation: ethers.ZeroHash,
        scopeHash, expiresAt, depth: 0, nonce,
      })
      await didRegistry.connect(owner).grantDelegation(agentId, delegateeId, ethers.ZeroHash, scopeHash, expiresAt, 0, sig)

      const delegationIds = await didRegistry.getAgentDelegations(agentId)
      const delegationId = delegationIds[0]

      nonce = await didRegistry.nonces(agentId)
      sig = await owner.signTypedData(didDomain, REVOKE_DELEGATION_TYPES, {
        delegationId, nonce,
      })

      await expect(didRegistry.connect(owner).revokeDelegation(delegationId, sig))
        .to.emit(didRegistry, "DelegationRevoked")
        .withArgs(delegationId)

      expect(await didRegistry.isDelegationValid(delegationId)).to.equal(false)
    })
  })

  describe("revokeAllDelegations", function () {
    it("should invalidate all delegations via global epoch", async function () {
      const delegateeId = randomBytes32()
      await registerSoul(soulRegistry, soulDomain, other, delegateeId, randomBytes32())

      const scopeHash = randomBytes32()
      const expiresAt = await futureTimestamp(7200)
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, GRANT_DELEGATION_TYPES, {
        delegator: agentId, delegatee: delegateeId, parentDelegation: ethers.ZeroHash,
        scopeHash, expiresAt, depth: 0, nonce,
      })
      await didRegistry.connect(owner).grantDelegation(agentId, delegateeId, ethers.ZeroHash, scopeHash, expiresAt, 0, sig)

      const delegationIds = await didRegistry.getAgentDelegations(agentId)

      await expect(didRegistry.connect(owner).revokeAllDelegations(agentId))
        .to.emit(didRegistry, "GlobalRevocationSet")

      // Delegation issued before global epoch should be invalid
      expect(await didRegistry.isDelegationValid(delegationIds[0])).to.equal(false)
    })
  })

  // -----------------------------------------------------------------------
  //  Capabilities
  // -----------------------------------------------------------------------

  describe("updateCapabilities", function () {
    it("should update capability bitmask", async function () {
      const bitmask = 0x0001 | 0x0004 // storage + validation
      await expect(didRegistry.connect(owner).updateCapabilities(agentId, bitmask))
        .to.emit(didRegistry, "CapabilitiesUpdated")
        .withArgs(agentId, bitmask)

      expect(await didRegistry.agentCapabilities(agentId)).to.equal(bitmask)
    })

    it("should reject non-owner", async function () {
      await expect(didRegistry.connect(stranger).updateCapabilities(agentId, 0x01))
        .to.be.revertedWithCustomError(didRegistry, "NotOwner")
    })
  })

  // -----------------------------------------------------------------------
  //  Ephemeral Identities
  // -----------------------------------------------------------------------

  describe("createEphemeralIdentity", function () {
    it("should create an ephemeral identity", async function () {
      const ephemeralId = randomBytes32()
      const ephemeralAddress = stranger.address
      const scopeHash = randomBytes32()
      const expiresAt = await futureTimestamp(3600)
      const nonce = await didRegistry.nonces(agentId)

      const sig = await owner.signTypedData(didDomain, CREATE_EPHEMERAL_IDENTITY_TYPES, {
        parentAgentId: agentId,
        ephemeralId,
        ephemeralAddress,
        scopeHash,
        expiresAt,
        nonce,
      })

      await expect(
        didRegistry.connect(owner).createEphemeralIdentity(agentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, sig)
      ).to.emit(didRegistry, "EphemeralIdentityCreated")
        .withArgs(agentId, ephemeralId)

      const eph = await didRegistry.ephemeralIdentities(ephemeralId)
      expect(eph.parentAgentId).to.equal(agentId)
      expect(eph.ephemeralAddress).to.equal(ephemeralAddress)
      expect(eph.active).to.equal(true)
    })

    it("should reject duplicate ephemeral id", async function () {
      const ephemeralId = randomBytes32()
      const expiresAt = await futureTimestamp(3600)
      const scopeHash1 = randomBytes32()

      let nonce = await didRegistry.nonces(agentId)
      let sig = await owner.signTypedData(didDomain, CREATE_EPHEMERAL_IDENTITY_TYPES, {
        parentAgentId: agentId, ephemeralId, ephemeralAddress: stranger.address,
        scopeHash: scopeHash1, expiresAt, nonce,
      })
      await didRegistry.connect(owner).createEphemeralIdentity(agentId, ephemeralId, stranger.address, scopeHash1, expiresAt, sig)

      const scopeHash2 = randomBytes32()
      nonce = await didRegistry.nonces(agentId)
      sig = await owner.signTypedData(didDomain, CREATE_EPHEMERAL_IDENTITY_TYPES, {
        parentAgentId: agentId, ephemeralId, ephemeralAddress: other.address,
        scopeHash: scopeHash2, expiresAt, nonce,
      })
      await expect(
        didRegistry.connect(owner).createEphemeralIdentity(agentId, ephemeralId, other.address, scopeHash2, expiresAt, sig)
      ).to.be.revertedWithCustomError(didRegistry, "EphemeralAlreadyExists")
    })
  })

  describe("deactivateEphemeralIdentity", function () {
    it("should deactivate an ephemeral identity", async function () {
      const ephemeralId = randomBytes32()
      const expiresAt = await futureTimestamp(3600)
      const scopeHash = randomBytes32()
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, CREATE_EPHEMERAL_IDENTITY_TYPES, {
        parentAgentId: agentId, ephemeralId, ephemeralAddress: stranger.address,
        scopeHash, expiresAt, nonce,
      })
      await didRegistry.connect(owner).createEphemeralIdentity(agentId, ephemeralId, stranger.address, scopeHash, expiresAt, sig)

      await expect(didRegistry.connect(owner).deactivateEphemeralIdentity(ephemeralId))
        .to.emit(didRegistry, "EphemeralIdentityDeactivated")
        .withArgs(ephemeralId)

      const eph = await didRegistry.ephemeralIdentities(ephemeralId)
      expect(eph.active).to.equal(false)
    })
  })

  // -----------------------------------------------------------------------
  //  Agent Lineage
  // -----------------------------------------------------------------------

  describe("recordLineage", function () {
    it("should record agent lineage", async function () {
      const parentId = randomBytes32()
      await expect(didRegistry.connect(owner).recordLineage(agentId, parentId, 1000, 1))
        .to.emit(didRegistry, "LineageRecorded")
        .withArgs(agentId, parentId, 1)

      const lineage = await didRegistry.agentLineage(agentId)
      expect(lineage.parentAgentId).to.equal(parentId)
      expect(lineage.forkHeight).to.equal(1000)
      expect(lineage.generation).to.equal(1)
    })
  })

  // -----------------------------------------------------------------------
  //  Verifiable Credential Anchoring
  // -----------------------------------------------------------------------

  describe("anchorCredential", function () {
    it("should anchor a credential with valid signature", async function () {
      const credentialHash = randomBytes32()
      const subjectAgentId = randomBytes32()
      const credentialCid = randomBytes32()
      const expiresAt = await futureTimestamp(86400)
      const nonce = await didRegistry.nonces(agentId)

      const sig = await owner.signTypedData(didDomain, ANCHOR_CREDENTIAL_TYPES, {
        credentialHash,
        issuerAgentId: agentId,
        subjectAgentId,
        credentialCid,
        expiresAt,
        nonce,
      })

      await expect(
        didRegistry.connect(owner).anchorCredential(credentialHash, agentId, subjectAgentId, credentialCid, expiresAt, sig)
      ).to.emit(didRegistry, "CredentialAnchored")
    })

    it("should reject zero credential hash", async function () {
      const expiresAt = await futureTimestamp(86400)
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, ANCHOR_CREDENTIAL_TYPES, {
        credentialHash: ethers.ZeroHash,
        issuerAgentId: agentId,
        subjectAgentId: randomBytes32(),
        credentialCid: randomBytes32(),
        expiresAt,
        nonce,
      })
      await expect(
        didRegistry.connect(owner).anchorCredential(ethers.ZeroHash, agentId, randomBytes32(), randomBytes32(), expiresAt, sig)
      ).to.be.revertedWithCustomError(didRegistry, "InvalidCredentialHash")
    })
  })

  describe("revokeCredential", function () {
    it("should revoke an anchored credential", async function () {
      const credentialHash = randomBytes32()
      const subjectId = randomBytes32()
      const credentialCid = randomBytes32()
      const expiresAt = await futureTimestamp(86400)
      const nonce = await didRegistry.nonces(agentId)

      const sig = await owner.signTypedData(didDomain, ANCHOR_CREDENTIAL_TYPES, {
        credentialHash, issuerAgentId: agentId, subjectAgentId: subjectId,
        credentialCid, expiresAt, nonce,
      })
      const tx = await didRegistry.connect(owner).anchorCredential(credentialHash, agentId, subjectId, credentialCid, expiresAt, sig)
      const receipt = await tx.wait()

      // Extract credentialId from event
      const event = receipt.logs.find(log => log.fragment && log.fragment.name === "CredentialAnchored")
      const credentialId = event.args[0]

      await expect(didRegistry.connect(owner).revokeCredential(credentialId))
        .to.emit(didRegistry, "CredentialRevoked")
        .withArgs(credentialId)

      const cred = await didRegistry.credentials(credentialId)
      expect(cred.revoked).to.equal(true)
    })

    it("should reject non-issuer revocation", async function () {
      const credentialHash = randomBytes32()
      const subjectId = randomBytes32()
      const credentialCid = randomBytes32()
      const expiresAt = await futureTimestamp(86400)
      const nonce = await didRegistry.nonces(agentId)
      const sig = await owner.signTypedData(didDomain, ANCHOR_CREDENTIAL_TYPES, {
        credentialHash, issuerAgentId: agentId, subjectAgentId: subjectId,
        credentialCid, expiresAt, nonce,
      })
      const tx = await didRegistry.connect(owner).anchorCredential(credentialHash, agentId, subjectId, credentialCid, expiresAt, sig)
      const receipt = await tx.wait()
      const event = receipt.logs.find(log => log.fragment && log.fragment.name === "CredentialAnchored")
      const credentialId = event.args[0]

      await expect(didRegistry.connect(stranger).revokeCredential(credentialId))
        .to.be.revertedWithCustomError(didRegistry, "NotOwner")
    })
  })
})
