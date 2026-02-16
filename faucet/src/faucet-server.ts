// COC Testnet Faucet HTTP Server
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Faucet, FaucetError } from "./faucet.ts"

const PORT = Number(process.env.COC_FAUCET_PORT ?? 3003)
const BIND = process.env.COC_FAUCET_BIND ?? "0.0.0.0"

const faucet = new Faucet({
  rpcUrl: process.env.COC_FAUCET_RPC_URL ?? "http://127.0.0.1:18780",
  privateKey: process.env.COC_FAUCET_PRIVATE_KEY ?? (() => {
    console.error("COC_FAUCET_PRIVATE_KEY environment variable is required")
    process.exit(1)
  })(),
  dripAmountEth: process.env.COC_FAUCET_DRIP_AMOUNT ?? "10",
  dailyGlobalLimitEth: process.env.COC_FAUCET_DAILY_LIMIT ?? "10000",
  perAddressCooldownMs: Number(process.env.COC_FAUCET_COOLDOWN_MS ?? 86_400_000),
})

// Simple IP-based rate limiter
const ipRequests = new Map<string, number[]>()
const IP_WINDOW_MS = 60_000
const IP_MAX_REQUESTS = 10

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now()
  const requests = ipRequests.get(ip) ?? []
  const recent = requests.filter((t) => now - t < IP_WINDOW_MS)
  if (recent.length >= IP_MAX_REQUESTS) return false
  recent.push(now)
  ipRequests.set(ip, recent)
  return true
}

// Periodic cleanup of IP records
setInterval(() => {
  const now = Date.now()
  for (const [ip, times] of ipRequests) {
    const recent = times.filter((t) => now - t < IP_WINDOW_MS)
    if (recent.length === 0) {
      ipRequests.delete(ip)
    } else {
      ipRequests.set(ip, recent)
    }
  }
}, 60_000).unref()

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) {
        reject(new Error("Request body too large"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  })
  res.end(body)
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    })
    res.end()
    return
  }

  try {
    if (req.url === "/health" && req.method === "GET") {
      jsonResponse(res, 200, { status: "ok", faucetAddress: faucet.address })
      return
    }

    if (req.url === "/faucet/status" && req.method === "GET") {
      const status = await faucet.getStatus()
      jsonResponse(res, 200, status)
      return
    }

    if (req.url === "/faucet/request" && req.method === "POST") {
      const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
        ?? req.socket.remoteAddress
        ?? "unknown"

      if (!checkIpRateLimit(ip)) {
        jsonResponse(res, 429, { error: "Too many requests from this IP" })
        return
      }

      const rawBody = await readBody(req)
      let body: { address?: string }
      try {
        body = JSON.parse(rawBody)
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" })
        return
      }

      if (!body.address) {
        jsonResponse(res, 400, { error: "Missing 'address' field" })
        return
      }

      const result = await faucet.requestDrip(body.address)
      jsonResponse(res, 200, {
        txHash: result.txHash,
        amount: result.amount,
        unit: "COC",
      })
      return
    }

    jsonResponse(res, 404, { error: "Not found" })
  } catch (err) {
    if (err instanceof FaucetError) {
      jsonResponse(res, err.statusCode, { error: err.message })
    } else {
      console.error("Faucet error:", err)
      jsonResponse(res, 500, { error: "Internal server error" })
    }
  }
})

server.listen(PORT, BIND, () => {
  console.log(`COC Faucet server listening on ${BIND}:${PORT}`)
  console.log(`Faucet address: ${faucet.address}`)
})

process.on("SIGINT", () => {
  server.close()
  process.exit(0)
})
