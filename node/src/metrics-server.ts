// Standalone HTTP server for Prometheus /metrics endpoint
// Runs on a separate port (default 9100) to avoid mixing with RPC

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { metrics, type MetricsSource } from "./metrics.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("metrics")

export interface MetricsServerOpts {
  port?: number
  bind?: string
  collectIntervalMs?: number
}

export function startMetricsServer(
  source: MetricsSource,
  opts: MetricsServerOpts = {},
): { stop: () => void } {
  const port = opts.port ?? 9100
  const bind = opts.bind ?? "0.0.0.0"
  const collectIntervalMs = opts.collectIntervalMs ?? 5000

  metrics.setSource(source)

  // Periodic collection
  const timer = setInterval(async () => {
    try {
      await metrics.collect()
    } catch (err) {
      log.error("metrics collection failed", { error: String(err) })
    }
  }, collectIntervalMs)
  timer.unref()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/metrics" && req.method === "GET") {
      try {
        await metrics.collect()
        const body = metrics.serialize()
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        })
        res.end(body)
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" })
        res.end("metrics collection error\n")
      }
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("ok\n")
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found\n")
    }
  })

  server.listen(port, bind, () => {
    log.info("metrics server started", { bind, port })
  })

  return {
    stop: () => {
      clearInterval(timer)
      server.close()
    },
  }
}
