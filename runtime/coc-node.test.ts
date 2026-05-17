/**
 * Static-source regressions for `runtime/coc-node.ts`.
 *
 * The file has module-load side effects (`await loadConfig()`, listens on
 * a port, reads private keys) so importing it from a test would start
 * the full PoSe server. Other tests in this directory already test
 * coc-node piecemeal via the runtime/lib helpers — so for shape-level
 * regressions that don't need a live server, we follow the same
 * pattern used by `faucet/src/faucet-ui.test.ts`: read the source file
 * and assert structural invariants via regex.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, "coc-node.ts"), "utf-8")

describe("coc-node HTTP server source", () => {
  it("#410: GET /health must accept HEAD too (uptime-monitor parity)", () => {
    // Sibling to the faucet `#410` fix. Pre-fix `req.method === "GET"
    // && req.url === "/health"` rejected HEAD probes from monitors
    // (Prometheus blackbox_exporter, k8s livenessProbe with
    // httpHeaders HEAD), falling through to the 404 catch-all and
    // making the monitor flag the node down. Per HTTP/1.1 §9.4 HEAD
    // must mirror GET on every read endpoint.
    assert.match(
      SRC,
      /\(req\.method === "GET" \|\| req\.method === "HEAD"\) && req\.url === "\/health"/,
      "coc-node.ts must accept HEAD alongside GET for /health",
    )
    // Belt-and-braces: no bare `req.method === "GET" && req.url === "/health"`
    // pattern remains.
    assert.doesNotMatch(
      SRC,
      /(?<!\|\| )req\.method === "GET" && req\.url === "\/health"/,
      "coc-node.ts must not have a bare GET-only /health check",
    )
  })

  it("#666: /pose/receipt must reject unknown challenge types, not echo-and-sign them", () => {
    // Pre-fix the receipt fallback built `responseBody = {ok:true, echo:
    // payload.payload}` for any non-U/S/R challenge type and SIGNED it — a
    // signing oracle: an unauthenticated caller could register a bogus-type
    // challenge via /pose/challenge then obtain a node-signed receipt (v1
    // EIP-191 or v2 EIP-712) over arbitrary attacker-supplied JSON.
    assert.doesNotMatch(
      SRC,
      /echo:\s*payload\.payload/,
      "coc-node.ts must not echo-and-sign caller-supplied payload.payload",
    )
    assert.match(
      SRC,
      /unknown challenge type/,
      "coc-node.ts must explicitly reject unknown PoSe challenge types",
    )
  })
})
