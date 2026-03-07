import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePrivateKey } from "./key-material.ts"

test("resolvePrivateKey prefers env value then file sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-key-"))
  const filePath = join(dir, "operator.key")
  writeFileSync(filePath, `0x${"12".repeat(32)}\n`)

  assert.equal(
    resolvePrivateKey({
      envValue: `0x${"34".repeat(32)}`,
      envFilePath: filePath,
      label: "operator",
    }),
    `0x${"34".repeat(32)}`,
  )
  assert.equal(
    resolvePrivateKey({
      envFilePath: filePath,
      label: "operator",
    }),
    `0x${"12".repeat(32)}`,
  )
})

test("resolvePrivateKey rejects malformed keys", () => {
  assert.throws(
    () => resolvePrivateKey({ envValue: "0x1234", label: "operator" }),
    /invalid operator private key format/,
  )
})
