import { timingSafeEqual } from "node:crypto";

export interface PoseWitnessAuthRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: {
    remoteAddress?: string | null;
  };
}

export function resolvePoseWitnessAuthToken(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function isPoseWitnessRequestAuthorized(
  req: PoseWitnessAuthRequest,
  authToken: string | undefined,
): boolean {
  if (authToken) {
    const bearer = readBearerToken(req.headers);
    return !!bearer && constantTimeEqual(bearer, authToken);
  }
  return isLoopbackAddress(req.socket.remoteAddress ?? "");
}

export function buildWitnessAuthHeaders(authToken?: string): Record<string, string> | undefined {
  const token = authToken?.trim();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function readBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  if (typeof raw !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!match) {
    return null;
  }
  const token = match[1]?.trim();
  return token || null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

function isLoopbackAddress(ip: string): boolean {
  if (!ip || ip === "unknown") return false;
  const stripped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (stripped === "::1" || stripped === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped)) {
    const parts = stripped.split(".").map(Number);
    return parts.every((part) => part >= 0 && part <= 255);
  }
  return false;
}
