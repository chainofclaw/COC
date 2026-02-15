/**
 * IPFS Pubsub tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { IpfsPubsub } from "./ipfs-pubsub.ts"

test("IpfsPubsub: subscribe and publish", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  const received: Uint8Array[] = []
  pubsub.subscribe("test-topic", (msg) => {
    received.push(msg.data)
  })

  await pubsub.publish("test-topic", new TextEncoder().encode("hello"))

  assert.strictEqual(received.length, 1)
  assert.strictEqual(new TextDecoder().decode(received[0]), "hello")

  pubsub.stop()
})

test("IpfsPubsub: multiple subscribers", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  let count = 0
  pubsub.subscribe("topic", () => count++)
  pubsub.subscribe("topic", () => count++)

  await pubsub.publish("topic", new Uint8Array([1]))

  assert.strictEqual(count, 2)
  pubsub.stop()
})

test("IpfsPubsub: unsubscribe handler", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  let count = 0
  const handler = () => count++
  pubsub.subscribe("topic", handler)

  await pubsub.publish("topic", new Uint8Array([1]))
  assert.strictEqual(count, 1)

  pubsub.unsubscribe("topic", handler)
  await pubsub.publish("topic", new Uint8Array([2]))
  assert.strictEqual(count, 1) // Should not increase

  pubsub.stop()
})

test("IpfsPubsub: unsubscribe all from topic", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  pubsub.subscribe("topic", () => {})
  pubsub.subscribe("topic", () => {})

  assert.strictEqual(pubsub.getSubscribers("topic"), 2)

  pubsub.unsubscribe("topic")
  assert.strictEqual(pubsub.getSubscribers("topic"), 0)

  pubsub.stop()
})

test("IpfsPubsub: getTopics lists subscribed topics", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  pubsub.subscribe("topic-a", () => {})
  pubsub.subscribe("topic-b", () => {})

  const topics = pubsub.getTopics()
  assert.strictEqual(topics.length, 2)
  assert.ok(topics.includes("topic-a"))
  assert.ok(topics.includes("topic-b"))

  pubsub.stop()
})

test("IpfsPubsub: message not delivered to wrong topic", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  let received = false
  pubsub.subscribe("topic-a", () => { received = true })

  await pubsub.publish("topic-b", new Uint8Array([1]))

  assert.strictEqual(received, false)
  pubsub.stop()
})

test("IpfsPubsub: receiveFromPeer deduplicates messages", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  let count = 0
  pubsub.subscribe("topic", () => count++)

  const msg = {
    from: "remote-node",
    seqno: "abc123",
    data: new Uint8Array([1]),
    topicIDs: ["topic"],
    receivedAt: Date.now(),
  }

  const first = pubsub.receiveFromPeer("topic", msg)
  const second = pubsub.receiveFromPeer("topic", msg)

  assert.strictEqual(first, true)
  assert.strictEqual(second, false)
  assert.strictEqual(count, 1) // Only delivered once

  pubsub.stop()
})

test("IpfsPubsub: getRecentMessages returns history", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  pubsub.subscribe("topic", () => {})
  await pubsub.publish("topic", new TextEncoder().encode("msg1"))
  await pubsub.publish("topic", new TextEncoder().encode("msg2"))

  const recent = pubsub.getRecentMessages("topic")
  assert.strictEqual(recent.length, 2)

  pubsub.stop()
})

test("IpfsPubsub: max topics limit", () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node", maxTopics: 2 })

  pubsub.subscribe("topic-1", () => {})
  pubsub.subscribe("topic-2", () => {})

  assert.throws(() => {
    pubsub.subscribe("topic-3", () => {})
  }, /max topics/)

  pubsub.stop()
})

test("IpfsPubsub: rejects oversized messages", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node", maxMessageSize: 10 })

  await assert.rejects(
    () => pubsub.publish("topic", new Uint8Array(20)),
    /message too large/,
  )

  pubsub.stop()
})

test("IpfsPubsub: message contains correct metadata", async () => {
  const pubsub = new IpfsPubsub({ nodeId: "my-node" })

  let receivedMsg: any = null
  pubsub.subscribe("topic", (msg) => { receivedMsg = msg })

  await pubsub.publish("topic", new Uint8Array([42]))

  assert.ok(receivedMsg)
  assert.strictEqual(receivedMsg.from, "my-node")
  assert.ok(receivedMsg.seqno)
  assert.deepStrictEqual(receivedMsg.topicIDs, ["topic"])
  assert.ok(receivedMsg.receivedAt > 0)

  pubsub.stop()
})

test("IpfsPubsub: stop clears all state", () => {
  const pubsub = new IpfsPubsub({ nodeId: "test-node" })

  pubsub.subscribe("topic", () => {})
  pubsub.start()
  pubsub.stop()

  assert.strictEqual(pubsub.getTopics().length, 0)
})
