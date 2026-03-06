import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stableStringifyForHash } from "./reward-manifest.ts";

describe("reward-manifest", () => {
  it("serializes bigint values without throwing", () => {
    const encoded = stableStringifyForHash([{ nodeId: "0x1", storageGb: 1n }]);
    assert.equal(encoded, `[{"nodeId":"0x1","storageGb":1}]`);
  });

  it("sorts object keys for deterministic hashing", () => {
    const a = stableStringifyForHash({ b: 2, a: 1, nested: { y: 2, x: 1 } });
    const b = stableStringifyForHash({ nested: { x: 1, y: 2 }, a: 1, b: 2 });
    assert.equal(a, b);
  });
});
