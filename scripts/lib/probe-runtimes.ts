/**
 * EVM runtime bytecode pool for COC stress / probe scripts.
 *
 * Captures the hand-assembled runtimes exercised during the 2026-05-17
 * Ralph-loop stress session so they become reusable instead of being
 * re-typed inline each run. All values are raw runtime hex (no 0x prefix);
 * wrap with `wrapInitCode()` from ./wallet.ts before deploying.
 */

/** Static single-purpose runtimes, keyed by behaviour. */
export const RUNTIMES: Readonly<Record<string, string>> = Object.freeze({
  // returns the 32-byte word 0x2a
  ret2a: "602a60005260206000f3",
  // SSTORE 0x2a into slot 0, STOP
  sstore: "602a60005500",
  // slot0 = slot0 + 1, STOP  (call repeatedly to count)
  counter: "60005460010160005500",
  // emit LOG0 of a 32-byte word
  log0: "602a60005260206000a000",
  // returns block.timestamp
  timestamp: "4260005260206000f3",
  // returns block.number
  number: "4360005260206000f3",
  // returns msg.sender
  caller: "3360005260206000f3",
  // returns remaining gas
  gasleft: "5a60005260206000f3",
  // returns chainid
  chainid: "4660005260206000f3",
  // returns self balance
  selfbalance: "4760005260206000f3",
  // returns tx gasprice
  gasprice: "3a60005260206000f3",
  // returns tx.origin
  origin: "3260005260206000f3",
  // returns block.coinbase
  coinbase: "4160005260206000f3",
  // returns block gas limit
  gaslimit: "4560005260206000f3",
  // returns PREVRANDAO / difficulty
  prevrandao: "4460005260206000f3",
  // returns MSIZE
  msize: "5960005260206000f3",
  // returns calldatasize
  calldatasize: "3660005260206000f3",
  // unconditional REVERT with empty data
  revert: "60006000fd",
  // infinite JUMP loop — consumes all gas (OOG)
  oogLoop: "5b600056",
})

/**
 * Factory runtime: when invoked, internally CREATEs a child whose runtime is
 * `ret2a`, and SSTOREs the child address into slot 0.
 * Child init code is the 19-byte `wrapInitCode(ret2a)` packed into one PUSH32.
 */
export const FACTORY_RET2A: string =
  "7f" +
  "00".repeat(13) +
  "600a8060093d393df3" + RUNTIMES.ret2a + // 19-byte child init
  "6000" + "52" +   // MSTORE word @0
  "6013" + "600d" + "6000" + // length=19, offset=13, value=0
  "f0" +             // CREATE
  "6000" + "55" +   // SSTORE child addr -> slot 0
  "00"               // STOP

/**
 * Build a compute-heavy runtime: a bounded loop running `iterations` rounds of
 * KECCAK256 over a 32-byte memory word. Useful for gas-metering / compute-load
 * probes. `iterations` must be 1..65535.
 */
export function buildComputeLoop(iterations: number): string {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 65535) {
    throw new Error(`iterations out of range (1..65535): ${iterations}`)
  }
  const count = iterations.toString(16).padStart(4, "0")
  // PUSH2 count; JUMPDEST(pc3); PUSH1 32; PUSH1 0; SHA3; PUSH1 0; MSTORE;
  // PUSH1 1; SWAP1; SUB; DUP1; PUSH2 0x0003; JUMPI; STOP
  return "61" + count + "5b" + "6020" + "6000" + "20" + "6000" + "52" +
    "6001" + "90" + "03" + "80" + "6003" + "57" + "00"
}

/** Build a SELFDESTRUCT runtime that sends the balance to `beneficiary`. */
export function buildSelfdestruct(beneficiary: string): string {
  const addr = beneficiary.replace(/^0x/, "").toLowerCase()
  if (addr.length !== 40) throw new Error(`bad beneficiary address: ${beneficiary}`)
  return "73" + addr + "ff" // PUSH20 <addr> SELFDESTRUCT
}

/** Pick `n` distinct runtime names at random (for random-combo stress runs). */
export function pickRuntimes(n: number): string[] {
  const names = Object.keys(RUNTIMES)
  return names.sort(() => Math.random() - 0.5).slice(0, Math.min(n, names.length))
}
