import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
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
