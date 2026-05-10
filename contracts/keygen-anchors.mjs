/**
 * Phase 0 — generate independent EVM keypairs for the 3 BFT-promotable
 * gcloud nodes (anchor-1, anchor-2, burst-1). Persists each private key
 * to ~/.coc/keys/<role>.key (chmod 600) and writes a public manifest.
 *
 * Each node's identity must be unique to avoid the equivocation that
 * would result from sharing an anvil dev key with an upstream validator
 * (see docs/gcloud-multinode-validation-2026-05-08.md §3 — current
 * 5-cluster shares only 2 EVM identities, both colliding upstream).
 */
import { Wallet, SigningKey } from "ethers"
import { writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ROLES = ["anchor-1", "anchor-2", "burst-1"]
const KEY_DIR = join(homedir(), ".coc/keys")
const manifest = {
  generatedAt: new Date().toISOString(),
  chainId: 18780,
  validatorRegistry: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
  identities: {},
}

for (const role of ROLES) {
  const w = Wallet.createRandom()
  const sk = new SigningKey(w.privateKey)
  // Uncompressed pubkey: 0x04 || X || Y (65 bytes / 130 hex + 0x04 prefix → 132 hex with 0x)
  const pubkeyUncompressed = sk.publicKey
  // ValidatorRegistry: nodeId = keccak256(pubkey[1:65])  i.e. drop the 0x04 prefix.
  // For an EVM address, address = nodeId.slice(-20). So the trailing 20 B of nodeId == address.
  // We derive nodeId via ethers' built-in keccak so it matches Solidity exactly.
  const { keccak256, getBytes } = await import("ethers")
  const pubBytes = getBytes(pubkeyUncompressed) // 65 bytes
  const nodeId = keccak256(pubBytes.slice(1)) // 32 bytes hex

  const keyPath = join(KEY_DIR, `${role}.key`)
  writeFileSync(keyPath, w.privateKey + "\n", { mode: 0o600 })
  chmodSync(keyPath, 0o600)

  manifest.identities[role] = {
    address: w.address,
    nodeId,
    pubkeyUncompressed,
    keyFile: keyPath,
  }
  console.log(`✓ ${role}`)
  console.log(`  address: ${w.address}`)
  console.log(`  nodeId:  ${nodeId}`)
  console.log(`  trail20: 0x${nodeId.slice(-40)}  (must == address[2:].toLowerCase())`)
  console.log(`  match:   ${("0x" + nodeId.slice(-40)).toLowerCase() === w.address.toLowerCase() ? "✓" : "✗ MISMATCH"}`)
  console.log(`  keyfile: ${keyPath} (chmod 600)`)
  console.log()
}

const manifestPath = join(KEY_DIR, "identities-2026-05-09.json")
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
console.log(`manifest: ${manifestPath}`)
