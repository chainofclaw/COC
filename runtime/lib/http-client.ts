import http from "node:http";
import https from "node:https";

const REQUEST_TIMEOUT_MS = 30_000;

export async function requestJson(url: string, method: string, body?: unknown): Promise<{ status?: number; json?: any }> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https") ? https : http;
    const req = transport.request(url, { method, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: data ? JSON.parse(data) : undefined });
        } catch {
          resolve({ status: res.statusCode, json: undefined });
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    // BigInts appear in Phase C v2 challenge payloads (epochId, timestamps,
    // nonce). JSON.stringify throws "Do not know how to serialize a BigInt",
    // so coerce to decimal strings on the wire. Receivers already parse
    // numeric fields with BigInt(...) via pose-types-v2 Zod, so this is
    // a round-trip-safe projection.
    if (body) req.write(JSON.stringify(body, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    req.end();
  });
}
