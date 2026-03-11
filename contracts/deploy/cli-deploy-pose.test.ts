import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  loadPoseArtifact,
  parseDeployCliArgs,
  runDeployCli,
} from "./cli-deploy-pose.ts"

describe("cli-deploy-pose", () => {
  it("parses defaults", () => {
    const parsed = parseDeployCliArgs([])
    assert.equal(parsed.target, "l2-coc")
    assert.equal(parsed.json, false)
    assert.equal(parsed.help, false)
    assert.match(parsed.artifactPath, /PoSeManagerV2\.json$/)
  })

  it("parses custom options", () => {
    const parsed = parseDeployCliArgs([
      "--target", "l1-sepolia",
      "--artifact", "contracts/artifacts/contracts-src/settlement/PoSeManagerV2.sol/PoSeManagerV2.json",
      "--private-key", "0xabc",
      "--json",
    ])
    assert.equal(parsed.target, "l1-sepolia")
    assert.equal(parsed.privateKey, "0xabc")
    assert.equal(parsed.json, true)
    assert.match(parsed.artifactPath, /PoSeManagerV2\.json$/)
  })

  it("rejects unsupported or malformed arguments", () => {
    assert.throws(() => parseDeployCliArgs(["--target", "nope"]), /unsupported deploy target/)
    assert.throws(() => parseDeployCliArgs(["--artifact"]), /requires a value/)
    assert.throws(() => parseDeployCliArgs(["--unknown"]), /unknown argument/)
  })

  it("loads the bundled PoSe artifact", async () => {
    const artifactPath = fileURLToPath(
      new URL("../artifacts/contracts-src/settlement/PoSeManagerV2.sol/PoSeManagerV2.json", import.meta.url),
    )
    const artifact = await loadPoseArtifact(artifactPath)
    assert.ok(Array.isArray(artifact.abi))
    assert.ok(artifact.abi.length > 0)
    assert.match(artifact.bytecode, /^0x[0-9a-f]+$/i)
  })

  it("runs the CLI wrapper with injected dependencies", async () => {
    const lines: string[] = []
    const result = await runDeployCli(
      ["--target", "l2-coc", "--json"],
      {
        log: (message) => lines.push(message),
        error: () => assert.fail("unexpected error output"),
      },
      {
        loadArtifact: async () => ({ abi: [{ type: "constructor" }], bytecode: "0x6000" }),
        deploy: async (target, abi, bytecode, privateKey) => {
          assert.equal(target, "l2-coc")
          assert.equal(Array.isArray(abi), true)
          assert.equal(bytecode, "0x6000")
          assert.equal(privateKey, undefined)
          return {
            contractAddress: "0x1111111111111111111111111111111111111111",
            transactionHash: "0x2222",
            blockNumber: 7,
            chainId: 18780,
          }
        },
      },
    )

    assert.equal(result?.chainId, 18780)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /"target": "l2-coc"/)
    assert.match(lines[0], /"contractAddress": "0x1111111111111111111111111111111111111111"/)
  })
})
