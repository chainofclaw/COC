// #292: bounded HTTP request body reader for coc-node's /pose/* POST
// endpoints. Pre-fix the runtime used `let body = ""; req.on("data", c =>
// body += c)` with no size cap and no stream-error handler — an attacker
// streaming a multi-GB body could OOM the coc-node process and halt
// PoSe reception. node/src/pose-http.ts already enforces 1 MB via
// MAX_POSE_BODY; this is the runtime-side symmetric cap.
import type http from "node:http";

export const MAX_RUNTIME_POSE_BODY = 1024 * 1024; // 1 MB

interface JsonRes {
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function writeJson(res: JsonRes, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Accumulate the request body into a single string, bounded by
 * MAX_RUNTIME_POSE_BODY. Calls onBody only once the full body has been
 * received within the cap. If the cap is exceeded, responds 413 and
 * destroys the request stream — onBody is NOT invoked.
 *
 * Also handles stream errors with a 400 response, so a half-sent body
 * from a misbehaving client doesn't leave the response hanging.
 */
export function readBoundedBody(
  req: http.IncomingMessage,
  res: JsonRes,
  onBody: (body: string) => void,
  maxBytes: number = MAX_RUNTIME_POSE_BODY,
): void {
  let body = "";
  let aborted = false;
  req.on("data", (chunk: Buffer | string) => {
    if (aborted) return;
    body += typeof chunk === "string" ? chunk : chunk.toString();
    if (body.length > maxBytes) {
      aborted = true;
      writeJson(res, 413, {
        error: `body too large: ${body.length} > ${maxBytes} (max ${maxBytes / 1024} KB)`,
      });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!aborted) onBody(body);
  });
  req.on("error", () => {
    if (!aborted) {
      aborted = true;
      try {
        writeJson(res, 400, { error: "request stream error" });
      } catch {
        /* response may already be closed */
      }
    }
  });
}
