#!/usr/bin/env node --experimental-strip-types
/**
 * COC Wallet CLI — lightweight command-line wallet for ChainOfClaw.
 *
 * Commands:
 *   create              Generate a new wallet (address + mnemonic)
 *   import <key|phrase>  Import from private key or mnemonic
 *   balance <address>    Query balance via eth_getBalance
 *   send <to> <amount>   Send ETH via eth_sendRawTransaction
 *   tx <hash>            Query transaction receipt
 *   nonce <address>      Query current nonce
 *   help                 Show usage
 */

import { Wallet, JsonRpcProvider, parseEther, formatEther } from "ethers"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const KEYSTORE_DIR = join(homedir(), ".coc", "keystore")
const DEFAULT_RPC = "http://127.0.0.1:18780"

function getRpcUrl(args: string[]): string {
  const idx = args.indexOf("--rpc")
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return process.env.COC_RPC_URL ?? DEFAULT_RPC
}

function stripFlags(args: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") { i++; continue }
    if (args[i] === "--password") { i++; continue }
    result.push(args[i])
  }
  return result
}

function getPassword(args: string[]): string {
  const idx = args.indexOf("--password")
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return process.env.COC_WALLET_PASSWORD ?? "coc-default-password"
}

// ---------------------------------------------------------------------------
// Keystore helpers
// ---------------------------------------------------------------------------

async function ensureKeystoreDir(): Promise<void> {
  await mkdir(KEYSTORE_DIR, { recursive: true })
}

function keystorePath(address: string): string {
  return join(KEYSTORE_DIR, `${address.toLowerCase()}.json`)
}

async function saveKeystore(wallet: Wallet, password: string): Promise<string> {
  await ensureKeystoreDir()
  const encrypted = await wallet.encrypt(password)
  const filePath = keystorePath(wallet.address)
  await writeFile(filePath, encrypted, { mode: 0o600 })
  return filePath
}

async function loadKeystore(address: string, password: string): Promise<Wallet> {
  const filePath = keystorePath(address)
  const encrypted = await readFile(filePath, "utf-8")
  return Wallet.fromEncryptedJsonSync(encrypted, password) as unknown as Wallet
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCreate(password: string): Promise<void> {
  const wallet = Wallet.createRandom()
  const filePath = await saveKeystore(wallet, password)
  process.stdout.write(`Address:  ${wallet.address}\n`)
  process.stdout.write(`Mnemonic: ${wallet.mnemonic?.phrase}\n`)
  process.stdout.write(`Keystore: ${filePath}\n`)
}

async function cmdImport(secret: string, password: string): Promise<void> {
  let wallet: Wallet
  if (secret.startsWith("0x") && secret.length === 66) {
    wallet = new Wallet(secret)
  } else {
    wallet = Wallet.fromPhrase(secret)
  }
  const filePath = await saveKeystore(wallet, password)
  process.stdout.write(`Imported: ${wallet.address}\n`)
  process.stdout.write(`Keystore: ${filePath}\n`)
}

async function cmdBalance(rpcUrl: string, address: string): Promise<void> {
  const raw = (await rpcCall(rpcUrl, "eth_getBalance", [address, "latest"])) as string
  const wei = BigInt(raw)
  process.stdout.write(`${formatEther(wei)} ETH\n`)
}

async function cmdSend(
  rpcUrl: string,
  from: string,
  to: string,
  amount: string,
  password: string,
): Promise<void> {
  const wallet = await loadKeystore(from, password)
  const provider = new JsonRpcProvider(rpcUrl)
  const signer = wallet.connect(provider)

  const tx = await signer.sendTransaction({
    to,
    value: parseEther(amount),
  })
  process.stdout.write(`TxHash: ${tx.hash}\n`)
  const receipt = await tx.wait()
  process.stdout.write(`Status: ${receipt?.status === 1 ? "success" : "failed"}\n`)
  process.stdout.write(`Block:  ${receipt?.blockNumber}\n`)
}

async function cmdTx(rpcUrl: string, hash: string): Promise<void> {
  const receipt = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [hash])) as Record<string, unknown> | null
  if (!receipt) {
    process.stdout.write("Transaction not found\n")
    return
  }
  process.stdout.write(`Status:      ${receipt.status === "0x1" ? "success" : "failed"}\n`)
  process.stdout.write(`BlockNumber: ${receipt.blockNumber}\n`)
  process.stdout.write(`GasUsed:     ${receipt.gasUsed}\n`)
  process.stdout.write(`From:        ${receipt.from}\n`)
  process.stdout.write(`To:          ${receipt.to ?? "(contract creation)"}\n`)
}

async function cmdNonce(rpcUrl: string, address: string): Promise<void> {
  const raw = (await rpcCall(rpcUrl, "eth_getTransactionCount", [address, "latest"])) as string
  process.stdout.write(`${parseInt(raw, 16)}\n`)
}

function cmdHelp(): void {
  process.stdout.write(`COC Wallet CLI

Usage: coc-wallet <command> [options]

Commands:
  create                     Generate a new wallet
  import <key|mnemonic>      Import from private key or mnemonic phrase
  balance <address>          Query balance
  send <from> <to> <amount>  Send ETH
  tx <hash>                  Query transaction receipt
  nonce <address>            Query account nonce
  help                       Show this help

Options:
  --rpc <url>        RPC endpoint (default: $COC_RPC_URL or http://127.0.0.1:18780)
  --password <pwd>   Keystore password (default: $COC_WALLET_PASSWORD)
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const rpcUrl = getRpcUrl(argv)
  const password = getPassword(argv)
  const args = stripFlags(argv)
  const cmd = args[0]

  switch (cmd) {
    case "create":
      await cmdCreate(password)
      break
    case "import":
      if (!args[1]) throw new Error("Usage: coc-wallet import <private-key|mnemonic>")
      await cmdImport(args.slice(1).join(" "), password)
      break
    case "balance":
      if (!args[1]) throw new Error("Usage: coc-wallet balance <address>")
      await cmdBalance(rpcUrl, args[1])
      break
    case "send":
      if (!args[1] || !args[2] || !args[3]) throw new Error("Usage: coc-wallet send <from> <to> <amount>")
      await cmdSend(rpcUrl, args[1], args[2], args[3], password)
      break
    case "tx":
      if (!args[1]) throw new Error("Usage: coc-wallet tx <hash>")
      await cmdTx(rpcUrl, args[1])
      break
    case "nonce":
      if (!args[1]) throw new Error("Usage: coc-wallet nonce <address>")
      await cmdNonce(rpcUrl, args[1])
      break
    case "help":
    case undefined:
      cmdHelp()
      break
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`)
      cmdHelp()
      process.exitCode = 1
  }
}

// Direct execution
const isDirectRun = process.argv[1]?.endsWith("coc-wallet.ts") || process.argv[1]?.endsWith("coc-wallet.js")
if (isDirectRun) {
  main(process.argv.slice(2)).catch((err: Error) => {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exitCode = 1
  })
}
