import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { WireServer } from "./wire-server.ts"
import { FrameDecoder, MessageType, encodeJsonPayload, buildWireHandshakeMessage } from "./wire-protocol.ts"
import { createNodeSigner } from "./crypto/signer.ts"

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000)
}

function connectSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port }, () => resolve(s))
    s.on("error", reject)
  })
}

function receiveFrames(socket: net.Socket, decoder: FrameDecoder, minFrames: number, timeoutMs = 2000): Promise<any[]> {
  return new Promise((resolve) => {
    const frames: any[] = []
    const timer = setTimeout(() => resolve(frames), timeoutMs)
    socket.on("data", (data: Buffer) => {
      const decoded = decoder.feed(new Uint8Array(data))
      frames.push(...decoded)
      if (frames.length >= minFrames) {
        clearTimeout(timer)
        resolve(frames)
      }
    })
  })
}

describe("Wire handshake auth", () => {
  let server: WireServer | null = null
  const sockets: net.Socket[] = []

  afterEach(() => {
    for (const s of sockets) { try { s.destroy() } catch {} }
    sockets.length = 0
    if (server) { server.stop(); server = null }
  })

  it("rejects unsigned handshake when verifier is enabled", async () => {
    const port = getRandomPort()
    const serverSigner = createNodeSigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")

    server = new WireServer({
      port,
      nodeId: serverSigner.nodeId,
      chainId: 18780,
      onBlock: async () => {},
      onTx: async () => {},
      getHeight: () => Promise.resolve(0n),
      signer: serverSigner,
      verifier: serverSigner,
    })
    server.start()
    await new Promise((r) => setTimeout(r, 100))

    const socket = await connectSocket("127.0.0.1", port)
    sockets.push(socket)
    const decoder = new FrameDecoder()
    await receiveFrames(socket, decoder, 1)

    let closed = false
    socket.on("close", () => { closed = true })
    socket.write(encodeJsonPayload(MessageType.Handshake, {
      nodeId: "legacy-client",
      chainId: 18780,
      height: "0",
    }))

    await new Promise((r) => setTimeout(r, 300))
    assert.ok(closed)
  })

  it("accepts signed handshake when verifier is enabled", async () => {
    const port = getRandomPort()
    const serverSigner = createNodeSigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    const clientSigner = createNodeSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")

    server = new WireServer({
      port,
      nodeId: serverSigner.nodeId,
      chainId: 18780,
      onBlock: async () => {},
      onTx: async () => {},
      getHeight: () => Promise.resolve(0n),
      signer: serverSigner,
      verifier: serverSigner,
    })
    server.start()
    await new Promise((r) => setTimeout(r, 100))

    const socket = await connectSocket("127.0.0.1", port)
    sockets.push(socket)
    const decoder = new FrameDecoder()
    await receiveFrames(socket, decoder, 1)

    const nonce = "handshake-auth-test"
    const msg = buildWireHandshakeMessage(clientSigner.nodeId, 18780, nonce)
    socket.write(encodeJsonPayload(MessageType.Handshake, {
      nodeId: clientSigner.nodeId,
      chainId: 18780,
      height: "0",
      nonce,
      signature: clientSigner.sign(msg),
    }))

    const frames = await receiveFrames(socket, decoder, 1)
    assert.ok(frames.length >= 1)
  })
})
