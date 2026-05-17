import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { WireServer } from "./wire-server.ts"
import { WireClient } from "./wire-client.ts"
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

    const nonce = `${Date.now()}:handshake-auth-test`
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

  it("wire-client rejects a replayed server handshake nonce", async () => {
    // Security regression: wire-server dedups handshake nonces; wire-client
    // did not. A captured server handshake stays valid for the 5-min
    // freshness window, so without client-side per-nonce dedup it could be
    // replayed to impersonate that server. A fake peer here replays one
    // fixed signed handshake to every connection — the first client must
    // accept it, every later client must reject the reused nonce.
    const port = getRandomPort()
    const serverSigner = createNodeSigner("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    const clientSigner = createNodeSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")

    const FIXED_NONCE = `${Date.now()}:wire-client-replay-regression`
    const hsMsg = buildWireHandshakeMessage(serverSigner.nodeId, 18780, FIXED_NONCE)
    const handshakeFrame = encodeJsonPayload(MessageType.Handshake, {
      nodeId: serverSigner.nodeId,
      chainId: 18780,
      height: "0",
      nonce: FIXED_NONCE,
      signature: serverSigner.sign(hsMsg),
    })
    // Fake peer: replays the identical signed handshake to every connection.
    const fake = net.createServer((s) => {
      s.on("data", () => {})
      s.on("error", () => {})
      s.write(handshakeFrame)
    })
    await new Promise<void>((r) => fake.listen(port, "127.0.0.1", () => r()))

    const mkClient = (onConnected: () => void) => new WireClient({
      host: "127.0.0.1",
      port,
      nodeId: clientSigner.nodeId,
      chainId: 18780,
      signer: clientSigner,
      verifier: clientSigner,
      onConnected,
    })

    let firstConnected = false
    const client1 = mkClient(() => { firstConnected = true })
    client1.connect()
    await new Promise((r) => setTimeout(r, 500))

    let secondConnected = false
    const client2 = mkClient(() => { secondConnected = true })
    client2.connect()
    await new Promise((r) => setTimeout(r, 500))

    client1.disconnect()
    client2.disconnect()
    await new Promise<void>((r) => fake.close(() => r()))

    assert.ok(firstConnected, "first client accepts a fresh-nonce server handshake")
    assert.ok(!secondConnected, "second client must reject the replayed handshake nonce")
  })
})
