import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { snapshotBinaryFile, extractSimpleTar } from "../src/backup/binary-handler.ts"

describe("binary-handler", () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coc-binary-test-"))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe("snapshotBinaryFile (file)", () => {
    it("creates a consistent copy of a regular file", async () => {
      const filePath = join(tempDir, "test.sqlite")
      const content = Buffer.from("SQLite format 3\x00test database content")
      await writeFile(filePath, content)

      const snapshot = await snapshotBinaryFile(filePath, "database")
      try {
        const snapshotContent = await readFile(snapshot.tempPath)
        expect(Buffer.compare(snapshotContent, content)).toBe(0)
        expect(snapshot.tempPath).not.toBe(filePath)
        expect(snapshot.originalPath).toBe(filePath)
      } finally {
        await snapshot.cleanup()
      }
    })

    it("snapshot is independent from original file", async () => {
      const filePath = join(tempDir, "independent.sqlite")
      await writeFile(filePath, "original content")

      const snapshot = await snapshotBinaryFile(filePath, "database")
      try {
        await writeFile(filePath, "modified content")
        const snapshotContent = await readFile(snapshot.tempPath, "utf8")
        expect(snapshotContent).toBe("original content")
      } finally {
        await snapshot.cleanup()
      }
    })
  })

  describe("snapshotBinaryFile (directory)", () => {
    it("creates a tar archive of a directory", async () => {
      const dirPath = join(tempDir, "lancedb")
      await mkdir(dirPath, { recursive: true })
      await writeFile(join(dirPath, "table1.lance"), "lance data 1")
      await writeFile(join(dirPath, "table2.lance"), "lance data 2")

      const snapshot = await snapshotBinaryFile(dirPath, "database")
      try {
        expect(snapshot.tempPath.endsWith(".tar")).toBe(true)
        const archive = await readFile(snapshot.tempPath)
        expect(archive.length).toBeGreaterThan(0)
      } finally {
        await snapshot.cleanup()
      }
    })

    it("nested directory files are included", async () => {
      const dirPath = join(tempDir, "lancedb-nested")
      await mkdir(join(dirPath, "sub"), { recursive: true })
      await writeFile(join(dirPath, "root.lance"), "root")
      await writeFile(join(dirPath, "sub", "nested.lance"), "nested")

      const snapshot = await snapshotBinaryFile(dirPath, "database")
      try {
        const archive = await readFile(snapshot.tempPath)
        const files = extractSimpleTar(archive)
        const paths = files.map((f) => f.relativePath).sort()
        expect(paths).toEqual(["root.lance", "sub/nested.lance"])
      } finally {
        await snapshot.cleanup()
      }
    })
  })

  describe("extractSimpleTar", () => {
    it("round-trips file content correctly", async () => {
      const dirPath = join(tempDir, "roundtrip")
      await mkdir(dirPath, { recursive: true })
      const content1 = Buffer.from("hello world")
      const content2 = Buffer.from("binary\x00data\xff\xfe")
      await writeFile(join(dirPath, "a.txt"), content1)
      await writeFile(join(dirPath, "b.bin"), content2)

      const snapshot = await snapshotBinaryFile(dirPath, "database")
      try {
        const archive = await readFile(snapshot.tempPath)
        const files = extractSimpleTar(archive)

        const fileA = files.find((f) => f.relativePath === "a.txt")
        const fileB = files.find((f) => f.relativePath === "b.bin")
        expect(fileA).toBeDefined()
        expect(fileB).toBeDefined()
        expect(Buffer.compare(fileA!.content, content1)).toBe(0)
        expect(Buffer.compare(fileB!.content, content2)).toBe(0)
      } finally {
        await snapshot.cleanup()
      }
    })
  })

  describe("cleanup", () => {
    it("removes temporary files after cleanup", async () => {
      const filePath = join(tempDir, "cleanup-test.sqlite")
      await writeFile(filePath, "data")

      const snapshot = await snapshotBinaryFile(filePath, "database")
      const tempPath = snapshot.tempPath
      await snapshot.cleanup()

      await expect(readFile(tempPath)).rejects.toThrow()
    })
  })
})
