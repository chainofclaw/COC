/**
 * SoulRegistry Test Suite
 *
 * Covers: soul registration, backup anchoring, identity update,
 * guardian management, and social recovery flow.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// ---------------------------------------------------------------------------
//  EIP-712 Helpers
// ---------------------------------------------------------------------------

const DOMAIN_NAME = "COCSoulRegistry"
const DOMAIN_VERSION = "1"

function buildDomain(chainId, contractAddress) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: contractAddress,
  }
}

const REGISTER_SOUL_TYPES = {
  RegisterSoul: [
    { name: "agentId", type: "bytes32" },
    { name: "identityCid", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
}

const ANCHOR_BACKUP_TYPES = {
  AnchorBackup: [
    { name: "agentId", type: "bytes32" },
    { name: "manifestCid", type: "bytes32" },
    { name: "dataMerkleRoot", type: "bytes32" },
    { name: "fileCount", type: "uint32" },
    { name: "totalBytes", type: "uint64" },
    { name: "backupType", type: "uint8" },
    { name: "parentManifestCid", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
}

const UPDATE_IDENTITY_TYPES = {
  UpdateIdentity: [
    { name: "agentId", type: "bytes32" },
    { name: "newIdentityCid", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
}

// ---------------------------------------------------------------------------
//  Test Fixtures
// ---------------------------------------------------------------------------

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32))
}

function extractEventArg(receipt, eventName, index = 0) {
  const event = receipt.logs.find(
    (log) => log.fragment && log.fragment.name === eventName
  )
  if (!event) {
    throw new Error(`Missing event ${eventName}`)
  }
  return event.args[index]
}

async function deploySoulRegistry() {
  const Factory = await ethers.getContractFactory("SoulRegistry")
  const registry = await Factory.deploy()
  await registry.waitForDeployment()
  const address = await registry.getAddress()
  const network = await ethers.provider.getNetwork()
  const domain = buildDomain(network.chainId, address)
  return { registry, domain, address }
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("SoulRegistry", function () {
  let registry, domain, registryAddress
  let owner, guardian1, guardian2, guardian3, stranger

  beforeEach(async function () {
    ;[owner, guardian1, guardian2, guardian3, stranger] = await ethers.getSigners()
    const result = await deploySoulRegistry()
    registry = result.registry
    domain = result.domain
    registryAddress = result.address
  })

  // -----------------------------------------------------------------------
  //  Registration
  // -----------------------------------------------------------------------

  describe("registerSoul", function () {
    it("should register a new soul with valid EIP-712 signature", async function () {
      const agentId = randomBytes32()
      const identityCid = randomBytes32()

      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })

      await expect(registry.registerSoul(agentId, identityCid, sig))
        .to.emit(registry, "SoulRegistered")
        .withArgs(agentId, owner.address, identityCid)

      const soul = await registry.getSoul(agentId)
      expect(soul.agentId).to.equal(agentId)
      expect(soul.owner).to.equal(owner.address)
      expect(soul.identityCid).to.equal(identityCid)
      expect(soul.active).to.equal(true)
      expect(soul.version).to.equal(1)
      expect(soul.backupCount).to.equal(0)

      expect(await registry.ownerToAgent(owner.address)).to.equal(agentId)
      expect(await registry.soulCount()).to.equal(1)
    })

    it("should reject zero agentId", async function () {
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId: ethers.ZeroHash,
        identityCid: randomBytes32(),
        owner: owner.address,
        nonce: 0,
      })

      await expect(
        registry.registerSoul(ethers.ZeroHash, randomBytes32(), sig)
      ).to.be.revertedWithCustomError(registry, "InvalidAgentId")
    })

    it("should reject duplicate registration for same agentId", async function () {
      const agentId = randomBytes32()
      const identityCid = randomBytes32()

      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)

      // Second registration with different signer should fail
      const sig2 = await guardian1.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: guardian1.address,
        nonce: 0,
      })
      await expect(
        registry.connect(guardian1).registerSoul(agentId, identityCid, sig2)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered")
    })

    it("should reject duplicate registration for same owner", async function () {
      const agentId1 = randomBytes32()
      const agentId2 = randomBytes32()
      const identityCid = randomBytes32()

      const sig1 = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId: agentId1,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId1, identityCid, sig1)

      const sig2 = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId: agentId2,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await expect(
        registry.registerSoul(agentId2, identityCid, sig2)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered")
    })

    it("should reject invalid signature", async function () {
      const agentId = randomBytes32()
      const identityCid = randomBytes32()

      // Sign with stranger, call from owner
      const sig = await stranger.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await expect(
        registry.registerSoul(agentId, identityCid, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature")
    })
  })

  // -----------------------------------------------------------------------
  //  Backup Anchoring
  // -----------------------------------------------------------------------

  describe("anchorBackup", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)
    })

    it("should anchor a full backup", async function () {
      const manifestCid = randomBytes32()
      const dataMerkleRoot = randomBytes32()
      const fileCount = 42
      const totalBytes = 1024000
      const backupType = 0  // full
      const parentManifestCid = ethers.ZeroHash

      const sig = await owner.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
        agentId,
        manifestCid,
        dataMerkleRoot,
        fileCount,
        totalBytes,
        backupType,
        parentManifestCid,
        nonce: 1,  // nonce incremented after registration
      })

      await expect(
        registry.anchorBackup(
          agentId, manifestCid, dataMerkleRoot,
          fileCount, totalBytes, backupType, parentManifestCid, sig
        )
      )
        .to.emit(registry, "BackupAnchored")
        .withArgs(agentId, manifestCid, dataMerkleRoot, backupType)

      const soul = await registry.getSoul(agentId)
      expect(soul.latestSnapshotCid).to.equal(manifestCid)
      expect(soul.backupCount).to.equal(1)

      const latest = await registry.getLatestBackup(agentId)
      expect(latest.manifestCid).to.equal(manifestCid)
      expect(latest.dataMerkleRoot).to.equal(dataMerkleRoot)
      expect(latest.fileCount).to.equal(fileCount)
      expect(latest.totalBytes).to.equal(totalBytes)
      expect(latest.backupType).to.equal(backupType)
    })

    it("should anchor an incremental backup with parent CID", async function () {
      // First: full backup
      const fullCid = randomBytes32()
      const fullMerkle = randomBytes32()
      const sig1 = await owner.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
        agentId,
        manifestCid: fullCid,
        dataMerkleRoot: fullMerkle,
        fileCount: 10,
        totalBytes: 5000,
        backupType: 0,
        parentManifestCid: ethers.ZeroHash,
        nonce: 1,
      })
      await registry.anchorBackup(
        agentId, fullCid, fullMerkle, 10, 5000, 0, ethers.ZeroHash, sig1
      )

      // Second: incremental backup
      const incrCid = randomBytes32()
      const incrMerkle = randomBytes32()
      const sig2 = await owner.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
        agentId,
        manifestCid: incrCid,
        dataMerkleRoot: incrMerkle,
        fileCount: 3,
        totalBytes: 1500,
        backupType: 1,
        parentManifestCid: fullCid,
        nonce: 2,
      })
      await registry.anchorBackup(
        agentId, incrCid, incrMerkle, 3, 1500, 1, fullCid, sig2
      )

      expect(await registry.getBackupCount(agentId)).to.equal(2)
      const soul = await registry.getSoul(agentId)
      expect(soul.backupCount).to.equal(2)
      expect(soul.latestSnapshotCid).to.equal(incrCid)
    })

    it("should reject incremental backup without parent CID", async function () {
      const sig = await owner.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
        agentId,
        manifestCid: randomBytes32(),
        dataMerkleRoot: randomBytes32(),
        fileCount: 3,
        totalBytes: 1500,
        backupType: 1,
        parentManifestCid: ethers.ZeroHash,
        nonce: 1,
      })
      await expect(
        registry.anchorBackup(
          agentId, randomBytes32(), randomBytes32(), 3, 1500, 1, ethers.ZeroHash, sig
        )
      ).to.be.revertedWithCustomError(registry, "ParentCidRequired")
    })

    it("should reject backup from non-owner", async function () {
      const sig = await stranger.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
        agentId,
        manifestCid: randomBytes32(),
        dataMerkleRoot: randomBytes32(),
        fileCount: 10,
        totalBytes: 5000,
        backupType: 0,
        parentManifestCid: ethers.ZeroHash,
        nonce: 1,
      })
      await expect(
        registry.connect(stranger).anchorBackup(
          agentId, randomBytes32(), randomBytes32(), 10, 5000, 0, ethers.ZeroHash, sig
        )
      ).to.be.revertedWithCustomError(registry, "NotOwner")
    })

    it("should return paginated backup history", async function () {
      // Create 3 backups
      for (let i = 0; i < 3; i++) {
        const nonce = i + 1
        const cid = randomBytes32()
        const merkle = randomBytes32()
        const sig = await owner.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
          agentId,
          manifestCid: cid,
          dataMerkleRoot: merkle,
          fileCount: 10 + i,
          totalBytes: 5000 + i * 1000,
          backupType: 0,
          parentManifestCid: ethers.ZeroHash,
          nonce,
        })
        await registry.anchorBackup(
          agentId, cid, merkle, 10 + i, 5000 + i * 1000, 0, ethers.ZeroHash, sig
        )
      }

      // Paginate: offset=1, limit=2
      const page = await registry.getBackupHistory(agentId, 1, 2)
      expect(page.length).to.equal(2)
      expect(page[0].fileCount).to.equal(11)
      expect(page[1].fileCount).to.equal(12)

      // Out of bounds offset
      const empty = await registry.getBackupHistory(agentId, 10, 5)
      expect(empty.length).to.equal(0)
    })
  })

  // -----------------------------------------------------------------------
  //  Identity Update
  // -----------------------------------------------------------------------

  describe("updateIdentity", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)
    })

    it("should update identity CID with valid signature", async function () {
      const newCid = randomBytes32()
      const sig = await owner.signTypedData(domain, UPDATE_IDENTITY_TYPES, {
        agentId,
        newIdentityCid: newCid,
        nonce: 1,
      })

      await expect(registry.updateIdentity(agentId, newCid, sig))
        .to.emit(registry, "IdentityUpdated")
        .withArgs(agentId, newCid)

      const soul = await registry.getSoul(agentId)
      expect(soul.identityCid).to.equal(newCid)
    })

    it("should reject update from non-owner", async function () {
      const sig = await stranger.signTypedData(domain, UPDATE_IDENTITY_TYPES, {
        agentId,
        newIdentityCid: randomBytes32(),
        nonce: 1,
      })
      await expect(
        registry.connect(stranger).updateIdentity(agentId, randomBytes32(), sig)
      ).to.be.revertedWithCustomError(registry, "NotOwner")
    })
  })

  // -----------------------------------------------------------------------
  //  Guardian Management
  // -----------------------------------------------------------------------

  describe("guardians", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)
    })

    it("should add and remove guardians", async function () {
      await expect(registry.addGuardian(agentId, guardian1.address))
        .to.emit(registry, "GuardianAdded")
        .withArgs(agentId, guardian1.address)

      expect(await registry.getActiveGuardianCount(agentId)).to.equal(1)

      await expect(registry.addGuardian(agentId, guardian2.address))
        .to.emit(registry, "GuardianAdded")

      expect(await registry.getActiveGuardianCount(agentId)).to.equal(2)

      await expect(registry.removeGuardian(agentId, guardian1.address))
        .to.emit(registry, "GuardianRemoved")
        .withArgs(agentId, guardian1.address)

      expect(await registry.getActiveGuardianCount(agentId)).to.equal(1)
    })

    it("should reject adding self as guardian", async function () {
      await expect(
        registry.addGuardian(agentId, owner.address)
      ).to.be.revertedWithCustomError(registry, "CannotGuardSelf")
    })

    it("should reject duplicate guardian", async function () {
      await registry.addGuardian(agentId, guardian1.address)
      await expect(
        registry.addGuardian(agentId, guardian1.address)
      ).to.be.revertedWithCustomError(registry, "GuardianAlreadyAdded")
    })

    it("should reject non-owner guardian management", async function () {
      await expect(
        registry.connect(stranger).addGuardian(agentId, guardian1.address)
      ).to.be.revertedWithCustomError(registry, "NotOwner")
    })
  })

  // -----------------------------------------------------------------------
  //  Social Recovery
  // -----------------------------------------------------------------------

  describe("social recovery", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)

      // Add 3 guardians
      await registry.addGuardian(agentId, guardian1.address)
      await registry.addGuardian(agentId, guardian2.address)
      await registry.addGuardian(agentId, guardian3.address)
    })

    it("should complete recovery with 2/3 guardian approval", async function () {
      const newOwner = stranger.address

      // Guardian1 initiates recovery
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, newOwner)
      const receipt = await tx.wait()

      // Extract requestId from event
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      // Guardian2 approves
      await expect(registry.connect(guardian2).approveRecovery(requestId))
        .to.emit(registry, "RecoveryApproved")
        .withArgs(requestId, guardian2.address)

      // Advance time past RECOVERY_DELAY (1 day)
      await ethers.provider.send("evm_increaseTime", [86401])
      await ethers.provider.send("evm_mine")

      // Complete recovery
      await expect(registry.completeRecovery(requestId))
        .to.emit(registry, "RecoveryCompleted")
        .withArgs(requestId, agentId, newOwner)

      // Verify ownership transferred
      const soul = await registry.getSoul(agentId)
      expect(soul.owner).to.equal(newOwner)
      expect(await registry.ownerToAgent(newOwner)).to.equal(agentId)
      expect(await registry.ownerToAgent(owner.address)).to.equal(ethers.ZeroHash)
    })

    it("should reject recovery with insufficient approvals", async function () {
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      // Only 1/3 approval — not enough
      await ethers.provider.send("evm_increaseTime", [86401])
      await ethers.provider.send("evm_mine")

      await expect(
        registry.completeRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "RecoveryNotReady")
    })

    it("should reject recovery before time delay", async function () {
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      // Guardian2 approves (now 2/3)
      await registry.connect(guardian2).approveRecovery(requestId)

      // Try immediately — should fail
      await expect(
        registry.completeRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "RecoveryNotReady")
    })

    it("should reject non-guardian initiating recovery", async function () {
      await expect(
        registry.connect(stranger).initiateRecovery(agentId, stranger.address)
      ).to.be.revertedWithCustomError(registry, "NotGuardian")
    })

    it("should reject recovery to address(0)", async function () {
      await expect(
        registry.connect(guardian1).initiateRecovery(agentId, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "InvalidAddress")
    })

    it("should use guardian snapshot for threshold after guardian removal", async function () {
      // Initiate recovery with 3 active guardians (snapshot=3, threshold=ceil(2/3*3)=2)
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      // Owner removes all 3 guardians
      await registry.removeGuardian(agentId, guardian1.address)
      await registry.removeGuardian(agentId, guardian2.address)
      await registry.removeGuardian(agentId, guardian3.address)

      // Only 1 approval (from guardian1 at initiation) — should still need 2
      await ethers.provider.send("evm_increaseTime", [86401])
      await ethers.provider.send("evm_mine")

      await expect(
        registry.completeRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "RecoveryNotReady")
    })

    it("should reject recovery to address that already owns a soul", async function () {
      // Register a second soul owned by stranger
      const agentId2 = randomBytes32()
      const identityCid2 = randomBytes32()
      const sig2 = await stranger.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId: agentId2,
        identityCid: identityCid2,
        owner: stranger.address,
        nonce: 0,
      })
      await registry.connect(stranger).registerSoul(agentId2, identityCid2, sig2)

      // Initiate recovery of first soul to stranger (who already owns agentId2)
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      // Guardian2 approves (2/3 quorum met)
      await registry.connect(guardian2).approveRecovery(requestId)

      // Advance time past RECOVERY_DELAY
      await ethers.provider.send("evm_increaseTime", [86401])
      await ethers.provider.send("evm_mine")

      // Complete should fail — stranger already owns a soul
      await expect(
        registry.completeRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered")
    })

    it("should reject double approval", async function () {
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      await expect(
        registry.connect(guardian1).approveRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "AlreadyApproved")
    })
  })

  // -----------------------------------------------------------------------
  //  Cancel Recovery
  // -----------------------------------------------------------------------

  describe("cancelRecovery", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)
      await registry.addGuardian(agentId, guardian1.address)
      await registry.addGuardian(agentId, guardian2.address)
    })

    it("should allow owner to cancel a pending recovery", async function () {
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      await expect(registry.cancelRecovery(requestId))
        .to.emit(registry, "RecoveryCancelled")
        .withArgs(requestId, agentId)

      // Cancelled recovery cannot be completed
      await registry.connect(guardian2).approveRecovery(requestId).catch(() => {})
      await ethers.provider.send("evm_increaseTime", [86401])
      await ethers.provider.send("evm_mine")
      await expect(
        registry.completeRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "RecoveryAlreadyExecuted")
    })

    it("should reject cancel from non-owner", async function () {
      const tx = await registry.connect(guardian1).initiateRecovery(agentId, stranger.address)
      const receipt = await tx.wait()
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "RecoveryInitiated"
      )
      const requestId = event.args[0]

      await expect(
        registry.connect(stranger).cancelRecovery(requestId)
      ).to.be.revertedWithCustomError(registry, "NotOwner")
    })
  })

  // -----------------------------------------------------------------------
  //  Soul Deactivation
  // -----------------------------------------------------------------------

  describe("deactivateSoul", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)
    })

    it("should deactivate soul and release owner binding", async function () {
      await expect(registry.deactivateSoul(agentId))
        .to.emit(registry, "SoulDeactivated")
        .withArgs(agentId, owner.address)

      const soul = await registry.getSoul(agentId)
      expect(soul.active).to.equal(false)
      expect(await registry.ownerToAgent(owner.address)).to.equal(ethers.ZeroHash)
    })

    it("should allow re-registration after deactivation", async function () {
      await registry.deactivateSoul(agentId)

      // Owner can now register a new soul
      const newAgentId = randomBytes32()
      const newCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId: newAgentId,
        identityCid: newCid,
        owner: owner.address,
        nonce: 0,
      })
      await expect(registry.registerSoul(newAgentId, newCid, sig))
        .to.emit(registry, "SoulRegistered")
    })

    it("should reject deactivation from non-owner", async function () {
      await expect(
        registry.connect(stranger).deactivateSoul(agentId)
      ).to.be.revertedWithCustomError(registry, "NotOwner")
    })
  })

  // -----------------------------------------------------------------------
  //  Edge Cases
  // -----------------------------------------------------------------------

  describe("edge cases", function () {
    it("should return empty backup for unregistered agent", async function () {
      const fakeId = randomBytes32()
      const backup = await registry.getLatestBackup(fakeId)
      expect(backup.manifestCid).to.equal(ethers.ZeroHash)
    })

    it("should return empty history for unregistered agent", async function () {
      const fakeId = randomBytes32()
      const history = await registry.getBackupHistory(fakeId, 0, 10)
      expect(history.length).to.equal(0)
    })

    it("should reject zero identityCid on registration", async function () {
      const agentId = randomBytes32()

      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid: ethers.ZeroHash,
        owner: owner.address,
        nonce: 0,
      })

      await expect(
        registry.registerSoul(agentId, ethers.ZeroHash, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidCid")
    })

    it("should reject zero identityCid on updateIdentity", async function () {
      const agentId = randomBytes32()
      const identityCid = randomBytes32()

      const sig1 = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig1)

      const sig2 = await owner.signTypedData(domain, UPDATE_IDENTITY_TYPES, {
        agentId,
        newIdentityCid: ethers.ZeroHash,
        nonce: 1,
      })

      await expect(
        registry.updateIdentity(agentId, ethers.ZeroHash, sig2)
      ).to.be.revertedWithCustomError(registry, "InvalidCid")
    })

    it("should reactivate guardian instead of growing array on add-remove-add", async function () {
      const agentId = randomBytes32()
      const identityCid = randomBytes32()

      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)

      await registry.addGuardian(agentId, guardian1.address)
      const guardians1 = await registry.getGuardians(agentId)
      expect(guardians1.length).to.equal(1)

      await registry.removeGuardian(agentId, guardian1.address)
      expect(await registry.getActiveGuardianCount(agentId)).to.equal(0)

      // Re-add same guardian — should reactivate, not push new entry
      await registry.addGuardian(agentId, guardian1.address)
      const guardians2 = await registry.getGuardians(agentId)
      expect(guardians2.length).to.equal(1) // array length unchanged
      expect(await registry.getActiveGuardianCount(agentId)).to.equal(1)
      expect(guardians2[0].active).to.equal(true)
    })

    it("should increment nonces correctly across operations", async function () {
      const agentId = randomBytes32()
      const identityCid = randomBytes32()

      // Register (nonce 0)
      const sig1 = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig1)
      expect(await registry.nonces(agentId)).to.equal(1)

      // Backup (nonce 1)
      const backupCid = randomBytes32()
      const backupMerkle = randomBytes32()
      const sig2 = await owner.signTypedData(domain, ANCHOR_BACKUP_TYPES, {
        agentId,
        manifestCid: backupCid,
        dataMerkleRoot: backupMerkle,
        fileCount: 5,
        totalBytes: 2000,
        backupType: 0,
        parentManifestCid: ethers.ZeroHash,
        nonce: 1,
      })
      await registry.anchorBackup(
        agentId, backupCid, backupMerkle, 5, 2000, 0, ethers.ZeroHash, sig2
      )
      expect(await registry.nonces(agentId)).to.equal(2)

      // Update identity (nonce 2)
      const newIdentityCid = randomBytes32()
      const sig3 = await owner.signTypedData(domain, UPDATE_IDENTITY_TYPES, {
        agentId,
        newIdentityCid,
        nonce: 2,
      })
      await registry.updateIdentity(agentId, newIdentityCid, sig3)
      expect(await registry.nonces(agentId)).to.equal(3)
    })
  })

  // -----------------------------------------------------------------------
  //  Resurrection: Configuration & Heartbeat
  // -----------------------------------------------------------------------

  describe("resurrection config and heartbeat", function () {
    let agentId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)
    })

    it("should configure resurrection parameters", async function () {
      const keyHash = randomBytes32()
      const maxOffline = 3600 // 1 hour

      await expect(registry.configureResurrection(agentId, keyHash, maxOffline))
        .to.emit(registry, "ResurrectionConfigured")
        .withArgs(agentId, keyHash, maxOffline)

      const config = await registry.getResurrectionConfig(agentId)
      expect(config.resurrectionKeyHash).to.equal(keyHash)
      expect(config.maxOfflineDuration).to.equal(maxOffline)
      expect(config.configured).to.equal(true)
    })

    it("should reject zero key hash", async function () {
      await expect(
        registry.configureResurrection(agentId, ethers.ZeroHash, 3600)
      ).to.be.revertedWithCustomError(registry, "InvalidKeyHash")
    })

    it("should reject zero maxOfflineDuration", async function () {
      await expect(
        registry.configureResurrection(agentId, randomBytes32(), 0)
      ).to.be.revertedWithCustomError(registry, "InvalidAddress")
    })

    it("should send heartbeat with EIP-712 signature", async function () {
      const keyHash = randomBytes32()
      await registry.configureResurrection(agentId, keyHash, 3600)

      const HEARTBEAT_TYPES = {
        Heartbeat: [
          { name: "agentId", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
          { name: "nonce", type: "uint64" },
        ],
      }

      const timestamp = Math.floor(Date.now() / 1000)
      const sig = await owner.signTypedData(domain, HEARTBEAT_TYPES, {
        agentId,
        timestamp,
        nonce: 2, // nonce 0=register, 1=configureResurrection doesn't use nonce, but... let me check
      })

      // configureResurrection does not consume a nonce, so nonce is 1 after register
      const sig2 = await owner.signTypedData(domain, HEARTBEAT_TYPES, {
        agentId,
        timestamp,
        nonce: 1,
      })

      await expect(registry.heartbeat(agentId, timestamp, sig2))
        .to.emit(registry, "Heartbeat")
    })

    it("should detect offline status after timeout", async function () {
      const keyHash = randomBytes32()
      await registry.configureResurrection(agentId, keyHash, 3600) // 1 hour timeout

      // Right after config, should be online
      expect(await registry.isOffline(agentId)).to.equal(false)

      // Advance time past maxOfflineDuration
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")

      expect(await registry.isOffline(agentId)).to.equal(true)
    })

    it("should return false for unconfigured soul", async function () {
      expect(await registry.isOffline(agentId)).to.equal(false)
    })
  })

  // -----------------------------------------------------------------------
  //  Resurrection: Carrier Management
  // -----------------------------------------------------------------------

  describe("carrier management", function () {
    it("should register a carrier", async function () {
      const carrierId = randomBytes32()

      await expect(
        registry.registerCarrier(carrierId, "https://carrier1.example.com", 4000, 8192, 100000)
      )
        .to.emit(registry, "CarrierRegistered")
        .withArgs(carrierId, owner.address, "https://carrier1.example.com")

      const carrier = await registry.getCarrier(carrierId)
      expect(carrier.owner).to.equal(owner.address)
      expect(carrier.cpuMillicores).to.equal(4000)
      expect(carrier.memoryMB).to.equal(8192)
      expect(carrier.storageMB).to.equal(100000)
      expect(carrier.available).to.equal(true)
      expect(carrier.active).to.equal(true)
    })

    it("should reject zero carrierId", async function () {
      await expect(
        registry.registerCarrier(ethers.ZeroHash, "https://x.com", 1000, 1024, 10000)
      ).to.be.revertedWithCustomError(registry, "InvalidAgentId")
    })

    it("should reject duplicate carrier registration", async function () {
      const carrierId = randomBytes32()
      await registry.registerCarrier(carrierId, "https://c1.com", 1000, 1024, 10000)

      await expect(
        registry.registerCarrier(carrierId, "https://c2.com", 2000, 2048, 20000)
      ).to.be.revertedWithCustomError(registry, "CarrierAlreadyRegistered")
    })

    it("should deregister a carrier", async function () {
      const carrierId = randomBytes32()
      await registry.registerCarrier(carrierId, "https://c1.com", 1000, 1024, 10000)

      await expect(registry.deregisterCarrier(carrierId))
        .to.emit(registry, "CarrierDeregistered")
        .withArgs(carrierId)

      const carrier = await registry.getCarrier(carrierId)
      expect(carrier.active).to.equal(false)
      expect(carrier.available).to.equal(false)
    })

    it("should reject deregister from non-owner", async function () {
      const carrierId = randomBytes32()
      await registry.registerCarrier(carrierId, "https://c1.com", 1000, 1024, 10000)

      await expect(
        registry.connect(stranger).deregisterCarrier(carrierId)
      ).to.be.revertedWithCustomError(registry, "NotCarrierOwner")
    })

    it("should update carrier availability", async function () {
      const carrierId = randomBytes32()
      await registry.registerCarrier(carrierId, "https://c1.com", 1000, 1024, 10000)

      await registry.updateCarrierAvailability(carrierId, false)
      let carrier = await registry.getCarrier(carrierId)
      expect(carrier.available).to.equal(false)

      await registry.updateCarrierAvailability(carrierId, true)
      carrier = await registry.getCarrier(carrierId)
      expect(carrier.available).to.equal(true)
    })
  })

  // -----------------------------------------------------------------------
  //  Resurrection: Owner Key Path
  // -----------------------------------------------------------------------

  describe("resurrection owner-key path", function () {
    let agentId, carrierId, resurrectionSigner

    beforeEach(async function () {
      // Use guardian1 as the resurrection key holder
      resurrectionSigner = guardian1

      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)

      // Configure resurrection with guardian1's address hash as key hash
      const keyHash = ethers.keccak256(ethers.solidityPacked(["address"], [guardian1.address]))
      await registry.configureResurrection(agentId, keyHash, 3600)

      // Register a carrier
      carrierId = randomBytes32()
      await registry.connect(stranger).registerCarrier(carrierId, "https://carrier.example.com", 4000, 8192, 100000)
    })

    it("should complete owner-key resurrection flow", async function () {
      const RESURRECT_TYPES = {
        ResurrectSoul: [
          { name: "agentId", type: "bytes32" },
          { name: "carrierId", type: "bytes32" },
          { name: "nonce", type: "uint64" },
        ],
      }

      // Sign with resurrection key (guardian1)
      const sig = await resurrectionSigner.signTypedData(domain, RESURRECT_TYPES, {
        agentId,
        carrierId,
        nonce: 1, // nonce 1 after register
      })

      // Initiate resurrection
      const tx = await registry.initiateResurrection(agentId, carrierId, sig)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      // Carrier confirms
      await expect(registry.connect(stranger).confirmCarrier(requestId))
        .to.emit(registry, "CarrierConfirmed")

      // Complete resurrection (no time lock for owner-key)
      await expect(registry.completeResurrection(requestId))
        .to.emit(registry, "ResurrectionCompleted")
        .withArgs(requestId, agentId, carrierId)
    })

    it("should expose owner-key resurrection readiness", async function () {
      const RESURRECT_TYPES = {
        ResurrectSoul: [
          { name: "agentId", type: "bytes32" },
          { name: "carrierId", type: "bytes32" },
          { name: "nonce", type: "uint64" },
        ],
      }

      const sig = await resurrectionSigner.signTypedData(domain, RESURRECT_TYPES, {
        agentId,
        carrierId,
        nonce: 1,
      })

      const tx = await registry.initiateResurrection(agentId, carrierId, sig)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      let readiness = await registry.getResurrectionReadiness(requestId)
      expect(readiness.exists).to.equal(true)
      expect(readiness.trigger).to.equal(0)
      expect(readiness.approvalCount).to.equal(0)
      expect(readiness.approvalThreshold).to.equal(0)
      expect(readiness.carrierConfirmed).to.equal(false)
      expect(readiness.readyAt).to.equal(readiness.readyAt)
      expect(readiness.canComplete).to.equal(false)

      await registry.connect(stranger).confirmCarrier(requestId)
      readiness = await registry.getResurrectionReadiness(requestId)
      expect(readiness.carrierConfirmed).to.equal(true)
      expect(readiness.canComplete).to.equal(true)
    })

    it("should reject resurrection without carrier confirmation", async function () {
      const RESURRECT_TYPES = {
        ResurrectSoul: [
          { name: "agentId", type: "bytes32" },
          { name: "carrierId", type: "bytes32" },
          { name: "nonce", type: "uint64" },
        ],
      }

      const sig = await resurrectionSigner.signTypedData(domain, RESURRECT_TYPES, {
        agentId,
        carrierId,
        nonce: 1,
      })

      const tx = await registry.initiateResurrection(agentId, carrierId, sig)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      // Try to complete without carrier confirmation
      await expect(
        registry.completeResurrection(requestId)
      ).to.be.revertedWithCustomError(registry, "CarrierNotConfirmed")
    })

    it("should reject resurrection with wrong key", async function () {
      const RESURRECT_TYPES = {
        ResurrectSoul: [
          { name: "agentId", type: "bytes32" },
          { name: "carrierId", type: "bytes32" },
          { name: "nonce", type: "uint64" },
        ],
      }

      // Sign with stranger (wrong key)
      const sig = await stranger.signTypedData(domain, RESURRECT_TYPES, {
        agentId,
        carrierId,
        nonce: 1,
      })

      await expect(
        registry.initiateResurrection(agentId, carrierId, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature")
    })
  })

  // -----------------------------------------------------------------------
  //  Resurrection: Guardian Vote Path
  // -----------------------------------------------------------------------

  describe("resurrection guardian-vote path", function () {
    let agentId, carrierId

    beforeEach(async function () {
      agentId = randomBytes32()
      const identityCid = randomBytes32()
      const sig = await owner.signTypedData(domain, REGISTER_SOUL_TYPES, {
        agentId,
        identityCid,
        owner: owner.address,
        nonce: 0,
      })
      await registry.registerSoul(agentId, identityCid, sig)

      // Add guardians
      await registry.addGuardian(agentId, guardian1.address)
      await registry.addGuardian(agentId, guardian2.address)
      await registry.addGuardian(agentId, guardian3.address)

      // Configure resurrection
      const keyHash = randomBytes32()
      await registry.configureResurrection(agentId, keyHash, 3600) // 1 hour

      // Register carrier
      carrierId = randomBytes32()
      await registry.connect(stranger).registerCarrier(carrierId, "https://c.com", 2000, 4096, 50000)
    })

    it("should reject guardian resurrection when agent is online", async function () {
      await expect(
        registry.connect(guardian1).initiateGuardianResurrection(agentId, carrierId)
      ).to.be.revertedWithCustomError(registry, "NotOffline")
    })

    it("should complete guardian resurrection flow after offline timeout", async function () {
      // Go offline
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")
      expect(await registry.isOffline(agentId)).to.equal(true)

      // Guardian1 initiates
      const tx = await registry.connect(guardian1).initiateGuardianResurrection(agentId, carrierId)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      // Guardian2 approves (2/3 of 3 = 2 needed)
      await registry.connect(guardian2).approveResurrection(requestId)

      // Carrier confirms
      await registry.connect(stranger).confirmCarrier(requestId)

      // Too early — must wait RESURRECTION_DELAY (12 hours)
      await expect(
        registry.completeResurrection(requestId)
      ).to.be.revertedWithCustomError(registry, "ResurrectionNotReady")

      // Advance time past resurrection delay
      await ethers.provider.send("evm_increaseTime", [43201]) // 12 hours + 1
      await ethers.provider.send("evm_mine")

      // Complete
      await expect(registry.completeResurrection(requestId))
        .to.emit(registry, "ResurrectionCompleted")
        .withArgs(requestId, agentId, carrierId)

      // After resurrection, agent should be considered online again
      expect(await registry.isOffline(agentId)).to.equal(false)
    })

    it("should reject guardian resurrection completion when agent recovers during delay", async function () {
      // Go offline
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")
      expect(await registry.isOffline(agentId)).to.equal(true)

      // Guardian1 initiates
      const tx = await registry.connect(guardian1).initiateGuardianResurrection(agentId, carrierId)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      // Guardian2 approves (2/3 threshold met)
      await registry.connect(guardian2).approveResurrection(requestId)

      // Carrier confirms
      await registry.connect(stranger).confirmCarrier(requestId)

      // Advance past resurrection delay (12 hours + 1s)
      await ethers.provider.send("evm_increaseTime", [43201])
      await ethers.provider.send("evm_mine")

      // Agent recovers online via heartbeat during delay period
      const HEARTBEAT_TYPES = {
        Heartbeat: [
          { name: "agentId", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
          { name: "nonce", type: "uint64" },
        ],
      }
      const latestBlock = await ethers.provider.getBlock("latest")
      const timestamp = latestBlock.timestamp
      const currentNonce = await registry.nonces(agentId)
      const heartbeatSig = await owner.signTypedData(domain, HEARTBEAT_TYPES, {
        agentId,
        timestamp,
        nonce: currentNonce,
      })
      await registry.heartbeat(agentId, timestamp, heartbeatSig)
      expect(await registry.isOffline(agentId)).to.equal(false)

      // completeResurrection should revert because agent is back online
      await expect(
        registry.completeResurrection(requestId)
      ).to.be.revertedWithCustomError(registry, "NotOffline")
    })

    it("should reject guardian resurrection with insufficient approvals", async function () {
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")

      const tx = await registry.connect(guardian1).initiateGuardianResurrection(agentId, carrierId)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      // Only 1/3 approval
      await registry.connect(stranger).confirmCarrier(requestId)

      await ethers.provider.send("evm_increaseTime", [43201])
      await ethers.provider.send("evm_mine")

      await expect(
        registry.completeResurrection(requestId)
      ).to.be.revertedWithCustomError(registry, "ResurrectionNotReady")
    })

    it("should allow owner or initiator to cancel resurrection", async function () {
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")

      const tx = await registry.connect(guardian1).initiateGuardianResurrection(agentId, carrierId)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      await expect(registry.cancelResurrection(requestId))
        .to.emit(registry, "ResurrectionCancelled")
        .withArgs(requestId)

      // Should not be completable
      await expect(
        registry.completeResurrection(requestId)
      ).to.be.revertedWithCustomError(registry, "ResurrectionAlreadyExecuted")
    })

    it("should reject non-guardian initiating resurrection", async function () {
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")

      await expect(
        registry.connect(stranger).initiateGuardianResurrection(agentId, carrierId)
      ).to.be.revertedWithCustomError(registry, "NotGuardian")
    })

    it("should expose guardian resurrection readiness", async function () {
      await ethers.provider.send("evm_increaseTime", [3601])
      await ethers.provider.send("evm_mine")

      const tx = await registry.connect(guardian1).initiateGuardianResurrection(agentId, carrierId)
      const receipt = await tx.wait()
      const requestId = extractEventArg(receipt, "ResurrectionInitiated")

      let readiness = await registry.getResurrectionReadiness(requestId)
      expect(readiness.exists).to.equal(true)
      expect(readiness.trigger).to.equal(1)
      expect(readiness.approvalCount).to.equal(1)
      expect(readiness.approvalThreshold).to.equal(2)
      expect(readiness.carrierConfirmed).to.equal(false)
      expect(readiness.offlineNow).to.equal(true)
      expect(readiness.canComplete).to.equal(false)

      await registry.connect(guardian2).approveResurrection(requestId)
      await registry.connect(stranger).confirmCarrier(requestId)

      readiness = await registry.getResurrectionReadiness(requestId)
      expect(readiness.approvalCount).to.equal(2)
      expect(readiness.carrierConfirmed).to.equal(true)
      expect(readiness.canComplete).to.equal(false)

      await ethers.provider.send("evm_increaseTime", [43201])
      await ethers.provider.send("evm_mine")

      readiness = await registry.getResurrectionReadiness(requestId)
      expect(readiness.canComplete).to.equal(true)
    })
  })
})
