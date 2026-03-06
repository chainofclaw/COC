import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createLogger } from "../../node/src/logger.ts"

const log = createLogger("agent-metrics")

export interface AgentMetricsServerOptions {
  port: number
  bind: string
  getPrometheus: () => string
}

export interface AgentMetricsServerHandle {
  bind: string
  port: number
  stop: () => Promise<void>
}

export async function startAgentMetricsServer(
  options: AgentMetricsServerOptions,
): Promise<AgentMetricsServerHandle> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/metrics") {
      const body = options.getPrometheus()
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("ok\n")
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("not found\n")
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.bind, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address()
  const actualPort =
    addr && typeof addr === "object" && typeof addr.port === "number"
      ? addr.port
      : options.port

  log.info("agent metrics server started", {
    bind: options.bind,
    port: actualPort,
  })

  return {
    bind: options.bind,
    port: actualPort,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}
