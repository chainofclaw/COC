import { test } from "node:test"
import assert from "node:assert/strict"
import { EvmChain } from "../evm.ts"

test("Benchmark: 100 eth_call invocations", async () => {
  const evm = await EvmChain.create(18780)
  const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

  const start = performance.now()

  for (let i = 0; i < 100; i++) {
    await evm.callRaw({
      from,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      data: "0x",
    })
  }

  const duration = performance.now() - start
  const avgPerCall = duration / 100

  console.log(`  100 eth_call: ${duration.toFixed(2)}ms (avg: ${avgPerCall.toFixed(2)}ms/call)`)
  assert.ok(avgPerCall < 20, `Average call took ${avgPerCall.toFixed(2)}ms, expected < 20ms`)
})

test("Benchmark: 100 gas estimates", async () => {
  const evm = await EvmChain.create(18780)
  const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

  const start = performance.now()

  for (let i = 0; i < 100; i++) {
    await evm.estimateGas({
      from,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 1000n,
      data: "0x",
    })
  }

  const duration = performance.now() - start
  const avgPerEstimate = duration / 100

  console.log(`  100 gas estimates: ${duration.toFixed(2)}ms (avg: ${avgPerEstimate.toFixed(2)}ms/estimate)`)
  assert.ok(avgPerEstimate < 10, `Average estimate took ${avgPerEstimate.toFixed(2)}ms, expected < 10ms`)
})

test("Benchmark: Precompile calls (100x ecrecover)", async () => {
  const evm = await EvmChain.create(18780)

  // 有效的 ecrecover 输入
  const messageHash = "0x456e9aea5e197a1f1af7a3e85a3212fa4049a3ba34c2289b4c860fc0b0c64ef3"
  const v = "1c"
  const r = "9242685bf161793cc25603c231bc2f568eb630ea16aa137d2664ac8038825608"
  const s = "4f8ae3bd7535248d0bd448298cc2e2071e56992d0774dc340c368ae950852ada"
  const data = `0x${messageHash.slice(2)}${v}${r}${s}`

  const start = performance.now()

  for (let i = 0; i < 100; i++) {
    await evm.callRaw({
      to: "0x0000000000000000000000000000000000000001", // ecrecover
      data,
    })
  }

  const duration = performance.now() - start
  const avgPerCall = duration / 100

  console.log(`  100 ecrecover calls: ${duration.toFixed(2)}ms (avg: ${avgPerCall.toFixed(2)}ms/call)`)
  assert.ok(avgPerCall < 10, `Average ecrecover took ${avgPerCall.toFixed(2)}ms, expected < 10ms`)
})

test("Benchmark: 100 sha256 calls", async () => {
  const evm = await EvmChain.create(18780)
  const data = "0x68656c6c6f20776f726c64" // "hello world"

  const start = performance.now()

  for (let i = 0; i < 100; i++) {
    await evm.callRaw({
      to: "0x0000000000000000000000000000000000000002", // sha256
      data,
    })
  }

  const duration = performance.now() - start
  const avgPerCall = duration / 100

  console.log(`  100 sha256 calls: ${duration.toFixed(2)}ms (avg: ${avgPerCall.toFixed(2)}ms/call)`)
  assert.ok(avgPerCall < 5, `Average sha256 took ${avgPerCall.toFixed(2)}ms, expected < 5ms`)
})

test("Benchmark: Overall performance summary", async () => {
  const evm = await EvmChain.create(18780)
  const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

  // 基准1: eth_call
  const callStart = performance.now()
  for (let i = 0; i < 50; i++) {
    await evm.callRaw({ from, to: from, data: "0x" })
  }
  const callDuration = performance.now() - callStart

  // 基准2: estimateGas
  const gasStart = performance.now()
  for (let i = 0; i < 50; i++) {
    await evm.estimateGas({ from, to: from, data: "0x" })
  }
  const gasDuration = gasStart - performance.now()

  // 基准3: getBalance
  const balanceStart = performance.now()
  for (let i = 0; i < 50; i++) {
    await evm.getBalance(from)
  }
  const balanceDuration = performance.now() - balanceStart

  console.log("\n  Performance Summary:")
  console.log(`    eth_call (50x):      ${callDuration.toFixed(2)}ms`)
  console.log(`    estimateGas (50x):   ${gasDuration.toFixed(2)}ms`)
  console.log(`    getBalance (50x):    ${balanceDuration.toFixed(2)}ms`)

  // 所有操作应该在合理时间内完成
  assert.ok(callDuration < 1000, "eth_call performance acceptable")
  assert.ok(gasDuration < 1000, "estimateGas performance acceptable")
  assert.ok(balanceDuration < 500, "getBalance performance acceptable")
})
