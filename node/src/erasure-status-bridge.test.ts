import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * #358 regression: `index.ts`'s `getErasureStatus` closure dynamically
 * imported `ErasureError` from `./ipfs-erasure-reader.ts`, but that
 * module only *imports* the class (from `./ipfs-erasure.ts`) without
 * re-exporting it. The destructured `ErasureError` resolved to
 * `undefined` at runtime, and the subsequent `err instanceof
 * ErasureError` check threw V8 TypeError
 * "Right-hand side of 'instanceof' is not an object" — caught by the
 * outer RPC layer and surfaced as `-32603 internal error` with the
 * V8 message leaked through.
 *
 * Live testnet 88780 reproduction (pre-fix):
 *   curl -d '{"jsonrpc":"2.0","id":1,"method":"coc_erasureStatus",
 *            "params":["not-a-cid"]}' http://node:28780
 *   → {"error":{"code":-32603,"message":"Right-hand side of
 *      'instanceof' is not an object"}}
 *
 * Lock the export contract so a future refactor doesn't reintroduce
 * the broken destructure.
 */
test("#358: ErasureError must be importable from ipfs-erasure.ts for instanceof checks", async () => {
  const erasure = await import("./ipfs-erasure.ts") as Record<string, unknown>
  assert.equal(typeof erasure.ErasureError, "function",
    "ipfs-erasure.ts MUST export ErasureError as a constructor — index.ts depends on it for the getErasureStatus closure's err-typing branch")

  // Sanity: instanceof works against the real export (i.e. our fix
  // actually catches typed errors instead of crashing on undefined RHS).
  const Klass = erasure.ErasureError as new (code: string, msg: string) => Error & { code: string }
  const e = new Klass("invalid_cid", "test")
  assert.ok(e instanceof Klass,
    "the dynamically-imported ErasureError must satisfy instanceof against itself")
})

test("#358: simulating the pre-fix bug shape — `err instanceof undefined` throws V8 TypeError", () => {
  // Pin the V8 error message so the issue description stays accurate
  // and future maintainers see why the dynamic-import fix matters.
  const Undef = undefined as unknown as new (...args: unknown[]) => unknown
  const err = new Error("any error")
  let caught: unknown
  try {
    // @ts-expect-error — we're deliberately reproducing the bug shape.
    const _ = err instanceof Undef
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof TypeError, "instanceof against undefined RHS must throw TypeError")
  assert.match(
    (caught as Error).message,
    /Right-hand side of 'instanceof' is not (an object|callable)/,
    "V8 message must match the one leaked through the RPC -32603 reply pre-fix"
  )
})
