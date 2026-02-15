import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createTarEntry, createTarArchive } from "./ipfs-tar.ts"

describe("createTarEntry", () => {
  it("produces 512-byte aligned output for empty file", () => {
    const entry = createTarEntry({ name: "empty.txt", data: new Uint8Array(0) })
    // Header only (512 bytes), no data blocks needed for empty
    assert.equal(entry.length, 512)
  })

  it("produces 512-byte aligned output for small file", () => {
    const data = new TextEncoder().encode("hello")
    const entry = createTarEntry({ name: "small.txt", data })
    // 512 header + 512 data block (5 bytes padded to 512)
    assert.equal(entry.length, 1024)
  })

  it("produces correct alignment for data crossing block boundary", () => {
    const data = new Uint8Array(513) // just over one block
    const entry = createTarEntry({ name: "big.txt", data })
    // 512 header + 1024 data (513 bytes rounded up to 2 blocks)
    assert.equal(entry.length, 512 + 1024)
  })

  it("embeds name in header", () => {
    const data = new TextEncoder().encode("test")
    const entry = createTarEntry({ name: "myfile.dat", data })
    const nameBytes = entry.slice(0, 10)
    assert.equal(new TextDecoder().decode(nameBytes), "myfile.dat")
  })

  it("writes file size in octal at offset 124", () => {
    const data = new Uint8Array(42)
    const entry = createTarEntry({ name: "f", data })
    // Size field at offset 124, 12 bytes, octal null-terminated
    const sizeField = new TextDecoder().decode(entry.slice(124, 135))
    assert.ok(sizeField.includes("52")) // 42 in octal = 52
  })

  it("sets ustar magic at offset 257", () => {
    const entry = createTarEntry({ name: "x", data: new Uint8Array(1) })
    const magic = new TextDecoder().decode(entry.slice(257, 262))
    assert.equal(magic, "ustar")
  })

  it("has valid checksum", () => {
    const entry = createTarEntry({ name: "check.txt", data: new TextEncoder().encode("abc") })
    // Recompute checksum treating checksum field (148-155) as spaces
    const header = entry.slice(0, 512)
    let sum = 0
    for (let i = 0; i < 512; i++) {
      if (i >= 148 && i < 156) {
        sum += 0x20 // treat checksum field as spaces
      } else {
        sum += header[i]
      }
    }
    // Read stored checksum
    const storedStr = new TextDecoder().decode(header.slice(148, 155)).replace(/\0/g, "").trim()
    const stored = parseInt(storedStr, 8)
    assert.equal(stored, sum)
  })
})

describe("createTarArchive", () => {
  it("produces archive with EOF marker for empty entries", () => {
    const archive = createTarArchive([])
    // Just two 512-byte EOF blocks
    assert.equal(archive.length, 1024)
    // All zeros
    assert.ok(archive.every((b) => b === 0))
  })

  it("single entry archive has header + data + EOF", () => {
    const data = new TextEncoder().encode("content")
    const archive = createTarArchive([{ name: "file.txt", data }])
    // 512 header + 512 data + 1024 EOF = 2048
    assert.equal(archive.length, 2048)
  })

  it("multiple entries are concatenated", () => {
    const a = new TextEncoder().encode("aaa")
    const b = new TextEncoder().encode("bbb")
    const archive = createTarArchive([
      { name: "a.txt", data: a },
      { name: "b.txt", data: b },
    ])
    // 2 * (512 header + 512 data) + 1024 EOF = 3072
    assert.equal(archive.length, 3072)
  })

  it("file data is preserved in archive", () => {
    const data = new TextEncoder().encode("preserved content")
    const archive = createTarArchive([{ name: "p.txt", data }])
    // Data starts at offset 512 (after header)
    const extracted = archive.slice(512, 512 + data.length)
    assert.deepEqual(extracted, data)
  })

  it("EOF marker is all zeros", () => {
    const archive = createTarArchive([{ name: "x", data: new Uint8Array(1) }])
    const eof = archive.slice(archive.length - 1024)
    assert.ok(eof.every((b) => b === 0))
  })

  it("handles large file spanning multiple blocks", () => {
    const data = new Uint8Array(1500) // ~3 blocks
    data.fill(0xAB)
    const archive = createTarArchive([{ name: "big", data }])
    // 512 header + 1536 data (3 blocks) + 1024 EOF = 3072
    assert.equal(archive.length, 512 + 1536 + 1024)
    // Verify data integrity
    assert.equal(archive[512], 0xAB)
    assert.equal(archive[512 + 1499], 0xAB)
  })
})
