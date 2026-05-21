import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { InterfaceBlockstoreAdapter } from "./ipfs-blockstore-adapter.ts"

let tmpDir: string
let store: IpfsBlockstore

async function rawCid(bytes: Uint8Array): Promise<CID> {
  const digest = await sha256.digest(bytes)
  return CID.createV1(0x55, digest)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bs-adapter-"))
  store = new IpfsBlockstore(tmpDir)
  await store.init()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("InterfaceBlockstoreAdapter", () => {
  it("put/get/has round-trip with CID <-> string translation", async () => {
    const adapter = new InterfaceBlockstoreAdapter(store)
    const bytes = new TextEncoder().encode("hello adapter")
    const cid = await rawCid(bytes)

    const returned = await adapter.put(cid, bytes)
    assert.equal(returned.toString(), cid.toString())
    assert.equal(await adapter.has(cid), true)
    // `get` returns a Buffer (COC's blockstore reads via fs.readFile);
    // Buffer is a Uint8Array subtype — compare on byte content.
    assert.deepEqual(Buffer.from(await adapter.get(cid)), Buffer.from(bytes))

    // The bytes are visible through COC's native string-keyed API too.
    const native = await store.get(cid.toString())
    assert.deepEqual(Buffer.from(native.bytes), Buffer.from(bytes))
  })

  it("get falls through COC's fetchRemote hook (C1.3)", async () => {
    const bytes = new TextEncoder().encode("remote block")
    const cid = await rawCid(bytes)
    let fetchCalled = false
    store.setHooks({
      fetchRemote: async (wanted) => {
        fetchCalled = true
        assert.equal(wanted, cid.toString())
        return bytes
      },
    })
    const adapter = new InterfaceBlockstoreAdapter(store)
    assert.deepEqual(await adapter.get(cid), bytes)
    assert.equal(fetchCalled, true)
  })

  it("enforces the per-adapter block-read budget", async () => {
    const adapter = new InterfaceBlockstoreAdapter(store, { maxBlockReads: 2 })
    const bytes = new TextEncoder().encode("budget")
    const cid = await rawCid(bytes)
    await adapter.put(cid, bytes)

    await adapter.get(cid)
    await adapter.get(cid)
    await assert.rejects(() => adapter.get(cid), /read budget exceeded/)
    assert.equal(adapter.reads, 3)
  })

  it("delete is a no-op — the adapter must not drop COC blocks", async () => {
    const adapter = new InterfaceBlockstoreAdapter(store)
    const bytes = new TextEncoder().encode("keep me")
    const cid = await rawCid(bytes)
    await adapter.put(cid, bytes)
    await adapter.delete(cid)
    assert.equal(await store.has(cid.toString()), true)
  })
})
