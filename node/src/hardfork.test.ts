import test from "node:test"
import assert from "node:assert/strict"
import { Hardfork } from "@ethereumjs/common"
import { Wallet } from "ethers"
import { EvmChain } from "./evm.ts"
import type { Hex } from "./blockchain-types.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const PUSH0_INIT_CODE = "0x5f5ff3"

async function createPush0CreationTx(): Promise<Hex> {
  const wallet = new Wallet(FUNDED_PK)
  return await wallet.signTransaction({
    data: PUSH0_INIT_CODE,
    gasLimit: 100_000,
    gasPrice: 1_000_000_000,
    nonce: 0,
    chainId: CHAIN_ID,
  }) as Hex
}

test("EvmChain defaults to Shanghai hardfork", async () => {
  const evm = await EvmChain.create(CHAIN_ID)
  assert.equal(evm.getHardfork(), Hardfork.Shanghai)
})

test("Shanghai accepts PUSH0 contract creation", async () => {
  const evm = await EvmChain.create(CHAIN_ID)
  await evm.prefund([{ address: FUNDED_ADDRESS, balanceWei: "1000000000000000000" }])

  const result = await evm.executeRawTx(await createPush0CreationTx())
  assert.equal(result.success, true)
})

test("London rejects PUSH0 contract creation", async () => {
  const evm = await EvmChain.create(CHAIN_ID, undefined, { hardfork: Hardfork.London })
  await evm.prefund([{ address: FUNDED_ADDRESS, balanceWei: "1000000000000000000" }])

  const result = await evm.executeRawTx(await createPush0CreationTx())
  assert.equal(result.success, false)
})
