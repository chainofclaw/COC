import test from "node:test";
import assert from "node:assert/strict";
import { validatePoseWitnessPayload } from "./pose-witness-validator.ts";

const VALID = {
  challengeId: "0x" + "a".repeat(64),
  nodeId: "0xde4e7889aa9007318ff261b1ee675f1305153590",
  responseBodyHash: "0x" + "b".repeat(64),
  witnessIndex: 0,
};

test("#322: well-formed payload passes and normalizes hex to lowercase", () => {
  const r = validatePoseWitnessPayload({
    ...VALID,
    nodeId: VALID.nodeId.toUpperCase(),
    responseBodyHash: VALID.responseBodyHash.toUpperCase(),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    // Hex normalized to lowercase
    assert.equal(r.fields.nodeId, VALID.nodeId.toLowerCase());
    assert.equal(r.fields.responseBodyHash, VALID.responseBodyHash.toLowerCase());
  }
});

test("#322: non-object payload rejected (no V8 leak)", () => {
  for (const bad of [null, undefined, "string", 42, true, []]) {
    const r = validatePoseWitnessPayload(bad);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.doesNotMatch(r.error, /TypeError|SyntaxError|undefined is not/, "no V8 leak");
    }
  }
});

test("#322: challengeId must be 32-byte hex", () => {
  // non-string types — was accepted pre-fix via falsy check
  for (const bad of [{ x: 1 }, [1, 2], 42, true, null, undefined, "",
                     "0xshort", "0x" + "a".repeat(63), "0x" + "a".repeat(65),
                     "AAA-attacker-controlled-AAA"]) {
    const r = validatePoseWitnessPayload({ ...VALID, challengeId: bad });
    assert.equal(r.ok, false, `challengeId=${JSON.stringify(bad)} must reject`);
    if (!r.ok) assert.match(r.error, /challengeId/);
  }
});

test("#322: nodeId must be 20-byte hex address", () => {
  for (const bad of [{}, [], 42, true, "0xnothex", "0x" + "a".repeat(39), "0x" + "a".repeat(41)]) {
    const r = validatePoseWitnessPayload({ ...VALID, nodeId: bad });
    assert.equal(r.ok, false, `nodeId=${JSON.stringify(bad)} must reject`);
    if (!r.ok) assert.match(r.error, /nodeId/);
  }
});

test("#322: responseBodyHash must be 32-byte hex", () => {
  for (const bad of [{}, [], 42, true, "0xshort", "0x" + "a".repeat(63), "0x" + "a".repeat(65)]) {
    const r = validatePoseWitnessPayload({ ...VALID, responseBodyHash: bad });
    assert.equal(r.ok, false, `responseBodyHash=${JSON.stringify(bad)} must reject`);
    if (!r.ok) assert.match(r.error, /responseBodyHash/);
  }
});

test("#322: witnessIndex must be non-negative integer", () => {
  // pre-fix the only check was `=== undefined`, accepting any defined value
  for (const bad of ["abc", null, [1], -1, 1.5, NaN, Infinity, true]) {
    const r = validatePoseWitnessPayload({ ...VALID, witnessIndex: bad });
    assert.equal(r.ok, false, `witnessIndex=${JSON.stringify(bad)} must reject`);
    if (!r.ok) assert.match(r.error, /witnessIndex/);
  }
  // Boundary: zero accepted
  const zero = validatePoseWitnessPayload({ ...VALID, witnessIndex: 0 });
  assert.equal(zero.ok, true);
  // Large valid integer accepted
  const big = validatePoseWitnessPayload({ ...VALID, witnessIndex: 1_000_000 });
  assert.equal(big.ok, true);
});

test("#322: KEY invariant — error message must NOT echo client input", () => {
  // Same family as #314/#316/#318: error messages must be deterministic
  // and not echo client-controlled bytes, so an attacker cannot use
  // 400 responses as a reflection oracle.
  const r = validatePoseWitnessPayload({
    ...VALID,
    challengeId: "AAA-attacker-controlled-AAA",
  });
  // pre-fix would have hit ethers internals and leaked the value; the
  // fix returns a generic error without echoing.
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(!r.error.includes("AAA"), `error must not echo input, got: ${r.error}`);
  }
});
