import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import { startAgentMetricsServer } from "./agent-metrics-server.ts"

function httpGet(
  host: string,
  port: number,
  path: string,
): Promise<{ statusCode: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, path, method: "GET" },
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
})
