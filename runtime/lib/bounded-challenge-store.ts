/**
 * #320: bounded in-memory store for coc-node's pose challenges.
 *
 * coc-node has no runtime-layer rate limiter. Pre-fix the Map held by
 * `coc-node.ts` had no size cap, no TTL, and no LRU, so an attacker
 * could spam unique challengeIds and grow the Map until the process
 * OOMed. This module wraps the existing InMemoryStore with FIFO
 * eviction once the cap is hit. Eviction order is Map insertion order
 * (V8 guarantees this), so the oldest entry leaves first.
 */

import type { InMemoryStore } from "./state.ts";

export const MAX_CHALLENGES_DEFAULT = 100_000;

export function recordChallengeBounded<T>(
  store: InMemoryStore<T>,
  id: string,
  value: T,
  maxEntries: number = MAX_CHALLENGES_DEFAULT,
): void {
  if (maxEntries <= 0) {
    throw new Error(`maxEntries must be > 0, got ${maxEntries}`);
  }
  // If id is already in the store, set() replaces in-place and there's
  // no growth to bound — skip the eviction branch entirely.
  if (store.get(id) === undefined) {
    const keys = store.keys();
    if (keys.length >= maxEntries) {
      // V8 Map keys() returns insertion order; the first key is the
      // oldest. Evict it before inserting the new entry so the post-
      // state has exactly maxEntries.
      const oldest = keys[0];
      if (oldest !== undefined) store.delete(oldest);
    }
  }
  store.set(id, value);
}
