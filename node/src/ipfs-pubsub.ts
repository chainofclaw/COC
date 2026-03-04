/**
 * IPFS Pubsub
 *
 * Topic-based publish/subscribe messaging system.
 * Messages are broadcast to all subscribers of a topic
 * and forwarded to P2P peers.
 */

import { randomBytes } from "node:crypto"
import { BoundedSet } from "./p2p.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("ipfs-pubsub")

export interface PubsubMessage {
  from: string
  seqno: string
  data: Uint8Array
  topicIDs: string[]
  receivedAt: number
}

export type MessageHandler = (msg: PubsubMessage) => void

interface TopicState {
  handlers: Set<MessageHandler>
  recentMessages: PubsubMessage[]
  ringHead: number // Ring buffer write index for O(1) push
  ringCount: number // Actual message count in ring buffer
}

export interface PubsubConfig {
  nodeId: string
  maxTopics: number
  maxSubscribersPerTopic: number
  maxMessageSize: number
  messageRetentionMs: number
  maxRecentMessages: number
}

const DEFAULT_CONFIG: PubsubConfig = {
  nodeId: "coc-node",
  maxTopics: 100,
  maxSubscribersPerTopic: 50,
  maxMessageSize: 1024 * 1024, // 1 MB
  messageRetentionMs: 5 * 60 * 1000, // 5 minutes
  maxRecentMessages: 1000,
}

export interface PeerForwarder {
  forwardPubsubMessage(topic: string, msg: PubsubMessage): Promise<void>
}

export class IpfsPubsub {
  private readonly cfg: PubsubConfig
  private readonly topics = new Map<string, TopicState>()
  private readonly seenMessages = new BoundedSet<string>(50_000)
  private peerForwarder: PeerForwarder | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<PubsubConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Set the peer forwarder for cross-node message delivery.
   */
  setPeerForwarder(forwarder: PeerForwarder): void {
    this.peerForwarder = forwarder
  }

