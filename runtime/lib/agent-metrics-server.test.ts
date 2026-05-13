import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import { startAgentMetricsServer } from "./agent-metrics-server.ts"

function httpGet(
  host: string,
  port: number,
  path: string,
): Promise<{ statusCode: number; body: string; contentType: string }> {
  return httpRequest(host, port, path, "GET")
}

function httpRequest(
  host: string,
  port: number,
  path: string,
  method: string,
): Promise<{ statusCode: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, path, method },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          })
        })
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("agent-metrics-server", () => {
  it("serves /metrics, /health and 404", async () => {
    let metricsBody = "coc_agent_pending_v1 1\n"
    const handle = await startAgentMetricsServer({
      bind: "127.0.0.1",
      port: 0,
      getPrometheus: () => metricsBody,
    })

    try {
      const metricsResp = await httpGet(handle.bind, handle.port, "/metrics")
      assert.equal(metricsResp.statusCode, 200)
      assert.match(metricsResp.contentType, /text\/plain/)
      assert.equal(metricsResp.body, metricsBody)

      metricsBody = "coc_agent_pending_v1 2\n"
      const metricsResp2 = await httpGet(handle.bind, handle.port, "/metrics")
      assert.equal(metricsResp2.statusCode, 200)
      assert.equal(metricsResp2.body, metricsBody)

      const healthResp = await httpGet(handle.bind, handle.port, "/health")
      assert.equal(healthResp.statusCode, 200)
      assert.equal(healthResp.body, "ok\n")

      const missingResp = await httpGet(handle.bind, handle.port, "/not-found")
      assert.equal(missingResp.statusCode, 404)
      assert.equal(missingResp.body, "not found\n")
    } finally {
      await handle.stop()
    }
  })

  it("#414: HEAD on /metrics and /health returns 200 (uptime-monitor parity)", async () => {
    // Pre-fix the bare GET method gate let HEAD probes fall through to
    // the 404 catch-all (Prometheus blackbox_exporter with method=HEAD,
    // k8s livenessProbe httpHeaders HEAD). Sibling of #410 / #376 /
    // #382. Per HTTP/1.1 §9.4 HEAD must mirror GET on every read
    // endpoint; Node auto-suppresses the body when Content-Length is
    // set so the same handler serves both verbs.
    const handle = await startAgentMetricsServer({
      bind: "127.0.0.1",
      port: 0,
      getPrometheus: () => "coc_agent_pending_v1 0\n",
    })
    try {
      // HEAD /metrics → 200 (body suppressed by Node)
      const metricsHead = await httpRequest(handle.bind, handle.port, "/metrics", "HEAD")
      assert.equal(metricsHead.statusCode, 200, "HEAD /metrics must be 200")
      assert.match(metricsHead.contentType, /text\/plain/, "HEAD /metrics content-type must match")
      // Per HTTP/1.1 §9.4, HEAD response has no body. Node auto-suppresses.
      assert.equal(metricsHead.body, "", "HEAD /metrics must have empty body")
      // HEAD /health → 200
      const healthHead = await httpRequest(handle.bind, handle.port, "/health", "HEAD")
      assert.equal(healthHead.statusCode, 200, "HEAD /health must be 200")
      // HEAD /not-found → 404 (catch-all unchanged for non-read verbs / unknown URLs)
      const missingHead = await httpRequest(handle.bind, handle.port, "/not-found", "HEAD")
      assert.equal(missingHead.statusCode, 404, "HEAD on unknown URL stays 404")
    } finally {
      await handle.stop()
    }
  })
})
