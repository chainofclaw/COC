import http from "node:http";

export async function requestJson(url: string, method: string, body?: unknown): Promise<{ status?: number; json?: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { "content-type": "application/json" } }, (res) => {
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
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
