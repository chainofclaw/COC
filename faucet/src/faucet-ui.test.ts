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
})
