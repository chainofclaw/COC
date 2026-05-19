import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import {
  compileInWorker,
  resolveCompilerVersionTag,
  safeVerifyInternalErrorMessage,
} from "./solc-verify.ts"

describe("resolveCompilerVersionTag", () => {
  it("maps supported bare versions to full remote tags", () => {
    assert.equal(resolveCompilerVersionTag("0.8.28"), "v0.8.28+commit.7893614a")
    assert.equal(resolveCompilerVersionTag("0.8.20"), "v0.8.20+commit.a1b79de6")
  })

  it("passes through full remote tags", () => {
    assert.equal(
      resolveCompilerVersionTag("v0.8.27+commit.40a35a09"),
      "v0.8.27+commit.40a35a09",
    )
  })

  it("returns null for unsupported bare versions", () => {
    assert.equal(resolveCompilerVersionTag("0.8.99"), null)
  })
})

describe("safeVerifyInternalErrorMessage", () => {
  it("does not expose internal exception messages", () => {
    const message = safeVerifyInternalErrorMessage(
      new Error("rpc auth token leaked in upstream exception"),
    )

    assert.equal(message, "Internal verification error")
    assert.equal(message.includes("token"), false)
  })
})

describe("compileInWorker", () => {
  const solcEntry = createRequire(import.meta.url).resolve("solc")

  const SAMPLE_SOURCE = [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.0;",
    "contract C { uint256 public x; function setX(uint256 v) external { x = v; } }",
  ].join("\n")

  function buildInputJson(): string {
    return JSON.stringify({
      language: "Solidity",
      sources: { "C.sol": { content: SAMPLE_SOURCE } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        outputSelection: {
          "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] },
        },
      },
    })
  }

  it("compiles a contract in a worker thread off the main event loop", async () => {
    const result = await compileInWorker(
      {
        solcEntry,
        versionTag: "v0.8.28+commit.7893614a",
        allowRemote: false,
        isDefault: true,
        inputJson: buildInputJson(),
      },
      30_000,
    )

    assert.equal(result.ok, true)
    if (!result.ok) return
    const output = JSON.parse(result.outputJson)
    const deployed = output.contracts?.["C.sol"]?.C?.evm?.deployedBytecode?.object
    assert.ok(typeof deployed === "string" && deployed.length > 0)
  })

  it("enforces a hard deadline and terminates a runaway compile", async () => {
    // A 1ms budget cannot even spawn the worker + load solc, so the deadline
    // must fire and the worker must be terminated rather than left hanging.
    const result = await compileInWorker(
      {
        solcEntry,
        versionTag: "v0.8.28+commit.7893614a",
        allowRemote: false,
        isDefault: true,
        inputJson: buildInputJson(),
      },
      1,
    )

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, "timeout")
  })

  it("reports solc-unavailable when the package cannot be required", async () => {
    const result = await compileInWorker(
      {
        solcEntry: "/nonexistent/solc-not-here.js",
        versionTag: "v0.8.28+commit.7893614a",
        allowRemote: false,
        isDefault: true,
        inputJson: buildInputJson(),
      },
      30_000,
    )

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, "solc-unavailable")
  })

  it("runs concurrent compiles in independent workers", async () => {
    const [a, b] = await Promise.all([
      compileInWorker(
        {
          solcEntry,
          versionTag: "v0.8.28+commit.7893614a",
          allowRemote: false,
          isDefault: true,
          inputJson: buildInputJson(),
        },
        30_000,
      ),
      compileInWorker(
        {
          solcEntry,
          versionTag: "v0.8.28+commit.7893614a",
          allowRemote: false,
          isDefault: true,
          inputJson: buildInputJson(),
        },
        30_000,
      ),
    ])

    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
  })
})
