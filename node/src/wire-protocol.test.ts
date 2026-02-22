import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  encodeFrame,
  decodeFrame,
  FrameDecoder,
  encodeJsonPayload,
  decodeJsonPayload,
  MessageType,
  buildWireHandshakeMessage,
  WIRE_MAGIC,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
} from "./wire-protocol.ts"

describe("encodeFrame / decodeFrame", () => {
  it("round-trips a simple frame", () => {
    const payload = new TextEncoder().encode("hello")
    const encoded = encodeFrame({ type: MessageType.Ping, payload })

    assert.equal(encoded.length, HEADER_SIZE + payload.length)

    const result = decodeFrame(encoded)
    assert.ok(result)
    assert.equal(result.frame.type, MessageType.Ping)
    assert.deepEqual(result.frame.payload, payload)
    assert.equal(result.bytesConsumed, encoded.length)
  })

  it("encodes magic bytes correctly", () => {
    const encoded = encodeFrame({ type: MessageType.Pong, payload: new Uint8Array(0) })
    const view = new DataView(encoded.buffer)
    assert.equal(view.getUint16(0, false), WIRE_MAGIC)
  })

  it("encodes type byte correctly", () => {
    const encoded = encodeFrame({ type: MessageType.Block, payload: new Uint8Array(0) })
    assert.equal(encoded[2], MessageType.Block)
  })

  it("encodes length as big-endian uint32", () => {
    const payload = new Uint8Array(300)
    const encoded = encodeFrame({ type: MessageType.Transaction, payload })
    const view = new DataView(encoded.buffer)
    assert.equal(view.getUint32(3, false), 300)
  })

  it("handles empty payload", () => {
    const encoded = encodeFrame({ type: MessageType.Ping, payload: new Uint8Array(0) })
    assert.equal(encoded.length, HEADER_SIZE)

    const result = decodeFrame(encoded)
    assert.ok(result)
    assert.equal(result.frame.payload.length, 0)
  })

  it("returns null for incomplete header", () => {
    const result = decodeFrame(new Uint8Array(3))
    assert.equal(result, null)
  })

  it("returns null for incomplete payload", () => {
    const encoded = encodeFrame({ type: MessageType.Ping, payload: new Uint8Array(100) })
    // Truncate to only have partial payload
    const partial = encoded.slice(0, HEADER_SIZE + 50)
    const result = decodeFrame(partial)
    assert.equal(result, null)
  })

  it("throws on invalid magic", () => {
    const buf = new Uint8Array(HEADER_SIZE)
    const view = new DataView(buf.buffer)
    view.setUint16(0, 0xDEAD, false)
    assert.throws(() => decodeFrame(buf), /invalid wire magic/)
  })

  it("throws on oversized payload", () => {
    const buf = new Uint8Array(HEADER_SIZE)
    const view = new DataView(buf.buffer)
    view.setUint16(0, WIRE_MAGIC, false)
    buf[2] = MessageType.Block
    view.setUint32(3, MAX_PAYLOAD_SIZE + 1, false)
    assert.throws(() => decodeFrame(buf), /payload size exceeds max/)
  })

  it("rejects encoding oversized payload", () => {
    const payload = new Uint8Array(MAX_PAYLOAD_SIZE + 1)
    assert.throws(() => encodeFrame({ type: MessageType.Block, payload }), /payload exceeds max size/)
  })
})

