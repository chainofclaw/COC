import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BackupScheduler } from "../src/backup/scheduler.ts"
import { cidToBytes32 } from "../src/backup/anchor.ts"
import type { CocBackupConfig, SnapshotManifest } from "../src/types.ts"

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

describe("BackupScheduler", () => {
  it("persists state and continues with incremental backup after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "coc-backup-scheduler-"))
    await writeFile(join(dataDir, "IDENTITY.md"), "v1")

    class FakeIpfs {
      counter = 0
      files = new Map<string, Uint8Array>()
      manifests = new Map<string, SnapshotManifest>()

      async add(data: Uint8Array) {
        const cid = `bafyfile${++this.counter}`
        this.files.set(cid, new Uint8Array(data))
        return cid
      }

      async addManifest(manifest: SnapshotManifest) {
        const cid = `bafymanifest${++this.counter}`
        this.manifests.set(cid, structuredClone(manifest))
        return cid
      }

      async cat(cid: string) {
        const data = this.files.get(cid)
        if (!data) throw new Error(`Missing file ${cid}`)
        return new Uint8Array(data)
      }

      async catManifest(cid: string) {
        const manifest = this.manifests.get(cid)
        if (!manifest) throw new Error(`Missing manifest ${cid}`)
        return structuredClone(manifest)
      }

      async mfsMkdir() {}
      async mfsCp() {}
    }

    class FakeSoul {
      latestBackup = {
        manifestCid: cidToBytes32("bootstrap"),
        dataMerkleRoot: "0x" + "00".repeat(32),
        anchoredAt: 0,
        fileCount: 0,
        totalBytes: 0,
        backupType: 0,
        parentManifestCid: "0x" + "00".repeat(64),
      }

      async getAgentIdForOwner() {
        return AGENT_ID
      }

      async anchorBackup(
        agentId: string,
        manifestCid: string,
        dataMerkleRoot: string,
        fileCount: number,
        totalBytes: number,
        backupType: 0 | 1,
        parentManifestCid: string,
      ) {
        this.latestBackup = {
          manifestCid,
          dataMerkleRoot,
          anchoredAt: this.latestBackup.anchoredAt + 1,
          fileCount,
          totalBytes,
          backupType,
          parentManifestCid,
        }
        return `0xtx${this.latestBackup.anchoredAt}`
      }

      async getLatestBackup() {
        return this.latestBackup
      }

      async getResurrectionConfig() {
        return {
          resurrectionKeyHash: "0x" + "00".repeat(32),
          maxOfflineDuration: 0,
          lastHeartbeat: 0,
          configured: false,
        }
      }

      async heartbeat() {
        return "0xheartbeat"
      }
    }

    const logger = {
      info() {},
      warn() {},
      error() {},
    }

    const ipfs = new FakeIpfs()
    const soul = new FakeSoul()
    const config = createConfig(dataDir)

    const scheduler1 = new BackupScheduler(config, soul as any, ipfs as any, logger)
    const first = await scheduler1.runBackup(false)
    expect(first.status).to.equal("completed")
    expect(first.backup?.backupType).to.equal(0)

    await writeFile(join(dataDir, "IDENTITY.md"), "v2")

    const scheduler2 = new BackupScheduler(config, soul as any, ipfs as any, logger)
    const second = await scheduler2.runBackup(false)
    expect(second.status).to.equal("completed")
    expect(second.backup?.backupType).to.equal(1)
  })
})
