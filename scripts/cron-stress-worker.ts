/**
 * Cron stress worker — sends signed transactions to COC testnet
 * Called by cron-stress.sh every minute.
 * Outputs a single JSON line with results.
 */
import { ethers } from "ethers"

const RPC_URL = process.argv[2] || "http://127.0.0.1:28780"
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TX_COUNT = 3
const CONFIRM_TIMEOUT_S = 15

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const wallet = new ethers.Wallet(DEPLOYER_KEY, provider)

  // Health check
  let height: number
  let peers: number
  try {
    height = await provider.getBlockNumber()
    const peerHex = await provider.send("net_peerCount", []) as string
    peers = parseInt(peerHex, 16)
  } catch {
    console.log(JSON.stringify({ status: "UNREACHABLE", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?" }))
    return
  }

  if (height === 0) {
    console.log(JSON.stringify({ status: "DEAD", height: 0, blocks: 0, sent: 0, confirmed: 0, peers, sync: "?" }))
    return
  }

  // Send transactions (type 0 legacy for stability)
  const nonce = await provider.getTransactionCount(wallet.address, "pending")
  const hashes: string[] = []
  let sendErrors = 0

  for (let i = 0; i < TX_COUNT; i++) {
    try {
      const feeData = await provider.getFeeData()
      const tx = await wallet.sendTransaction({
        to: "0x000000000000000000000000000000000000dEaD",
        value: BigInt(1000 + Math.floor(Math.random() * 9000)),
        nonce: nonce + i,
        type: 0,
        gasPrice: (feeData.gasPrice ?? ethers.parseUnits("2", "gwei")) * 2n,
        gasLimit: 21000,
      })
      hashes.push(tx.hash)
    } catch {
      sendErrors++
    }
  }

  const sent = hashes.length

  // Wait for confirmations
  let confirmed = 0
  if (sent > 0) {
    const deadline = Date.now() + CONFIRM_TIMEOUT_S * 1000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))
      confirmed = 0
      for (const h of hashes) {
        try {
          const r = await provider.getTransactionReceipt(h)
          if (r && r.status === 1) confirmed++
        } catch { /* ignore */ }
      }
      if (confirmed === sent) break
    }
  }

  // Final height
  const finalHeight = await provider.getBlockNumber()
  const blocks = finalHeight - height

  // Sync check (all nodes within 2 blocks)
  let sync = "ok"
  for (const port of [28780, 28782, 28784]) {
    try {
      const p = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`)
      const h = await p.getBlockNumber()
      if (Math.abs(finalHeight - h) > 2) sync = "desync"
    } catch {
      sync = "partial"
    }
  }

  // Status
  let status = "OK"
  if (confirmed < sent) status = "PARTIAL"
  if (sent === 0) status = "SEND_FAIL"
  if (sync === "desync") status = "DESYNC"

  console.log(JSON.stringify({ status, height: finalHeight, blocks, sent, confirmed, peers, sync }))
}

main().catch(() => {
  console.log(JSON.stringify({ status: "CRASH", height: 0, blocks: 0, sent: 0, confirmed: 0, peers: 0, sync: "?" }))
})
