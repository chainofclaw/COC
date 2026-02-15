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
  recentMessages: PubsubMessage[] // Ring buffer for recent messages
}

export interface PubsubConfig {
  nodeId: string
  maxTopics: number
  maxMessageSize: number
  messageRetentionMs: number
  maxRecentMessages: number
}

const DEFAULT_CONFIG: PubsubConfig = {
  nodeId: "coc-node",
  maxTopics: 100,
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
      state = { handlers: new Set(), recentMessages: [] }
      this.topics.set(topic, state)
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
    const msgId = `${msg.from}:${msg.seqno}`

    // Deduplicate
    if (this.seenMessages.has(msgId)) {
      return false
    }
    this.seenMessages.add(msgId)

    // Enforce message size limit on peer messages
    if (msg.data && msg.data.byteLength > this.cfg.maxMessageSize) {
      log.warn("oversized peer message rejected", { topic, size: msg.data.byteLength })
      return false
    }

    msg.receivedAt = Date.now()
    this.deliverToSubscribers(topic, msg)
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
   * Get recent messages for a topic.
   */
  getRecentMessages(topic: string): PubsubMessage[] {
    return this.topics.get(topic)?.recentMessages ?? []
  }

  private deliverToSubscribers(topic: string, msg: PubsubMessage): void {
    const state = this.topics.get(topic)
    if (!state) return

    // Store in recent messages
    state.recentMessages.push(msg)
    if (state.recentMessages.length > this.cfg.maxRecentMessages) {
      state.recentMessages.shift()
    }

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
      state.recentMessages = state.recentMessages.filter(
        (msg) => msg.receivedAt > cutoff
      )
    }

    // BoundedSet handles FIFO eviction automatically — no manual clear needed
  }
}
