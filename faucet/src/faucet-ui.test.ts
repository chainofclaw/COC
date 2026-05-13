/**
 * Tests for Faucet Web UI serving
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, "..", "public")
const INDEX_PATH = join(PUBLIC_DIR, "index.html")

describe("Faucet Web UI", () => {
  it("index.html exists", () => {
    assert.ok(existsSync(INDEX_PATH), "public/index.html should exist")
  })

  it("index.html is valid HTML with required elements", () => {
    const html = readFileSync(INDEX_PATH, "utf-8")

    assert.ok(html.includes("<!DOCTYPE html>"), "should be valid HTML5")
    assert.ok(html.includes("<title>COC Testnet Faucet</title>"), "should have correct title")
    assert.ok(html.includes('id="faucetForm"'), "should have faucet form")
    assert.ok(html.includes('id="address"'), "should have address input")
    assert.ok(html.includes('id="submitBtn"'), "should have submit button")
    assert.ok(html.includes('id="result"'), "should have result container")
  })

  it("index.html has faucet status section", () => {
    const html = readFileSync(INDEX_PATH, "utf-8")

    assert.ok(html.includes('id="statBalance"'), "should have balance stat")
    assert.ok(html.includes('id="statDrip"'), "should have drip amount stat")
    assert.ok(html.includes('id="statDaily"'), "should have daily stats")
    assert.ok(html.includes('id="statTotal"'), "should have total stats")
    assert.ok(html.includes('id="statAddress"'), "should have faucet address")
  })

  it("index.html calls correct API endpoints", () => {
    const html = readFileSync(INDEX_PATH, "utf-8")

    assert.ok(html.includes("/faucet/status"), "should call /faucet/status")
    assert.ok(html.includes("/faucet/request"), "should call /faucet/request")
    assert.ok(html.includes("/health"), "should call /health")
  })

  it("index.html has responsive design", () => {
    const html = readFileSync(INDEX_PATH, "utf-8")

    assert.ok(html.includes('name="viewport"'), "should have viewport meta tag")
    assert.ok(html.includes("max-width"), "should have max-width constraint")
  })

  it("index.html handles error display", () => {
    const html = readFileSync(INDEX_PATH, "utf-8")

    assert.ok(html.includes("result error"), "should have error result styling")
    assert.ok(html.includes("result success"), "should have success result styling")
  })
})

describe("Faucet server static serving", () => {
  it("faucet-server.ts imports and reads index.html", () => {
    const serverSrc = readFileSync(join(__dirname, "faucet-server.ts"), "utf-8")

    assert.ok(serverSrc.includes("INDEX_HTML"), "should define INDEX_HTML constant")
    assert.ok(serverSrc.includes('text/html'), "should serve as text/html")
    assert.ok(serverSrc.includes('req.url === "/"'), "should handle root path")
  })

  it('#410: HEAD request must mirror GET for read-only endpoints (no 404 to monitors)', () => {
    // Pre-fix every read-side handler tested `req.method === "GET"`
    // strictly, so a HEAD probe (uptime monitors, Prometheus blackbox,
    // k8s livenessProbe httpHeaders HEAD) fell through to the 404
    // catch-all and the monitor reported the service down. Node.js
    // auto-suppresses the body for HEAD when Content-Length is set,
    // so the same handlers serve both verbs. Static grep matches the
    // existing test style for this file.
    const serverSrc = readFileSync(join(__dirname, "faucet-server.ts"), "utf-8")
    assert.match(
      serverSrc,
      /(req\.method === "GET" \|\| req\.method === "HEAD"|isReadMethod\s*=\s*req\.method === "GET" \|\| req\.method === "HEAD")/,
      "faucet-server.ts must accept HEAD alongside GET for /, /health, /faucet/status",
    )
    // Make sure all three read endpoints use the combined check, not
    // the bare `=== "GET"`. Approximation: at most one `req.method ===
    // "GET"` literal should remain (the OR-form above, if you wrote it
    // inline). Any stricter form would re-introduce the bug.
    const strictGetCount = (serverSrc.match(/req\.method === "GET"(?! \|\| req\.method === "HEAD")/g) ?? []).length
    assert.ok(
      strictGetCount === 0,
      `faucet-server.ts has ${strictGetCount} bare 'req.method === "GET"' check(s) — HEAD must be accepted too`,
    )
  })
})
