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

test("#505: resolveCid sanitizes multiformats library error messages (no library-internal leak)", async () => {
  // Pre-fix `resolveCid("not-a-cid")` threw an ErasureError whose message
  // concatenated the multiformats library's internal text verbatim:
  //   "unparseable CID: To parse non base32, base36 or base58btc encoded
  //    CID multibase decoder must be provided"
  // That message text leaked the library's internal multibase-decoder
  // architecture to the wire — same anti-pattern family as #156
  // (ethers BUFFER_OVERRUN leak), #176 (V8 SyntaxError leak), #182
  // (TypedDataEncoder INVALID_ARGUMENT leak), #214 (HTTP error shape).
  //
  // Live testnet 88780 reproduction (this iteration):
  //   coc_erasureStatus(["not-a-cid"])
  //     → -32602 "unparseable CID: To parse non base32, base36 or
  //               base58btc encoded CID multibase decoder must be provided"
  // Fix emits a clean shape-only message.
  const reader = await import("./ipfs-erasure-reader.ts") as {
    resolveCid: (cid: string, store: unknown) => Promise<unknown>
  }
  const erasure = await import("./ipfs-erasure.ts") as Record<string, unknown>
  const ErasureErrorKlass = erasure.ErasureError as new (...args: unknown[]) => Error & { code: string }

  let caught: unknown
  try {
    await reader.resolveCid("not-a-cid", { get: async () => undefined } as never)
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ErasureErrorKlass, "must throw ErasureError")
  const err = caught as Error & { code: string }
  assert.equal(err.code, "invalid_cid", "error code must be invalid_cid")

  // Message must NOT leak multiformats library internals.
  assert.doesNotMatch(
    err.message,
    /multibase decoder must be provided|base32, base36 or base58btc|multiformats/i,
    `error message must not leak multiformats internals, got: "${err.message}"`,
  )
  // Should contain a generic shape hint.
  assert.match(
    err.message,
    /invalid CID|malformed/i,
    `error message should mention "invalid CID" / "malformed", got: "${err.message}"`,
  )
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
