/**
 * Shared wallet / bytecode helpers for COC stress / probe scripts.
 *
 * Consolidates the signing + init-wrapper logic previously duplicated across
 * scripts/tps-benchmark.ts (signTx / signDeployTx) and the Ralph-loop probes.
 */

import { ethers, Wallet, Transaction, HDNodeWallet, JsonRpcProvider } from "ethers"

/** Hardhat / anvil deterministic dev mnemonic — funded on COC test chains. */
export const TEST_MNEMONIC =
  "test test test test test test test test test test test junk"

/** Hardhat account #0 private key (10M ETH on COC genesis). */
export const FUNDED_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

/** Derive an HD wallet at the standard path, connected to `provider`. */
export function hdWallet(provider: JsonRpcProvider, index = 0): HDNodeWallet {
  return HDNodeWallet.fromPhrase(
    TEST_MNEMONIC,
    undefined,
    `m/44'/60'/0'/0/${index}`,
  ).connect(provider)
}

/**
 * Wrap runtime bytecode in a minimal CODECOPY init stub so it can be deployed.
 *   small (<256 B): `60<len> 80 6009 3d39 3d 3df3` + runtime
 *   large (≥256 B): PUSH2 length variant `61<len2> 80 600a 3d39 3d 3df3` + runtime
 */
export function wrapInitCode(runtime: string): string {
  const rt = runtime.replace(/^0x/, "")
  const len = rt.length / 2
  if (!Number.isInteger(len)) throw new Error("runtime hex has odd length")
  if (len < 256) {
    const lenHex = len.toString(16).padStart(2, "0")
    return "0x60" + lenHex + "8060093d393df3" + rt
  }
  if (len < 65536) {
    const lenHex = len.toString(16).padStart(4, "0")
    return "0x61" + lenHex + "80600a3d393df3" + rt
  }
  throw new Error(`runtime too large to wrap: ${len} bytes`)
}

/** Sign a value-transfer tx (legacy type-0). */
export function signTransfer(
  wallet: Wallet | HDNodeWallet,
  opts: { nonce: number; to: string; value?: bigint; chainId: number; gasLimit?: bigint; gasPrice?: bigint },
): string {
  const tx = Transaction.from({
    to: opts.to,
    value: opts.value ?? 0n,
    nonce: opts.nonce,
    gasLimit: opts.gasLimit ?? 21000n,
    gasPrice: opts.gasPrice ?? 2_000_000_000n,
    chainId: opts.chainId,
    data: "0x",
  })
  return finalize(wallet, tx)
}

/** Sign a contract-creation tx from already-wrapped init code. */
export function signDeploy(
  wallet: Wallet | HDNodeWallet,
  opts: { nonce: number; initCode: string; chainId: number; gasLimit?: bigint; gasPrice?: bigint },
): string {
  const tx = Transaction.from({
    nonce: opts.nonce,
    gasLimit: opts.gasLimit ?? 300_000n,
    gasPrice: opts.gasPrice ?? 2_000_000_000n,
    chainId: opts.chainId,
    data: opts.initCode,
  })
  return finalize(wallet, tx)
}

/** Sign a contract-call tx (type-0). */
export function signCall(
  wallet: Wallet | HDNodeWallet,
  opts: { nonce: number; to: string; data?: string; value?: bigint; chainId: number; gasLimit?: bigint; gasPrice?: bigint },
): string {
  const tx = Transaction.from({
    to: opts.to,
    data: opts.data ?? "0x",
    value: opts.value ?? 0n,
    nonce: opts.nonce,
    gasLimit: opts.gasLimit ?? 100_000n,
    gasPrice: opts.gasPrice ?? 2_000_000_000n,
    chainId: opts.chainId,
  })
  return finalize(wallet, tx)
}

function finalize(wallet: Wallet | HDNodeWallet, tx: Transaction): string {
  const signed = wallet.signingKey.sign(tx.unsignedHash)
  const clone = tx.clone()
  clone.signature = signed
  return clone.serialized
}

/** Deterministic CREATE address for `from` at `nonce` (re-export for convenience). */
export function createAddress(from: string, nonce: number): string {
  return ethers.getCreateAddress({ from, nonce })
}
