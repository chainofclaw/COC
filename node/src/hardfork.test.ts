import test from "node:test"
import assert from "node:assert/strict"
import { Hardfork } from "@ethereumjs/common"
import { Account, Address, hexToBytes } from "@ethereumjs/util"
import { Wallet } from "ethers"
import { EvmChain } from "./evm.ts"
import type { Hex } from "./blockchain-types.ts"

const CHAIN_ID = 18780
const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const FUNDED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
const PUSH0_INIT_CODE = "0x5f5ff3"
const PUSH0_RUNTIME_CODE = "0x5f00"
const TEST_CONTRACT = "0x00000000000000000000000000000000000000aa"

async function createPush0CreationTx(nonce = 0): Promise<Hex> {
  const wallet = new Wallet(FUNDED_PK)
  return await wallet.signTransaction({
    data: PUSH0_INIT_CODE,
    gasLimit: 100_000,
    gasPrice: 1_000_000_000,
    nonce,
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

test("hardforkSchedule switches block execution semantics by height", async () => {
  const evm = await EvmChain.create(CHAIN_ID, undefined, {
    hardfork: Hardfork.London,
    hardforkSchedule: [{ blockNumber: 2, hardfork: Hardfork.Shanghai }],
  })
  await evm.prefund([{ address: FUNDED_ADDRESS, balanceWei: "1000000000000000000" }])

  const block1 = await evm.executeRawTx(await createPush0CreationTx(0), 1n)
  const block2 = await evm.executeRawTx(await createPush0CreationTx(1), 2n)

  assert.equal(block1.success, false)
  assert.equal(block2.success, true)
  assert.equal(evm.getHardfork(1n), Hardfork.London)
  assert.equal(evm.getHardfork(2n), Hardfork.Shanghai)
})

test("hardforkSchedule also applies to eth_call-style execution", async () => {
  const evm = await EvmChain.create(CHAIN_ID, undefined, {
    hardfork: Hardfork.London,
    hardforkSchedule: [{ blockNumber: 2, hardfork: Hardfork.Shanghai }],
  })
  await evm.prefund([{ address: FUNDED_ADDRESS, balanceWei: "1000000000000000000" }])

  const vmStateManager = (evm as unknown as { vm: { stateManager: { putAccount(address: Address, account: Account): Promise<void>; putCode(address: Address, code: Uint8Array): Promise<void> } } }).vm.stateManager
  const contractAddress = Address.fromString(TEST_CONTRACT)
  await vmStateManager.putAccount(contractAddress, Account.fromAccountData({ nonce: 1n }))
  await vmStateManager.putCode(contractAddress, hexToBytes(PUSH0_RUNTIME_CODE))

  const beforeSwitch = await evm.callRaw({ to: TEST_CONTRACT, data: "0x" }, undefined, 1n)
  const afterSwitch = await evm.callRaw({ to: TEST_CONTRACT, data: "0x" }, undefined, 2n)

  assert.equal(beforeSwitch.failed, true)
  assert.equal(afterSwitch.failed, false)
})
