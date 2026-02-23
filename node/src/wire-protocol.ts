/**
 * Binary Wire Protocol
 *
 * Framed TCP protocol for peer-to-peer communication.
 * Frame layout: [Magic 2B] [Type 1B] [Length 4B] [Payload NB]
 *
 * Magic: 0xC0C1
 * Type:  message type identifier
 * Length: big-endian uint32 payload size
 * Payload: serialized message bytes
 */

export const WIRE_MAGIC = 0xC0C1
export const HEADER_SIZE = 7 // 2 magic + 1 type + 4 length
export const MAX_PAYLOAD_SIZE = 16 * 1024 * 1024 // 16 MiB

export const MessageType = {
  Handshake: 0x01,
  HandshakeAck: 0x02,
  Block: 0x10,
  Transaction: 0x11,
  BlockRequest: 0x12,
  BlockResponse: 0x13,
  Snapshot: 0x20,
  SnapshotRequest: 0x21,
  BftPrepare: 0x30,
  BftCommit: 0x31,
  FindNode: 0x40,
  FindNodeResponse: 0x41,
  Ping: 0xF0,
  Pong: 0xF1,
} as const

/** Payload for FindNode request */
export interface FindNodePayload {
  targetId: string
  requestId: string
}

/** Payload for FindNode response */
export interface FindNodeResponsePayload {
  requestId: string
  peers: Array<{ id: string; address: string }>
}

export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export interface WireFrame {
  type: MessageType
  payload: Uint8Array
}

/**
 * Canonical message used for wire handshake signatures.
 * Includes chainId to bind signatures to a specific network.
 */
export function buildWireHandshakeMessage(nodeId: string, chainId: number, nonce: string): string {
  return `wire:handshake:${chainId}:${nodeId}:${nonce}`
}

/**
 * Encode a frame into wire format bytes.
 */
export function encodeFrame(frame: WireFrame): Uint8Array {
  const payloadLen = frame.payload.length
  if (payloadLen > MAX_PAYLOAD_SIZE) {
    throw new Error(`payload exceeds max size: ${payloadLen} > ${MAX_PAYLOAD_SIZE}`)
  }

  const buf = new Uint8Array(HEADER_SIZE + payloadLen)
  const view = new DataView(buf.buffer)

  // Magic (2 bytes, big-endian)
  view.setUint16(0, WIRE_MAGIC, false)

  // Type (1 byte)
  buf[2] = frame.type

  // Length (4 bytes, big-endian)
  view.setUint32(3, payloadLen, false)

  // Payload
  buf.set(frame.payload, HEADER_SIZE)

  return buf
}

/**
 * Attempt to decode a frame from a buffer.
 * Returns the frame and bytes consumed, or null if buffer is incomplete.
 */
export function decodeFrame(buf: Uint8Array): { frame: WireFrame; bytesConsumed: number } | null {
  if (buf.length < HEADER_SIZE) {
    return null
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // Check magic
  const magic = view.getUint16(0, false)
  if (magic !== WIRE_MAGIC) {
    throw new Error(`invalid wire magic: 0x${magic.toString(16)}`)
  }

  const type = buf[2] as MessageType
  const payloadLen = view.getUint32(3, false)

  if (payloadLen > MAX_PAYLOAD_SIZE) {
    throw new Error(`payload size exceeds max: ${payloadLen}`)
  }

  const totalLen = HEADER_SIZE + payloadLen
  if (buf.length < totalLen) {
    return null // incomplete
  }

  const payload = buf.slice(HEADER_SIZE, totalLen)
  return {
    frame: { type, payload },
    bytesConsumed: totalLen,
  }
}

/**
 * Frame accumulator for streaming TCP data.
 * Buffers incoming bytes and yields complete frames.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0)
  private used = 0
  private readonly maxBufferSize: number

  constructor(maxBufferSize = 32 * 1024 * 1024) { // 32 MB default
    this.maxBufferSize = maxBufferSize
  }

  /**
   * Feed incoming bytes and return any complete frames.
   * Throws if buffer exceeds maxBufferSize (incomplete frame attack protection).
   * Uses exponential growth (2x) to amortize allocation cost to O(n) total.
   */
  feed(data: Uint8Array): WireFrame[] {
    const needed = this.used + data.length
    if (needed > this.maxBufferSize) {
      this.buffer = new Uint8Array(0)
      this.used = 0
      throw new Error(`FrameDecoder buffer overflow: ${needed} > ${this.maxBufferSize}`)
    }

    // Grow buffer with exponential strategy (2x) to avoid O(n²) copies
    if (needed > this.buffer.length) {
      const newCap = Math.min(Math.max(needed, this.buffer.length * 2, 4096), this.maxBufferSize)
      const grown = new Uint8Array(newCap)
      grown.set(this.buffer.subarray(0, this.used), 0)
      this.buffer = grown
    }
    this.buffer.set(data, this.used)
    this.used += data.length

    const frames: WireFrame[] = []
    let offset = 0

    while (offset + HEADER_SIZE <= this.used) {
      const result = decodeFrame(this.buffer.subarray(offset, this.used))
      if (!result) break

      frames.push(result.frame)
      offset += result.bytesConsumed
    }

    // Compact: shift unconsumed bytes to front
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.used)
      this.used -= offset
    }

    return frames
  }

  /**
   * Get remaining buffered bytes count.
   */
  bufferedBytes(): number {
    return this.used
  }

  /**
   * Reset the decoder state.
   */
  reset(): void {
    this.buffer = new Uint8Array(0)
    this.used = 0
  }
}

/**
 * Encode a JSON-serializable object into a wire frame payload.
 */
export function encodeJsonPayload(type: MessageType, obj: unknown): Uint8Array {
  const json = JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  )
  const payload = new TextEncoder().encode(json)
  return encodeFrame({ type, payload })
}

/**
 * Decode a wire frame payload as JSON.
 */
export function decodeJsonPayload<T>(frame: WireFrame): T {
  const json = new TextDecoder().decode(frame.payload)
  try {
    return JSON.parse(json) as T
  } catch (err) {
    throw new Error(`invalid JSON in wire frame (type=0x${frame.type.toString(16)}): ${String(err)}`)
  }
}
