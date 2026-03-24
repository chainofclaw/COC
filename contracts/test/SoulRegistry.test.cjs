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
})
