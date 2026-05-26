import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPoseWitnessAuthConfigured,
  buildWitnessAuthHeaders,
  createPoseWitnessAuth,
  isPoseWitnessRequestAuthorized,
  resolvePoseWitnessAuthToken,
} from "./pose-witness-auth.ts";

function request(remoteAddress: string, authorization?: string | string[]) {
  return {
    headers: authorization === undefined ? {} : { authorization },
    socket: { remoteAddress },
  };
}

function requestWithHeaders(remoteAddress: string, headers: Record<string, string | string[] | undefined>) {
  return {
    headers,
    socket: { remoteAddress },
  };
}

test("#667: remote /pose/witness requests are rejected when no token is configured", () => {
  assert.equal(isPoseWitnessRequestAuthorized(request("203.0.113.10"), undefined), false);
});

test("#667: loopback /pose/witness requests remain local-dev compatible without a token", () => {
  for (const ip of ["127.0.0.1", "127.22.33.44", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
    assert.equal(isPoseWitnessRequestAuthorized(request(ip), undefined), true, ip);
  }
});

test("#667: remote /pose/witness requests require the configured bearer token", () => {
  const token = "witness-secret";
  assert.equal(isPoseWitnessRequestAuthorized(request("203.0.113.10", "Bearer witness-secret"), token), true);
  assert.equal(isPoseWitnessRequestAuthorized(request("203.0.113.10", "Bearer wrong"), token), false);
  assert.equal(isPoseWitnessRequestAuthorized(request("203.0.113.10", "Basic witness-secret"), token), false);
  assert.equal(isPoseWitnessRequestAuthorized(request("203.0.113.10"), token), false);
  assert.equal(isPoseWitnessRequestAuthorized(request("203.0.113.10", ["Bearer witness-secret"]), token), false);
});

test("#667: configured tokens are enforced for loopback callers too", () => {
  const token = "witness-secret";
  assert.equal(isPoseWitnessRequestAuthorized(request("127.0.0.1"), token), false);
  assert.equal(isPoseWitnessRequestAuthorized(request("127.0.0.1", "Bearer witness-secret"), token), true);
});

test("#667: auth token resolution trims env/config values", () => {
  assert.equal(resolvePoseWitnessAuthToken("  env-token  ", "config-token"), "env-token");
  assert.equal(resolvePoseWitnessAuthToken("  ", " config-token "), "config-token");
  assert.equal(resolvePoseWitnessAuthToken(undefined, ""), undefined);
});

test("#667: witness auth header helper omits empty tokens", () => {
  assert.deepEqual(buildWitnessAuthHeaders(" secret "), { Authorization: "Bearer secret" });
  assert.equal(buildWitnessAuthHeaders("   "), undefined);
  assert.equal(buildWitnessAuthHeaders(undefined), undefined);
});

// ---- #750 (#667 F7) — auth mode + X-Forwarded-For + startup assertion ----

test("#750: token-required mode signals the auth surface accurately", () => {
  const auth = createPoseWitnessAuth({ authToken: "secret" }, { bindHost: "0.0.0.0" });
  assert.equal(auth.mode(), "token-required");
  // Authorized callers — token wins regardless of source.
  assert.equal(auth.isAuthorized(request("203.0.113.10", "Bearer secret")), true);
  assert.equal(auth.isAuthorized(request("127.0.0.1", "Bearer secret")), true);
  assert.equal(auth.isAuthorized(request("203.0.113.10", "Bearer wrong")), false);
  assert.equal(auth.isAuthorized(request("127.0.0.1")), false); // token-required: no token → reject
});

test("#750: loopback-only mode (loopback bind, no token) accepts loopback peers only", () => {
  const auth = createPoseWitnessAuth({}, { bindHost: "127.0.0.1" });
  assert.equal(auth.mode(), "loopback-only");
  assert.equal(auth.isAuthorized(request("127.0.0.1")), true);
  assert.equal(auth.isAuthorized(request("::1")), true);
  assert.equal(auth.isAuthorized(request("203.0.113.10")), false);
});

test("#750: misconfigured mode (non-loopback bind, no token, no trusted proxy) rejects everything", () => {
  const auth = createPoseWitnessAuth({}, { bindHost: "0.0.0.0" });
  assert.equal(auth.mode(), "misconfigured");
  assert.equal(auth.isAuthorized(request("127.0.0.1")), false);
  assert.equal(auth.isAuthorized(request("203.0.113.10")), false);
  assert.equal(auth.isAuthorized(request("203.0.113.10", "Bearer anything")), false);
});

test("#750: assertPoseWitnessAuthConfigured throws when misconfigured", () => {
  assert.throws(
    () => assertPoseWitnessAuthConfigured({}, { bindHost: "0.0.0.0" }),
    /misconfigured/,
  );
});

test("#750: assertPoseWitnessAuthConfigured passes when token configured", () => {
  assert.doesNotThrow(() =>
    assertPoseWitnessAuthConfigured({ authToken: "x" }, { bindHost: "0.0.0.0" }),
  );
});

test("#750: assertPoseWitnessAuthConfigured passes when trusted proxies configured", () => {
  assert.doesNotThrow(() =>
    assertPoseWitnessAuthConfigured({ trustedProxies: ["10.0.0.1"] }, { bindHost: "0.0.0.0" }),
  );
});

test("#750: ALLOW_INSECURE override bypasses startup assertion", () => {
  assert.doesNotThrow(() =>
    assertPoseWitnessAuthConfigured({}, { bindHost: "0.0.0.0", allowInsecure: true }),
  );
});

test("#750: trusted-proxy mode reads X-Forwarded-For only from allowlisted peers", () => {
  const auth = createPoseWitnessAuth(
    { trustedProxies: ["10.0.0.1"] },
    { bindHost: "0.0.0.0" },
  );
  assert.equal(auth.mode(), "loopback-only-behind-proxy");
  // From the trusted proxy with a loopback forwarded address → allowed.
  assert.equal(
    auth.isAuthorized(requestWithHeaders("10.0.0.1", { "x-forwarded-for": "127.0.0.1" })),
    true,
  );
  // From the trusted proxy with an external forwarded address → rejected.
  assert.equal(
    auth.isAuthorized(requestWithHeaders("10.0.0.1", { "x-forwarded-for": "8.8.8.8" })),
    false,
  );
});

test("#750: untrusted peer cannot spoof loopback via X-Forwarded-For", () => {
  // The critical regression test: pre-#750 (with no token), an attacker
  // could hit a node behind a misconfigured reverse proxy from the
  // public internet — the socket peer would be 127.0.0.1 (the proxy
  // upstream) and the request would be signed. With #750 we never
  // honour X-Forwarded-For unless the immediate peer is in the trusted
  // proxy allowlist, so an attacker's injected `X-Forwarded-For: 127.0.0.1`
  // is ignored.
  const auth = createPoseWitnessAuth(
    { trustedProxies: ["10.0.0.1"] }, // only 10.0.0.1 is trusted
    { bindHost: "0.0.0.0" },
  );
  // Attacker from 1.2.3.4 tries to claim loopback origin.
  assert.equal(
    auth.isAuthorized(requestWithHeaders("1.2.3.4", { "x-forwarded-for": "127.0.0.1" })),
    false,
  );
});

test("#750: leftmost X-Forwarded-For wins (RFC 7239) — multi-hop attacker can't piggyback", () => {
  const auth = createPoseWitnessAuth(
    { trustedProxies: ["10.0.0.1"] },
    { bindHost: "0.0.0.0" },
  );
  // Legitimate loopback origin then proxy hop → loopback.
  assert.equal(
    auth.isAuthorized(requestWithHeaders("10.0.0.1", { "x-forwarded-for": "127.0.0.1, 10.0.0.2" })),
    true,
  );
  // External origin, attacker tries to append a loopback hop downstream
  // — the leftmost (8.8.8.8) is still external → rejected.
  assert.equal(
    auth.isAuthorized(requestWithHeaders("10.0.0.1", { "x-forwarded-for": "8.8.8.8, 127.0.0.1" })),
    false,
  );
});

test("#750: when token is set, trusted-proxy parsing is moot (token check dominates)", () => {
  const auth = createPoseWitnessAuth(
    { authToken: "secret", trustedProxies: ["10.0.0.1"] },
    { bindHost: "0.0.0.0" },
  );
  assert.equal(auth.mode(), "token-required");
  // Wrong token from anywhere → reject (XFF irrelevant).
  assert.equal(
    auth.isAuthorized(requestWithHeaders("10.0.0.1", {
      authorization: "Bearer wrong",
      "x-forwarded-for": "127.0.0.1",
    })),
    false,
  );
  // Right token from anywhere → accept.
  assert.equal(
    auth.isAuthorized(requestWithHeaders("203.0.113.10", { authorization: "Bearer secret" })),
    true,
  );
});
