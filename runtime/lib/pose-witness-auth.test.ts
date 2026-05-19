import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWitnessAuthHeaders,
  isPoseWitnessRequestAuthorized,
  resolvePoseWitnessAuthToken,
} from "./pose-witness-auth.ts";

function request(remoteAddress: string, authorization?: string | string[]) {
  return {
    headers: authorization === undefined ? {} : { authorization },
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
