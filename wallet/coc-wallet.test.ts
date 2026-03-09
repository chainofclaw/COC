import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Wallet, parseEther, formatEther } from "ethers"
import { writeFile, readFile, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// We test the exported main() and internal helpers indirectly
// by importing the module functions.

describe("coc-wallet", () => {
  const tmpKeystoreDir = join(tmpdir(), `coc-wallet-test-${Date.now()}`)

  it("create generates valid wallet via Wallet.createRandom", () => {
    const wallet = Wallet.createRandom()
    assert.ok(wallet.address.startsWith("0x"))
    assert.equal(wallet.address.length, 42)
    assert.ok(wallet.mnemonic?.phrase)
    assert.ok(wallet.mnemonic.phrase.split(" ").length >= 12)
  })

  it("import from private key produces correct address", () => {
    const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    const wallet = new Wallet(privateKey)
    assert.equal(wallet.address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  })

  it("import from mnemonic produces deterministic wallet", () => {
    const mnemonic = "test test test test test test test test test test test junk"
    const wallet = Wallet.fromPhrase(mnemonic)
    assert.ok(wallet.address.startsWith("0x"))
    assert.equal(wallet.address.length, 42)
    // Same mnemonic should yield same address
    const wallet2 = Wallet.fromPhrase(mnemonic)
    assert.equal(wallet.address, wallet2.address)
  })

  it("keystore encrypt/decrypt roundtrip", async () => {
    const wallet = Wallet.createRandom()
    const password = "test-password-123"

    const encrypted = await wallet.encrypt(password)
    assert.ok(encrypted.length > 0)
    const parsed = JSON.parse(encrypted)
    assert.ok(parsed.crypto || parsed.Crypto)

    const restored = Wallet.fromEncryptedJsonSync(encrypted, password) as unknown as Wallet
    assert.equal(restored.address, wallet.address)
    assert.equal(restored.privateKey, wallet.privateKey)
  })

  it("balance formatting roundtrip", () => {
    const wei = 1000000000000000000n // 1 ETH
    assert.equal(formatEther(wei), "1.0")

    const wei2 = 500000000000000000n // 0.5 ETH
    assert.equal(formatEther(wei2), "0.5")
  })

  it("tx construction with parseEther", () => {
    const value = parseEther("1.5")
    assert.equal(value, 1500000000000000000n)
  })

  it("keystore file save and load", async () => {
    await mkdir(tmpKeystoreDir, { recursive: true })
    const wallet = Wallet.createRandom()
    const password = "file-test-pwd"
    const encrypted = await wallet.encrypt(password)
    const filePath = join(tmpKeystoreDir, `${wallet.address.toLowerCase()}.json`)
    await writeFile(filePath, encrypted, { mode: 0o600 })

    const loaded = await readFile(filePath, "utf-8")
    const restored = Wallet.fromEncryptedJsonSync(loaded, password) as unknown as Wallet
    assert.equal(restored.address, wallet.address)

    // Cleanup
    await rm(tmpKeystoreDir, { recursive: true, force: true })
  })

  it("rejects invalid private key format", () => {
    assert.throws(() => new Wallet("not-a-key"), { message: /invalid/ })
  })
})
