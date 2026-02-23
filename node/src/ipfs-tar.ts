/**
 * Lightweight POSIX tar archive builder for IPFS /api/v0/get compatibility.
 *
 * Produces a valid tar archive with 512-byte aligned entries and
 * a 1024-byte end-of-archive marker.
 */

const BLOCK_SIZE = 512
const EOF_BLOCKS = 2 // 1024 bytes of zeros to terminate

export interface TarEntry {
  name: string
  data: Uint8Array
}

/**
 * Create a single tar entry (header + data + padding).
 */
export function createTarEntry(entry: TarEntry): Uint8Array {
  if (/^\/|[\\]|\.\./.test(entry.name) || entry.name.includes("\0")) {
    throw new Error(`unsafe tar entry name: ${entry.name}`)
  }
  const header = buildHeader(entry.name, entry.data.length)
  const dataBlocks = Math.ceil(entry.data.length / BLOCK_SIZE)
  const paddedSize = dataBlocks * BLOCK_SIZE
  const result = new Uint8Array(BLOCK_SIZE + paddedSize)
  result.set(header, 0)
  result.set(entry.data, BLOCK_SIZE)
  return result
}

/**
 * Create a tar archive from multiple entries.
 */
export function createTarArchive(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  let totalSize = 0

  for (const entry of entries) {
    const block = createTarEntry(entry)
    parts.push(block)
    totalSize += block.length
  }

  // End-of-archive: two 512-byte blocks of zeros
  const eof = new Uint8Array(EOF_BLOCKS * BLOCK_SIZE)
  parts.push(eof)
  totalSize += eof.length

  const archive = new Uint8Array(totalSize)
  let offset = 0
  for (const part of parts) {
    archive.set(part, offset)
    offset += part.length
  }
  return archive
}

function buildHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE)

  // name (0-99, 100 bytes)
  writeString(header, 0, name, 100)

  // mode (100-107, 8 bytes) - regular file 0644
  writeOctal(header, 100, 0o644, 8)

  // uid (108-115, 8 bytes)
  writeOctal(header, 108, 0, 8)

  // gid (116-123, 8 bytes)
  writeOctal(header, 116, 0, 8)

  // size (124-135, 12 bytes)
  writeOctal(header, 124, size, 12)

  // mtime (136-147, 12 bytes) - current time
  writeOctal(header, 136, Math.floor(Date.now() / 1000), 12)

  // checksum placeholder (148-155, 8 bytes) - spaces for calculation
  for (let i = 148; i < 156; i++) header[i] = 0x20

  // typeflag (156, 1 byte) - '0' = regular file
  header[156] = 0x30

  // USTAR magic (257-262)
  writeString(header, 257, "ustar", 6)
  // version (263-264)
  header[263] = 0x30 // '0'
  header[264] = 0x30 // '0'

  // Compute and write checksum
  let checksum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header[i]
  }
  writeOctal(header, 148, checksum, 7)
  header[155] = 0x20 // trailing space

  return header
}

function writeString(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
  const len = Math.min(str.length, maxLen - 1)
  for (let i = 0; i < len; i++) {
    buf[offset + i] = str.charCodeAt(i)
  }
}

function writeOctal(buf: Uint8Array, offset: number, value: number, fieldLen: number): void {
  const maxDigits = fieldLen - 1
  const str = value.toString(8).padStart(maxDigits, "0")
  if (str.length > maxDigits) {
    throw new Error(`tar octal field overflow: value ${value} needs ${str.length} digits, max ${maxDigits}`)
  }
  const len = Math.min(str.length, maxDigits)
  for (let i = 0; i < len; i++) {
    buf[offset + i] = str.charCodeAt(i)
  }
  buf[offset + len] = 0 // null terminator
}