describe("FrameDecoder", () => {
  it("decodes a single complete frame", () => {
    const decoder = new FrameDecoder()
    const encoded = encodeFrame({ type: MessageType.Ping, payload: new TextEncoder().encode("test") })
    const frames = decoder.feed(encoded)

    assert.equal(frames.length, 1)
    assert.equal(frames[0].type, MessageType.Ping)
  })

  it("buffers partial frames across feeds", () => {
    const decoder = new FrameDecoder()
    const encoded = encodeFrame({ type: MessageType.Block, payload: new TextEncoder().encode("block data") })

    // Feed in two parts
    const part1 = encoded.slice(0, 5)
    const part2 = encoded.slice(5)

    const frames1 = decoder.feed(part1)
    assert.equal(frames1.length, 0)
    assert.ok(decoder.bufferedBytes() > 0)

    const frames2 = decoder.feed(part2)
    assert.equal(frames2.length, 1)
    assert.equal(frames2[0].type, MessageType.Block)
  })

  it("decodes multiple frames in single feed", () => {
    const decoder = new FrameDecoder()
    const frame1 = encodeFrame({ type: MessageType.Ping, payload: new Uint8Array(0) })
    const frame2 = encodeFrame({ type: MessageType.Pong, payload: new Uint8Array(0) })

    const combined = new Uint8Array(frame1.length + frame2.length)
    combined.set(frame1, 0)
    combined.set(frame2, frame1.length)

    const frames = decoder.feed(combined)
    assert.equal(frames.length, 2)
    assert.equal(frames[0].type, MessageType.Ping)
    assert.equal(frames[1].type, MessageType.Pong)
  })

  it("handles frame + partial next frame", () => {
    const decoder = new FrameDecoder()
    const frame1 = encodeFrame({ type: MessageType.Ping, payload: new Uint8Array(0) })
    const frame2 = encodeFrame({ type: MessageType.Pong, payload: new TextEncoder().encode("data") })

    // Full frame1 + partial frame2
    const partial = new Uint8Array(frame1.length + 3)
    partial.set(frame1, 0)
    partial.set(frame2.slice(0, 3), frame1.length)

    const frames = decoder.feed(partial)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].type, MessageType.Ping)
    assert.equal(decoder.bufferedBytes(), 3)

    // Feed remaining
    const remaining = decoder.feed(frame2.slice(3))
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].type, MessageType.Pong)
  })

  it("reset clears buffer", () => {
    const decoder = new FrameDecoder()
    decoder.feed(new Uint8Array(5))
    assert.equal(decoder.bufferedBytes(), 5)
    decoder.reset()
    assert.equal(decoder.bufferedBytes(), 0)
  })
})

describe("JSON payload helpers", () => {
  it("builds canonical handshake signing message", () => {
    const msg = buildWireHandshakeMessage("0xabc", 18780, "n-1")
    assert.equal(msg, "wire:handshake:18780:0xabc:n-1")
  })

  it("round-trips a JSON object", () => {
    const obj = { height: 42, hash: "0xabc", peers: ["a", "b"] }
    const encoded = encodeJsonPayload(MessageType.Block, obj)
    const result = decodeFrame(encoded)
    assert.ok(result)
    const decoded = decodeJsonPayload<typeof obj>(result.frame)
    assert.deepEqual(decoded, obj)
  })

  it("handles BigInt serialization", () => {
    const obj = { stake: 1000000000000000000n }
    const encoded = encodeJsonPayload(MessageType.Handshake, obj)
    const result = decodeFrame(encoded)
    assert.ok(result)
    const decoded = decodeJsonPayload<{ stake: string }>(result.frame)
    assert.equal(decoded.stake, "1000000000000000000")
  })

  it("round-trips FindNode payload", () => {
    const payload = { targetId: "0xabcdef", requestId: "req-123" }
    const encoded = encodeJsonPayload(MessageType.FindNode, payload)
    const result = decodeFrame(encoded)
    assert.ok(result)
    assert.equal(result.frame.type, MessageType.FindNode)
    const decoded = decodeJsonPayload<typeof payload>(result.frame)
    assert.equal(decoded.targetId, "0xabcdef")
    assert.equal(decoded.requestId, "req-123")
  })

  it("round-trips FindNodeResponse payload", () => {
    const payload = {
      requestId: "req-456",
      peers: [
        { id: "0x111", address: "10.0.0.1:19781" },
        { id: "0x222", address: "10.0.0.2:19781" },
      ],
    }
    const encoded = encodeJsonPayload(MessageType.FindNodeResponse, payload)
    const result = decodeFrame(encoded)
    assert.ok(result)
    assert.equal(result.frame.type, MessageType.FindNodeResponse)
    const decoded = decodeJsonPayload<typeof payload>(result.frame)
    assert.equal(decoded.peers.length, 2)
    assert.equal(decoded.peers[0].id, "0x111")
  })

  it("preserves all message types", () => {
    const types = [
      MessageType.Handshake,
      MessageType.Block,
      MessageType.Transaction,
      MessageType.BftPrepare,
      MessageType.BftCommit,
      MessageType.FindNode,
      MessageType.FindNodeResponse,
    ]
    for (const type of types) {
      const encoded = encodeJsonPayload(type, { test: true })
      const result = decodeFrame(encoded)
      assert.ok(result)
      assert.equal(result.frame.type, type)
    }
  })
})
