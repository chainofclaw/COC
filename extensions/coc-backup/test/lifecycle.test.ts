import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CocBackupConfig } from "../src/config-schema.ts"
import { buildDoctorReport, resolveRestorePlan, runInitFlow } from "../src/lifecycle.ts"
import { writeBackupState, writeLatestRecoveryPackage } from "../src/local-state.ts"
import type { BackupReceipt } from "../src/types.ts"

const OWNER = "0x1111111111111111111111111111111111111111"
const AGENT_ID = "0x" + "ab".repeat(32)

function createConfig(dataDir: string): CocBackupConfig {
  return {
    enabled: true,
    rpcUrl: "http://127.0.0.1:18780",
    ipfsUrl: "http://127.0.0.1:18790",
    contractAddress: "0x1234567890123456789012345678901234567890",
    privateKey: "0x" + "11".repeat(32),
    dataDir,
    autoBackupEnabled: true,
    autoBackupIntervalMs: 3600000,
    encryptMemory: false,
    encryptionPassword: undefined,
    maxIncrementalChain: 10,
    backupOnSessionEnd: true,
    categories: {
      identity: true,
      config: true,
      memory: true,
      chat: true,
      workspace: true,
    },
  }
}

describe("lifecycle", () => {
  it("runInitFlow registers a soul and reports generated recovery metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "coc-backup-init-"))
    await writeFile(join(dataDir, "IDENTITY.md"), "identity")

    let currentAgentId = "0x" + "0".repeat(64)
    const config = createConfig(dataDir)
    const soul = {
      address: OWNER,
      async getAgentIdForOwner() {
        return currentAgentId
      },
      async registerSoul(agentId: string) {
        currentAgentId = agentId
        return "0xregister"
      },
      async configureResurrection() {
        return "0xresurrection"
      },
    }
    const ipfs = {
      async add() {
        return "bafyidentity"
      },
    }
    const scheduler = {
      async runBackup(): Promise<BackupReceipt> {
        await writeLatestRecoveryPackage(dataDir, {
          version: 1,
          agentId: AGENT_ID,
          latestManifestCid: "bafylatest",
          anchoredAt: 123,
          txHash: "0xbackup",
          dataMerkleRoot: "0x" + "22".repeat(32),
          backupType: "full",
          encryptionMode: "privateKey",
          requiresPassword: false,
          recommendedRestoreCommand: "coc-backup restore --latest-local",
        })
        await writeBackupState(dataDir, {
          version: 1,
          latestAgentId: AGENT_ID,
          lastManifestCid: "bafylatest",
          incrementalCount: 0,
          lastBackupAt: 123,
          lastFullBackupAt: 123,
          latestRecoveryPackagePath: join(dataDir, ".coc-backup", "latest-recovery.json"),
          pendingResurrectionRequestId: null,
          pendingCarrierId: null,
        })
        return {
          status: "completed",
          reason: null,
          heartbeatStatus: "not_configured",
          heartbeatError: null,
          backup: {
            manifestCid: "bafylatest",
            dataMerkleRoot: "0x" + "22".repeat(32),
            fileCount: 1,
            totalBytes: 8,
            backupType: 0,
            parentManifestCid: null,
            txHash: "0xbackup",
            anchoredAt: 123,
          },
        }
      },
    }

    const result = await runInitFlow(
      config,
      soul as any,
      ipfs as any,
      scheduler as any,
      { agentId: AGENT_ID },
    )

    expect(result.alreadyRegistered).to.equal(false)
    expect(result.registrationTxHash).to.equal("0xregister")
    expect(result.backupReceipt.status).to.equal("completed")
    expect(result.recoveryPackagePath).to.match(/latest-recovery\.json$/)
  })

  it("resolveRestorePlan requires password when local recovery package says so", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "coc-backup-restore-"))
    const config = createConfig(dataDir)
    await writeLatestRecoveryPackage(dataDir, {
      version: 1,
      agentId: AGENT_ID,
      latestManifestCid: "bafylatest",
      anchoredAt: 123,
      txHash: "0xbackup",
      dataMerkleRoot: "0x" + "22".repeat(32),
      backupType: "full",
      encryptionMode: "password",
      requiresPassword: true,
      recommendedRestoreCommand: "coc-backup restore --latest-local --password <password>",
    })

    await expect(resolveRestorePlan(config, { latestLocal: true })).rejects.toThrow("--password")

    const plan = await resolveRestorePlan(config, {
      latestLocal: true,
      password: "secret",
    })
    expect(plan.manifestCid).to.equal("bafylatest")
    expect(plan.isPassword).to.equal(true)
    expect(plan.source).to.equal("latest-local")
  })

  it("buildDoctorReport marks registered soul without backups as registered_no_backup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "coc-backup-doctor-"))
    const config = createConfig(dataDir)
    const soul = {
      async getAgentIdForOwner() {
        return AGENT_ID
      },
      async getSoul() {
        return {
          agentId: AGENT_ID,
          owner: OWNER,
          identityCid: "0x" + "11".repeat(32),
          latestSnapshotCid: "0x" + "00".repeat(32),
          registeredAt: 100,
          lastBackupAt: 0,
          backupCount: 0,
          version: 1,
          active: true,
        }
      },
      async getResurrectionConfig() {
        return {
          resurrectionKeyHash: "0x" + "00".repeat(32),
          maxOfflineDuration: 0,
          lastHeartbeat: 0,
          configured: false,
        }
      },
      async isOffline() {
        return false
      },
    }
    const ipfs = {
      async ping() {
        return true
      },
    }

    const report = await buildDoctorReport(
      config,
      soul as any,
      ipfs as any,
    )

    expect(report.state).to.equal("registered_no_backup")
    expect(report.actions.some((action) => action.id === "first_backup")).to.equal(true)
  })
})
