// EIP-712 signer/verifier for COC PoSe v2.
// Wraps ethers v6 signTypedData / verifyTypedData.

import { Wallet, verifyTypedData } from "ethers"
import type { Eip712Domain } from "./eip712-types.ts"
import { toEthersDomain } from "./eip712-types.ts"

export interface Eip712TypeField {
  name: string
  type: string
}

export type Eip712Types = Record<string, readonly Eip712TypeField[]>

export interface Eip712Signer {
  signTypedData(types: Eip712Types, value: Record<string, unknown>): Promise<string>
  verifyTypedData(types: Eip712Types, value: Record<string, unknown>, sig: string, expectedAddr: string): boolean
  recoverTypedData(types: Eip712Types, value: Record<string, unknown>, sig: string): string
}

export function createEip712Signer(wallet: Wallet, domain: Eip712Domain): Eip712Signer {
  const ethersDomain = toEthersDomain(domain)

  return {
    async signTypedData(types: Eip712Types, value: Record<string, unknown>): Promise<string> {
      return wallet.signTypedData(ethersDomain, types as Record<string, Array<{ name: string; type: string }>>, value)
    },

    verifyTypedData(types: Eip712Types, value: Record<string, unknown>, sig: string, expectedAddr: string): boolean {
      try {
        const recovered = verifyTypedData(
          ethersDomain,
          types as Record<string, Array<{ name: string; type: string }>>,
          value,
          sig,
        )
        return recovered.toLowerCase() === expectedAddr.toLowerCase()
      } catch {
        return false
      }
    },

    recoverTypedData(types: Eip712Types, value: Record<string, unknown>, sig: string): string {
      return verifyTypedData(
        ethersDomain,
        types as Record<string, Array<{ name: string; type: string }>>,
        value,
        sig,
      ).toLowerCase()
    },
  }
}
