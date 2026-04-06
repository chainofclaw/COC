import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { keccak256, toUtf8Bytes } from "ethers"
import { createCidResolver } from "../src/recovery/cid-resolver.ts"

function cidToBytes32(cid: string): string {
  return keccak256(toUtf8Bytes(cid))
}

function createFakeIpfs() {
  const mfs = new Map<string, string>()
  return {
    mfsMkdir: async (_path: string) => {},
    mfsRead: async (path: string): Promise<string> => {
      const content = mfs.get(path)
      if (!content) throw new Error(`MFS path not found: ${path}`)
      return content
    },
    mfsWrite: async (path: string, content: string) => {
      mfs.set(path, content)
    },
    mfsRm: async (_path: string) => {},
    mfsCp: async (_cid: string, _dest: string) => {},
    add: async (_data: Uint8Array): Promise<string> => "QmTest",
    addJson: async (_obj: unknown): Promise<string> => "QmTest",
    addManifest: async (_manifest: unknown): Promise<string> => "QmTest",
    cat: async (_cid: string): Promise<Uint8Array> => new Uint8Array(),
    catJson: async <T>(_cid: string): Promise<T> => ({}) as T,
    catManifest: async (_cid: string) => ({}) as any,
    ping: async (): Promise<boolean> => true,
    _mfs: mfs,
  }
}

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe("cid-resolver", () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coc-cid-test-"))
    await mkdir(join(tempDir, ".coc-backup"), { recursive: true })
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe("register and resolve", () => {
    it("registers a CID and resolves it from local index", async () => {
      const ipfs = createFakeIpfs()
      const resolver = createCidResolver({
        dataDir: tempDir,
        agentId: "0x" + "a".repeat(64),
        ipfs: ipfs as any,
        logger: fakeLogger,
      })

      const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
      const cidHash = cidToBytes32(cid)

      await resolver.register(cidHash, cid)
      const resolved = await resolver.resolve(cidHash)
      expect(resolved).toBe(cid)
    })

    it("persists to local index file", async () => {
      const ipfs = createFakeIpfs()
      const resolver = createCidResolver({
        dataDir: tempDir,
        agentId: "0x" + "b".repeat(64),
        ipfs: ipfs as any,
        logger: fakeLogger,
      })

      const cid = "QmPersistTest123456789012345678901234567890"
      const cidHash = cidToBytes32(cid)
      await resolver.register(cidHash, cid)

      const indexPath = join(tempDir, ".coc-backup", "cid-index.json")
      const content = JSON.parse(await readFile(indexPath, "utf8"))
      expect(content.entries[cidHash]).toBeDefined()
      expect(content.entries[cidHash].cid).toBe(cid)
    })

    it("rejects registration with mismatched hash", async () => {
      const ipfs = createFakeIpfs()
      const resolver = createCidResolver({
        dataDir: tempDir,
        agentId: "0x" + "c".repeat(64),
        ipfs: ipfs as any,
        logger: fakeLogger,
      })

      const cid = "QmSomeCid"
      const wrongHash = "0x" + "0".repeat(64)

      await expect(resolver.register(wrongHash, cid)).rejects.toThrow(/CID hash mismatch/)
    })
  })

  describe("MFS fallback", () => {
    it("resolves from MFS when local index misses", async () => {
      const freshDir = await mkdtemp(join(tmpdir(), "coc-cid-mfs-"))
      try {
        const ipfs = createFakeIpfs()
        const agentId = "0x" + "d".repeat(64)
        const cid = "QmMfsResolutionTest12345678901234567890"
        const cidHash = cidToBytes32(cid)

        const mfsPath = `/soul-backups/${agentId.slice(0, 10)}/cid-map.json`
        ipfs._mfs.set(mfsPath, JSON.stringify({ [cidHash]: cid }))

        const resolver = createCidResolver({
          dataDir: freshDir,
          agentId,
          ipfs: ipfs as any,
          logger: fakeLogger,
        })

        const resolved = await resolver.resolve(cidHash)
        expect(resolved).toBe(cid)
      } finally {
        await rm(freshDir, { recursive: true, force: true })
      }
    })
  })

  describe("on-chain fallback", () => {
    it("resolves from on-chain registry when other layers miss", async () => {
      const freshDir = await mkdtemp(join(tmpdir(), "coc-cid-chain-"))
      try {
        const ipfs = createFakeIpfs()
        const cid = "QmOnChainResolution1234567890123456789"
        const cidHash = cidToBytes32(cid)

        const fakeRegistry = {
          resolveCid: async (hash: string) => hash === cidHash ? cid : "",
          registerCid: async () => "0xtxhash",
          isRegistered: async () => false,
        }

        const resolver = createCidResolver({
          dataDir: freshDir,
          agentId: "0x" + "e".repeat(64),
          ipfs: ipfs as any,
          cidRegistry: fakeRegistry,
          logger: fakeLogger,
        })

        const resolved = await resolver.resolve(cidHash)
        expect(resolved).toBe(cid)
      } finally {
        await rm(freshDir, { recursive: true, force: true })
      }
    })
  })

  describe("returns null when not found", () => {
    it("returns null when CID is not in any layer", async () => {
      const freshDir = await mkdtemp(join(tmpdir(), "coc-cid-none-"))
      try {
        const ipfs = createFakeIpfs()
        const resolver = createCidResolver({
          dataDir: freshDir,
          agentId: "0x" + "f".repeat(64),
          ipfs: ipfs as any,
          logger: fakeLogger,
        })

        const resolved = await resolver.resolve("0x" + "1".repeat(64))
        expect(resolved).toBeNull()
      } finally {
        await rm(freshDir, { recursive: true, force: true })
      }
    })
  })
})
