// AES-256-GCM encryption/decryption for sensitive backup files
// Key derivation: scrypt KDF from Ethereum private key (never use raw privkey)

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const SALT_LENGTH = 32
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1

/** Derive a 256-bit encryption key from an Ethereum private key via scrypt */
export function deriveEncryptionKey(privateKeyHex: string, salt: Uint8Array): Buffer {
  // Hash the private key first to avoid using it directly
  const seed = createHash("sha256").update(privateKeyHex).digest()
  return scryptSync(seed, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer
}

/** Derive a 256-bit encryption key from a password via scrypt */
export function deriveKeyFromPassword(password: string, salt: Uint8Array): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }) as Buffer
}

/**
 * Encrypt data with AES-256-GCM.
 * Output format: [salt(32)] [iv(12)] [tag(16)] [ciphertext]
 */
export function encrypt(plaintext: Uint8Array, privateKeyOrPassword: string, isPassword = false): Uint8Array {
  const salt = randomBytes(SALT_LENGTH)
  const key = isPassword
    ? deriveKeyFromPassword(privateKeyOrPassword, salt)
    : deriveEncryptionKey(privateKeyOrPassword, salt)
  const iv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // [salt(32)] [iv(12)] [tag(16)] [ciphertext]
  return Buffer.concat([salt, iv, tag, encrypted])
}

/**
 * Decrypt data encrypted with AES-256-GCM.
 * Input format: [salt(32)] [iv(12)] [tag(16)] [ciphertext]
 */
export function decrypt(data: Uint8Array, privateKeyOrPassword: string, isPassword = false): Uint8Array {
  if (data.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted data too short")
  }

  const salt = data.slice(0, SALT_LENGTH)
  const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = data.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const ciphertext = data.slice(SALT_LENGTH + IV_LENGTH + TAG_LENGTH)

  const key = isPassword
    ? deriveKeyFromPassword(privateKeyOrPassword, salt)
    : deriveEncryptionKey(privateKeyOrPassword, salt)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Compute SHA-256 hash of data as hex string */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}