  /**
   * Start periodic cleanup of expired messages.
   */
  start(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, 60_000)
    this.cleanupTimer.unref()
  }

  /**
   * Stop pubsub and clean up resources.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.topics.clear()
  }

  /**
   * Subscribe to a topic with a message handler.
   */
  subscribe(topic: string, handler: MessageHandler): void {
    let state = this.topics.get(topic)
    if (!state) {
      if (this.topics.size >= this.cfg.maxTopics) {
        throw new Error(`max topics reached: ${this.cfg.maxTopics}`)
      }
      state = { handlers: new Set(), recentMessages: new Array(this.cfg.maxRecentMessages), ringHead: 0, ringCount: 0 }
      this.topics.set(topic, state)
    }
    if (state.handlers.size >= this.cfg.maxSubscribersPerTopic) {
      throw new Error(`max subscribers per topic reached: ${this.cfg.maxSubscribersPerTopic}`)
    }
    state.handlers.add(handler)
    log.info("subscribed to topic", { topic, subscribers: state.handlers.size })
  }

  /**
   * Unsubscribe a handler from a topic.
   */
  unsubscribe(topic: string, handler?: MessageHandler): void {
    const state = this.topics.get(topic)
    if (!state) return

    if (handler) {
      state.handlers.delete(handler)
    } else {
      state.handlers.clear()
    }

    // Clean up empty topics
    if (state.handlers.size === 0) {
      this.topics.delete(topic)
    }
  }

  /**
   * Publish a message to a topic.
   */
  async publish(topic: string, data: Uint8Array): Promise<void> {
    if (data.length > this.cfg.maxMessageSize) {
      throw new Error(`message too large: ${data.length} > ${this.cfg.maxMessageSize}`)
    }

    const msg: PubsubMessage = {
      from: this.cfg.nodeId,
      seqno: randomBytes(8).toString("hex"),
      data,
      topicIDs: [topic],
      receivedAt: Date.now(),
    }

    const msgId = `${msg.from}:${msg.seqno}`
    this.seenMessages.add(msgId)

    // Deliver to local subscribers
    this.deliverToSubscribers(topic, msg)

    // Forward to P2P peers
    if (this.peerForwarder) {
      try {
        await this.peerForwarder.forwardPubsubMessage(topic, msg)
      } catch (err) {
        log.error("peer forwarding failed", { topic, error: String(err) })
      }
    }
  }

  /**
   * Receive a message from a remote peer.
   * Returns true if the message was new and delivered.
   */
  receiveFromPeer(topic: string, msg: PubsubMessage): boolean {
    // Validate message identity fields to prevent dedup key injection
    if (!msg.from || typeof msg.from !== "string" || msg.from.length > 256) return false
    if (!msg.seqno || typeof msg.seqno !== "string" || msg.seqno.length > 64) return false
    if (!topic || typeof topic !== "string" || topic.length > 512) return false

    const msgId = `${msg.from}:${msg.seqno}`

    // Validate msg.data: must be present and Uint8Array (reject null, undefined, or wrong types)
    if (!msg.data || !(msg.data instanceof Uint8Array)) return false

    // Enforce message size limit BEFORE dedup to avoid polluting seenMessages
    if (msg.data && msg.data.byteLength > this.cfg.maxMessageSize) {
      log.warn("oversized peer message rejected", { topic, size: msg.data.byteLength })
      return false
    }

    // Deduplicate
    if (this.seenMessages.has(msgId)) {
      return false
    }
    this.seenMessages.add(msgId)

    const delivered: PubsubMessage = { ...msg, receivedAt: Date.now() }
    this.deliverToSubscribers(topic, delivered)
    return true
  }

  /**
   * Get list of subscribed topics.
   */
  getTopics(): string[] {
    return [...this.topics.keys()]
  }

  /**
   * Get subscribers count for a topic.
   */
  getSubscribers(topic: string): number {
    return this.topics.get(topic)?.handlers.size ?? 0
  }

  /**
   * Get recent messages for a topic (returns ordered snapshot from ring buffer).
   */
  getRecentMessages(topic: string): PubsubMessage[] {
    const state = this.topics.get(topic)
    if (!state || state.ringCount === 0) return []
    const max = this.cfg.maxRecentMessages
    const result: PubsubMessage[] = []
    // Read from oldest to newest in ring buffer order
    const start = state.ringCount < max ? 0 : state.ringHead
    for (let i = 0; i < state.ringCount; i++) {
      const idx = (start + i) % max
      if (state.recentMessages[idx]) result.push(state.recentMessages[idx])
    }
    return result
  }

  private deliverToSubscribers(topic: string, msg: PubsubMessage): void {
    const state = this.topics.get(topic)
    if (!state) return

    // Store in ring buffer — O(1) instead of O(n) shift()
    const max = this.cfg.maxRecentMessages
    state.recentMessages[state.ringHead] = msg
    state.ringHead = (state.ringHead + 1) % max
    if (state.ringCount < max) state.ringCount++

    // Deliver to all handlers
    for (const handler of state.handlers) {
      try {
        handler(msg)
      } catch (err) {
        log.error("handler error", { topic, error: String(err) })
      }
    }
  }

  private cleanup(): void {
    const now = Date.now()
    const cutoff = now - this.cfg.messageRetentionMs

    for (const [, state] of this.topics) {
      // Null out expired messages in ring buffer (don't reallocate)
      const max = this.cfg.maxRecentMessages
      let remaining = 0
      for (let i = 0; i < max; i++) {
        const msg = state.recentMessages[i]
        if (msg && msg.receivedAt <= cutoff) {
          state.recentMessages[i] = undefined as unknown as PubsubMessage
        } else if (msg) {
          remaining++
        }
      }
      // Recount: subtraction was inaccurate because ringCount could drift
      // when messages at non-contiguous positions were expired.
      state.ringCount = remaining
    }

    // BoundedSet handles FIFO eviction automatically — no manual clear needed
  }
}
