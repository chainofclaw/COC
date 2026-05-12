import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "./state.ts";
import { MAX_CHALLENGES_DEFAULT, recordChallengeBounded } from "./bounded-challenge-store.ts";

test("#320: bounded store inserts up to maxEntries without eviction", () => {
  const s = new InMemoryStore<{ n: number }>();
  for (let i = 0; i < 5; i++) {
    recordChallengeBounded(s, `id-${i}`, { n: i }, 5);
  }
  assert.equal(s.keys().length, 5);
  // All entries readable
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(s.get(`id-${i}`), { n: i });
  }
});

test("#320: store stays at maxEntries — FIFO evicts oldest", () => {
  const s = new InMemoryStore<{ n: number }>();
  const CAP = 3;
  recordChallengeBounded(s, "a", { n: 1 }, CAP);
  recordChallengeBounded(s, "b", { n: 2 }, CAP);
  recordChallengeBounded(s, "c", { n: 3 }, CAP);
  assert.equal(s.keys().length, 3);

  // Insert a 4th — should evict "a" (oldest)
  recordChallengeBounded(s, "d", { n: 4 }, CAP);
  assert.equal(s.keys().length, 3, "size must stay at cap");
  assert.equal(s.get("a"), undefined, "oldest entry must be evicted");
  assert.deepEqual(s.get("b"), { n: 2 });
  assert.deepEqual(s.get("c"), { n: 3 });
  assert.deepEqual(s.get("d"), { n: 4 });

  // Continue spam — every subsequent insert evicts the next oldest
  recordChallengeBounded(s, "e", { n: 5 }, CAP);
  assert.equal(s.keys().length, 3);
  assert.equal(s.get("b"), undefined, "next oldest must be evicted");
  assert.deepEqual(s.get("e"), { n: 5 });
});

test("#320: re-inserting an existing key does NOT trigger eviction", () => {
  // KEY invariant: if an attacker re-uses the same id, we must NOT
  // evict another legitimate entry — that would be the cap making
  // things WORSE than no cap.
  const s = new InMemoryStore<{ n: number }>();
  const CAP = 3;
  recordChallengeBounded(s, "a", { n: 1 }, CAP);
  recordChallengeBounded(s, "b", { n: 2 }, CAP);
  recordChallengeBounded(s, "c", { n: 3 }, CAP);

  // Update "a" — should not evict, should not change size
  recordChallengeBounded(s, "a", { n: 99 }, CAP);
  assert.equal(s.keys().length, 3, "re-insert must not change size");
  assert.deepEqual(s.get("a"), { n: 99 }, "value must be updated");
  assert.deepEqual(s.get("b"), { n: 2 }, "b must still be present");
  assert.deepEqual(s.get("c"), { n: 3 }, "c must still be present");
});

test("#320: cap = 1 still functions (degenerate but valid)", () => {
  const s = new InMemoryStore<number>();
  recordChallengeBounded(s, "x", 1, 1);
  assert.equal(s.keys().length, 1);
  recordChallengeBounded(s, "y", 2, 1);
  assert.equal(s.keys().length, 1);
  assert.equal(s.get("x"), undefined);
  assert.equal(s.get("y"), 2);
});

test("#320: invalid maxEntries rejected", () => {
  const s = new InMemoryStore<number>();
  assert.throws(() => recordChallengeBounded(s, "x", 1, 0), /maxEntries/);
  assert.throws(() => recordChallengeBounded(s, "x", 1, -1), /maxEntries/);
});

test("#320: default cap matches MAX_CHALLENGES_DEFAULT", () => {
  // Sanity — the default must match what coc-node uses, otherwise the
  // unit test wouldn't reflect production behaviour.
  assert.equal(MAX_CHALLENGES_DEFAULT, 100_000);
});
