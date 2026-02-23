import { mkdir, readFile, writeFile, access, readdir, stat as statFile } from "node:fs/promises"
import { join } from "node:path"
import type { IpfsBlock, CidString } from "./ipfs-types.ts"

const BLOCKS_DIR = "blocks"
const PINS_FILE = "pins.json"

export class IpfsBlockstore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async init(): Promise<void> {
    await mkdir(this.blocksDir(), { recursive: true })
  }

  async put(block: IpfsBlock): Promise<void> {
    await this.init()
    const path = this.blockPath(block.cid)
    await writeFile(path, block.bytes)
  }

  async get(cid: CidString): Promise<IpfsBlock> {
    const path = this.blockPath(cid)
    const bytes = await readFile(path)
    return { cid, bytes }
  }

  async has(cid: CidString): Promise<boolean> {
    try {
      await access(this.blockPath(cid))
      return true
    } catch {
      return false
    }
  }

  async pin(cid: CidString): Promise<void> {
    const pins = await this.readPins()
    pins.add(cid)
    await this.writePins(pins)
  }

  async listPins(): Promise<CidString[]> {
    const pins = await this.readPins()
    return [...pins]
  }

  async listBlocks(): Promise<CidString[]> {
    await this.init()
    const entries = await readdir(this.blocksDir())
    return entries
  }

  async stat(): Promise<{ numBlocks: number; repoSize: number; pins: number }> {
    await this.init()
    const entries = await readdir(this.blocksDir())
    let size = 0
    for (const entry of entries) {
      const info = await statFile(this.blockPath(entry))
      size += info.size
    }
    const pins = await this.readPins()
    return { numBlocks: entries.length, repoSize: size, pins: pins.size }
  }

  private blocksDir(): string {
    return join(this.root, BLOCKS_DIR)
  }

  private blockPath(cid: CidString): string {
    // Reject path traversal: CID must not contain directory separators, "..", or null bytes
    if (/[\/\\]|\.\./.test(cid) || cid.includes("\0")) {
      throw new Error(`invalid CID: ${cid}`)
    }
    return join(this.blocksDir(), cid)
  }

  private pinsPath(): string {
    return join(this.root, PINS_FILE)
  }

  private async readPins(): Promise<Set<CidString>> {
    try {
      const raw = await readFile(this.pinsPath(), "utf-8")
      const parsed = JSON.parse(raw) as { pins?: CidString[] }
      return new Set(parsed.pins ?? [])
    } catch {
      return new Set()
    }
  }

  private async writePins(pins: Set<CidString>): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.pinsPath(), JSON.stringify({ pins: [...pins] }, null, 2))
  }
}
