import { timingSafeEqual } from "node:crypto";

export interface PoseWitnessAuthRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: {
    remoteAddress?: string | null;
  };
}

/**
 * #750 (#667 F7, audit follow-up 2026-05-26) — runtime auth mode for
 * `/pose/witness`. Surfaced via {@link describePoseWitnessAuthMode} so
 * operators can grep logs / hit /health to detect misconfiguration
 * (e.g. token env var dropped on container relaunch, silently degrading
 * to loopback-only behind a reverse proxy that turns the bind address
 * into 127.0.0.1).
 *
 *  - "token-required": auth token configured; only Bearer-matching
 *    requests are signed.
 *  - "loopback-only": no token; only loopback-source requests are
 *    signed (the original default).
 *  - "loopback-only-behind-proxy": no token, but a trusted-proxy
 *    allowlist is configured; loopback is judged from the leftmost
 *    forwarded address rather than the immediate socket peer.
 *  - "misconfigured": non-loopback bind without a token AND without a
 *    trusted-proxy allowlist. Refuse to start the server in this mode.
 */
export type PoseWitnessAuthMode =
  | "token-required"
  | "loopback-only"
  | "loopback-only-behind-proxy"
  | "misconfigured";

export interface PoseWitnessAuthOptions {
  /** Bearer token. If set, this is the only accepted credential. */
  authToken?: string;
  /**
   * Trusted-proxy allowlist for X-Forwarded-For parsing. ONLY consult
   * X-Forwarded-For when the immediate socket peer is in this set —
   * otherwise any external caller could inject a 127.0.0.1 header and
   * be treated as loopback. Default empty (header ignored).
   */
  trustedProxies?: string[];
}

export interface PoseWitnessAuthRuntime {
  isAuthorized(req: PoseWitnessAuthRequest): boolean;
  mode(): PoseWitnessAuthMode;
}

export function resolvePoseWitnessAuthToken(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Build a runtime that closes over the auth options. Prefer this in new
 * call sites — the legacy {@link isPoseWitnessRequestAuthorized} is kept
 * for backwards-compat with tests / callers that haven't migrated.
 */
export function createPoseWitnessAuth(
  opts: PoseWitnessAuthOptions,
  ctx: { bindHost: string } = { bindHost: "127.0.0.1" },
): PoseWitnessAuthRuntime {
  const trustedProxies = new Set((opts.trustedProxies ?? []).map(s => s.trim()).filter(Boolean));
  const hasToken = !!opts.authToken;
  const bindIsLoopback = isLoopbackAddress(ctx.bindHost);

  let resolved: PoseWitnessAuthMode;
  if (hasToken) {
    resolved = "token-required";
  } else if (bindIsLoopback) {
    resolved = "loopback-only";
  } else if (trustedProxies.size > 0) {
    resolved = "loopback-only-behind-proxy";
  } else {
    resolved = "misconfigured";
  }

  return {
    mode() {
      return resolved;
    },
    isAuthorized(req: PoseWitnessAuthRequest): boolean {
      if (resolved === "misconfigured") return false;
      if (hasToken) {
        const bearer = readBearerToken(req.headers);
        return !!bearer && constantTimeEqual(bearer, opts.authToken!);
      }
      const peerIp = stripIp6Map(req.socket.remoteAddress ?? "");
      // Behind a trusted proxy, the socket peer is the proxy itself.
      // The "real" client is in X-Forwarded-For. Only honour it when the
      // immediate peer is in the allowlist — otherwise the header is a
      // free spoof.
      if (trustedProxies.has(peerIp)) {
        const xff = forwardedFor(req.headers);
        return xff !== null && isLoopbackAddress(xff);
      }
      return isLoopbackAddress(peerIp);
    },
  };
}

/**
 * Hard-fail when the witness server is bound to a non-loopback address
 * without a token AND without a trusted-proxy allowlist. The pre-#750
 * default would have started in "loopback-only" mode behind a reverse
 * proxy and silently accepted every external request as loopback (the
 * socket peer is always 127.0.0.1 after TLS termination by the proxy).
 *
 * Operators that genuinely want token-less open access must set
 * `COC_POSE_WITNESS_ALLOW_INSECURE=1` (acknowledged misconfiguration).
 */
export function assertPoseWitnessAuthConfigured(
  opts: PoseWitnessAuthOptions,
  ctx: { bindHost: string; allowInsecure?: boolean },
): void {
  const runtime = createPoseWitnessAuth(opts, { bindHost: ctx.bindHost });
  if (runtime.mode() === "misconfigured" && !ctx.allowInsecure) {
    throw new Error(
      "pose-witness auth misconfigured: non-loopback bind requires either " +
      "COC_POSE_WITNESS_AUTH_TOKEN or a non-empty COC_POSE_WITNESS_TRUSTED_PROXIES " +
      "(set COC_POSE_WITNESS_ALLOW_INSECURE=1 to override — not recommended)"
    );
  }
}

/**
 * @deprecated #750 — prefer {@link createPoseWitnessAuth}. Kept so
 * callers that haven't migrated continue to work; the new code path in
 * coc-node.ts is on the runtime form.
 */
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

function forwardedFor(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  // Leftmost address in the chain is the original client (per RFC 7239).
  // Subsequent addresses are upstream proxies. We use leftmost so a
  // legitimate loopback-then-proxy chain (`127.0.0.1, 10.0.0.1`) reads
  // as loopback, but reject `8.8.8.8, 127.0.0.1` (attacker-from-outside
  // injects an upstream loopback claim).
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? stripIp6Map(first) : null;
}

function stripIp6Map(ip: string): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
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
  if (stripped === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped)) {
    const parts = stripped.split(".").map(Number);
    return parts.every((part) => part >= 0 && part <= 255);
  }
  return false;
}
