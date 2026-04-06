import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { detectChanges } from "../src/backup/change-detector.ts"
import type { CocBackupConfig } from "../src/config-schema.ts"

const defaultConfig: CocBackupConfig = {
  enabled: true,
  rpcUrl: "http://localhost:18780",
  ipfsUrl: "http://localhost:18790",
  contractAddress: "0x" + "a".repeat(40),
  privateKey: "0x" + "b".repeat(64),
  dataDir: "~/.openclaw",
  autoBackupEnabled: true,
  autoBackupIntervalMs: 3600000,
  encryptMemory: false,
  maxIncrementalChain: 10,
  backupOnSessionEnd: true,
  carrier: {
    enabled: false,
    workDir: "/tmp/coc-resurrections",
    watchedAgents: [],
    pendingRequestIds: [],
    pollIntervalMs: 60_000,
    readinessTimeoutMs: 86_400_000,
    readinessPollMs: 30_000,
  },
  categories: {
    identity: true,
    config: true,
    memory: true,
    chat: true,
    workspace: true,
    database: true,
  },
}

describe("change-detector extended rules", () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coc-detector-test-"))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("classifies SQLite memory index as database category", async () => {
    await mkdir(join(tempDir, "memory"), { recursive: true })
    await writeFile(join(tempDir, "memory", "default.sqlite"), "sqlite data")

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const sqliteFile = changes.added.find((f) => f.relativePath === "memory/default.sqlite")
    expect(sqliteFile).toBeDefined()
    expect(sqliteFile!.category).toBe("database")
    expect(sqliteFile!.encrypted).toBe(true)
  })

  it("classifies LanceDB files as database category", async () => {
    await mkdir(join(tempDir, "memory", "lancedb"), { recursive: true })
    await writeFile(join(tempDir, "memory", "lancedb", "vectors.lance"), "lance data")

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const lanceFile = changes.added.find((f) => f.relativePath === "memory/lancedb/vectors.lance")
    expect(lanceFile).toBeDefined()
    expect(lanceFile!.category).toBe("database")
    expect(lanceFile!.encrypted).toBe(true)
  })

  it("classifies openclaw.json as config category (encrypted)", async () => {
    await writeFile(join(tempDir, "openclaw.json"), '{"gateway": {}}')

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const configFile = changes.added.find((f) => f.relativePath === "openclaw.json")
    expect(configFile).toBeDefined()
    expect(configFile!.category).toBe("config")
    expect(configFile!.encrypted).toBe(true)
  })

  it("classifies plugin manifests as config category (not encrypted)", async () => {
    await mkdir(join(tempDir, "plugins", "my-plugin"), { recursive: true })
    await writeFile(join(tempDir, "plugins", "my-plugin", "openclaw.plugin.json"), '{}')

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const pluginFile = changes.added.find((f) =>
      f.relativePath === "plugins/my-plugin/openclaw.plugin.json")
    expect(pluginFile).toBeDefined()
    expect(pluginFile!.category).toBe("config")
    expect(pluginFile!.encrypted).toBe(false)
  })

  it("classifies session registry as chat category", async () => {
    await mkdir(join(tempDir, "agents", "default", "sessions"), { recursive: true })
    await writeFile(
      join(tempDir, "agents", "default", "sessions", "sessions.json"),
      '{"main": {"sessionId": "abc"}}',
    )

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const sessionFile = changes.added.find((f) =>
      f.relativePath === "agents/default/sessions/sessions.json")
    expect(sessionFile).toBeDefined()
    expect(sessionFile!.category).toBe("chat")
  })

  it("classifies credentials as config category (encrypted)", async () => {
    await mkdir(join(tempDir, "credentials"), { recursive: true })
    await writeFile(join(tempDir, "credentials", "api-key.json"), '{"key": "secret"}')

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const credFile = changes.added.find((f) => f.relativePath === "credentials/api-key.json")
    expect(credFile).toBeDefined()
    expect(credFile!.category).toBe("config")
    expect(credFile!.encrypted).toBe(true)
  })

  it("classifies context snapshot as workspace category", async () => {
    await mkdir(join(tempDir, ".coc-backup"), { recursive: true })
    await writeFile(join(tempDir, ".coc-backup", "context-snapshot.json"), '{"version":1}')

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const snapshotFile = changes.added.find((f) =>
      f.relativePath === ".coc-backup/context-snapshot.json")
    expect(snapshotFile).toBeDefined()
    expect(snapshotFile!.category).toBe("workspace")
  })

  it("respects database category toggle", async () => {
    const configNoDb = {
      ...defaultConfig,
      categories: { ...defaultConfig.categories, database: false },
    }

    const changes = await detectChanges(tempDir, configNoDb, null)
    const dbFiles = changes.added.filter((f) => f.category === "database")
    expect(dbFiles.length).toBe(0)
  })

  it("still detects original file categories", async () => {
    await writeFile(join(tempDir, "IDENTITY.md"), "# Identity")
    await writeFile(join(tempDir, "MEMORY.md"), "# Memory")

    const changes = await detectChanges(tempDir, defaultConfig, null)
    const identityFile = changes.added.find((f) => f.relativePath === "IDENTITY.md")
    const memoryFile = changes.added.find((f) => f.relativePath === "MEMORY.md")
    expect(identityFile).toBeDefined()
    expect(identityFile!.category).toBe("identity")
    expect(memoryFile).toBeDefined()
    expect(memoryFile!.category).toBe("memory")
  })
})
