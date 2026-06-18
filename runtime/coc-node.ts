import http from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./lib/config.ts";
import { InMemoryStore } from "./lib/state.ts";
import { recordChallengeBounded } from "./lib/bounded-challenge-store.ts";
import { validatePoseWitnessPayload } from "./lib/pose-witness-validator.ts";
import { validatePoseChallengePayload } from "./lib/pose-challenge-validator.ts";
import { verifyPushedReceipt } from "./lib/pose-witness-verifier.ts";
import { ContractReader } from "./lib/contract-reader.ts";
import {
  assertPoseWitnessAuthConfigured,
  createPoseWitnessAuth,
  resolvePoseWitnessAuthToken,
} from "./lib/pose-witness-auth.ts";
import { IpfsBlockstore } from "../node/src/ipfs-blockstore.ts";
import { loadStorageProof, MerkleLeavesCache } from "./lib/storage-proof.ts";
import { readBoundedBody } from "./lib/pose-body-reader.ts";
import { createNodeSigner, createNodeSignerV2, buildReceiptSignMessage } from "../node/src/crypto/signer.ts";
import { keccak256Hex } from "../services/relayer/keccak256.ts";
import { createLogger } from "../node/src/logger.ts";
import { buildDomain, RECEIPT_TYPES, WITNESS_TYPES, WITNESS_TYPES_V2, WITNESS_TYPES_V3 } from "../node/src/crypto/eip712-types.ts";

const log = createLogger("coc-node");

const config = await loadConfig();
const bind = process.env.COC_NODE_BIND || config.nodeBind || "127.0.0.1";
const port = Number(process.env.COC_NODE_PORT || config.nodePort || 18780);
const storageDir = resolveStorageDir(config.dataDir, config.storageDir);
const poseWitnessAuthToken = resolvePoseWitnessAuthToken(process.env.COC_POSE_WITNESS_AUTH_TOKEN, config.poseWitnessAuthToken);

// #750 (#667 F7, audit follow-up 2026-05-26) — runtime auth mode.
// Reads X-Forwarded-For only when the immediate peer is in the
// trusted-proxy allowlist so an external caller can't spoof loopback
// by injecting the header themselves. Asserts the mode at startup so
// a misconfigured deployment (non-loopback bind without a token AND
// without a trusted proxy) refuses to start instead of silently
// accepting every external request as loopback after the reverse proxy.
const poseWitnessTrustedProxies = (process.env.COC_POSE_WITNESS_TRUSTED_PROXIES ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const poseWitnessAllowInsecure = (() => {
  const raw = process.env.COC_POSE_WITNESS_ALLOW_INSECURE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();
assertPoseWitnessAuthConfigured(
  { authToken: poseWitnessAuthToken, trustedProxies: poseWitnessTrustedProxies },
  { bindHost: bind, allowInsecure: poseWitnessAllowInsecure },
);
const poseWitnessAuth = createPoseWitnessAuth(
  { authToken: poseWitnessAuthToken, trustedProxies: poseWitnessTrustedProxies },
  { bindHost: bind },
);
log.info("pose-witness auth configured", {
  mode: poseWitnessAuth.mode(),
  bind,
  trustedProxies: poseWitnessTrustedProxies.length,
  allowInsecure: poseWitnessAllowInsecure,
});

// #747 (#667 F4, audit follow-up 2026-05-26) — strict-verified-challenge mode.
// When enabled, /pose/challenge rejects v1-shape payloads (no challengerSig,
// no derived challengeId). Default false to preserve in-flight callers
// during rollout. Once all challengers ship v2 payloads, operators flip
// this on to lock down the challenge submission path.
const poseRequireVerifiedChallenge = (() => {
  const raw = process.env.COC_POSE_REQUIRE_VERIFIED_CHALLENGE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();
const poseChallengeIssuedAtDriftMs = (() => {
  const raw = process.env.COC_POSE_CHALLENGE_DRIFT_MS?.trim();
  if (!raw) return 5 * 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    log.warn("invalid COC_POSE_CHALLENGE_DRIFT_MS — falling back to 5m", { raw });
    return 5 * 60_000;
  }
  return parsed;
})();

// Phase C2.1: when FF is on, the receipt handler reads real chunk bytes
// from the IPFS blockstore rooted at `storageDir` (same path the main
// node/src/index.ts IPFS subsystem uses) and derives Merkle proofs live.
// With FF off, we keep the pre-baked `file-meta.json` path so existing
// deployments behave identically until operator flips the switch.
const poseStorageFromBlockstore = config.poseStorageFromBlockstore === true;

// Post-incident defense (2026-04-25): probe + enforce :ro storage volume.
// Implementation lives in runtime/lib/storage-mount-check.ts so the
// probe + gate logic are independently unit-testable. See docs/
// incident-2026-04-25-chain-halt-post-mortem-{zh,en}.md.
import { enforceReadOnlyStorage } from "./lib/storage-mount-check.ts";

if (poseStorageFromBlockstore) {
  await enforceReadOnlyStorage(storageDir, {
    enforce: process.env.COC_REQUIRE_RO_STORAGE !== "0",
    log,
  });
}

const storageBlockstore = poseStorageFromBlockstore ? new IpfsBlockstore(storageDir) : undefined;
const merkleLeavesCache = new MerkleLeavesCache(500);

const nodePrivateKey = resolveRuntimeNodePrivateKey();
const nodeSigner = createNodeSigner(nodePrivateKey);

// v2: EIP-712 signer for PoSe v2 protocol
const useV2 = config.protocolVersion === 2;
const chainId = config.chainId ?? 20241224;
const verifyingContract = config.verifyingContract ?? config.poseManagerV2Address ?? "0x0000000000000000000000000000000000000000";
const nodeSignerV2 = useV2
  ? createNodeSignerV2(nodePrivateKey, buildDomain(BigInt(chainId), verifyingContract))
  : null;

// #667 (audit follow-up, 2026-05-26) — Push-verification configuration.
//
// `poseWitnessReaderOrNull` is the ContractReader the /pose/witness path
// uses to look up `nodeOperator(poseNodeId)` when verifying a pushed
// receipt's nodeSig. Only constructed when the v2 protocol is on and
// both the L2 RPC URL and PoSeManagerV2 address are configured — without
// either, an on-chain lookup is impossible so verification can't run.
//
// `poseWitnessRequireVerified` is the rollout switch. Default `false`
// (rubber-stamp fallback retained for in-flight callers that haven't
// upgraded to push fields yet). Operators flip it to `true` once their
// agent fleet ships push fields, at which point unverified requests
// receive a 400 instead of silently falling back.
//
// `poseWitnessFreshnessMs` bounds |now - responseAtMs|. Default 60s.
const poseWitnessReaderOrNull = useV2 && config.l2RpcUrl && config.poseManagerV2Address
  ? new ContractReader({
      l2RpcUrl: config.l2RpcUrl,
      poseManagerV2Address: config.poseManagerV2Address,
      cacheTtlMs: 30_000,
    })
  : null;
const poseWitnessRequireVerified = (() => {
  const raw = process.env.COC_POSE_WITNESS_REQUIRE_VERIFIED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return false;
})();
const poseWitnessFreshnessMs = (() => {
  const raw = process.env.COC_POSE_WITNESS_FRESHNESS_MS?.trim();
  if (!raw) return 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    log.warn("invalid COC_POSE_WITNESS_FRESHNESS_MS — falling back to 60_000ms", { raw });
    return 60_000;
  }
  return parsed;
})();
if (poseWitnessRequireVerified && !poseWitnessReaderOrNull) {
  // Strict mode requested but the on-chain lookup capability isn't wired —
  // refuse to start rather than silently degrade. Operators that hit this
  // need to configure config.l2RpcUrl + config.poseManagerV2Address before
  // enabling COC_POSE_WITNESS_REQUIRE_VERIFIED.
  throw new Error("COC_POSE_WITNESS_REQUIRE_VERIFIED=true but l2RpcUrl/poseManagerV2Address not configured");
}

// #746 — Layer-7 semantic verifier toggle. When enabled the witness runs
// `layer7VerifyForWitness` after push-verify succeeds and signs the v3
// typehash binding the computed `resultCode`. When disabled (default for
// the rollout window) only v1+v2 are produced; the contract's v3 → v2 → v1
// fallback path still accepts those during the soft-sunset window.
const poseWitnessLayer7Enabled = (() => {
  const raw = process.env.COC_POSE_WITNESS_LAYER7_VERIFY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();

// PoSe v2 ResultCode enum — kept in sync with services/common/pose-types-v2.ts.
const RESULT_CODE = {
  Ok: 0,
  Timeout: 1,
  InvalidSig: 2,
  StorageProofFail: 3,
  RelayWitnessFail: 4,
  TipMismatch: 5,
  NonceMismatch: 6,
  WitnessQuorumFail: 7,
  InvalidStorageAudit: 8,
} as const;

/**
 * #746 — minimal Layer-7 verifier for the witness path. Covers the uptime
 * surface that the prod 88780 PoSe v2 pipeline exercises today:
 *
 *   1. Re-fetch the block at `tipHeight` from the witness's own RPC.
 *   2. Compare the reported `tipHash` against what the witness sees.
 *
 * StorageProof and RelayResult verifiers are larger lifts (IPFS chunk
 * fetch + Merkle replay; relay path replay) and are tracked separately —
 * for now those receipts get the `Ok` resultCode IFF the cryptographic
 * push-verify already passed, on the theory that "the witness has not
 * seen a contradicting result locally" is still a tightening over the
 * pre-#746 rubber-stamp.
 */
async function layer7VerifyForWitness(input: {
  responseBody: Record<string, unknown>;
  tipHash: string;
  tipHeight: bigint;
}): Promise<number> {
  // Only the uptime path knows how to verify the body content vs RPC
  // independently. For storage/relay we have neither the chunk bytes
  // nor the relay state on this node — fall back to Ok (cryptographic
  // push-verify already ran).
  const challengeType =
    typeof input.responseBody?.challengeType === "string"
      ? (input.responseBody.challengeType as string).toLowerCase()
      : "";
  if (challengeType !== "uptime") {
    return RESULT_CODE.Ok;
  }
  const blockNumber = Number(input.tipHeight);
  if (!Number.isFinite(blockNumber) || blockNumber < 0) {
    return RESULT_CODE.TipMismatch;
  }
  const ourHash = await fetchBlockHash(blockNumber);
  if (!ourHash) {
    // RPC failure / block not yet available. Throw to fail closed —
    // we'd rather refuse to sign than silently report Ok.
    throw new Error("layer-7 verifier: RPC eth_getBlockByNumber returned no hash");
  }
  return ourHash.toLowerCase() === input.tipHash.toLowerCase()
    ? RESULT_CODE.Ok
    : RESULT_CODE.TipMismatch;
}

function resolveRuntimeNodePrivateKey(): string {
  const canonical = process.env.COC_NODE_KEY?.trim();
  const legacy = process.env.COC_NODE_PK?.trim();
  if (canonical && legacy && canonical !== legacy) {
    throw new Error("COC_NODE_KEY and COC_NODE_PK are both set but differ");
  }
  return canonical || legacy || "0x" + randomBytes(32).toString("hex");
}

async function signReceiptV2(
  challengeId: string,
  nodeId: string,
  responseBody: Record<string, unknown>,
  responseAtMs: number,
  tipHash: string,
  tipHeight: bigint,
): Promise<string> {
  if (!nodeSignerV2) throw new Error("v2 signer not available");
  const bodyHash = `0x${keccak256Hex(Buffer.from(stableStringify(responseBody), "utf8"))}`;
  return nodeSignerV2.eip712.signTypedData(RECEIPT_TYPES, {
    challengeId,
    nodeId,
    responseAtMs: BigInt(responseAtMs),
    responseBodyHash: bodyHash,
    tipHash,
    tipHeight,
  });
}

async function signWitnessAttestation(
  challengeId: string,
  nodeId: string,
  responseBodyHash: string,
  witnessIndex: number,
): Promise<string> {
  if (!nodeSignerV2) throw new Error("v2 signer not available");
  return nodeSignerV2.eip712.signTypedData(WITNESS_TYPES, {
    challengeId,
    nodeId,
    responseBodyHash,
    witnessIndex,
  });
}

/**
 * #667 — sign the v2 (`WitnessAttestationV2`) typehash that binds the
 * attestation to `epochId`. Returned alongside the v1 signature so the
 * on-chain `_validateWitnessQuorumV2` can pick either during the
 * versioned-typehash rollout window.
 */
async function signWitnessAttestationV2(
  challengeId: string,
  nodeId: string,
  responseBodyHash: string,
  witnessIndex: number,
  epochId: bigint,
): Promise<string> {
  if (!nodeSignerV2) throw new Error("v2 signer not available");
  return nodeSignerV2.eip712.signTypedData(WITNESS_TYPES_V2, {
    challengeId,
    nodeId,
    responseBodyHash,
    witnessIndex,
    epochId,
  });
}

/**
 * #746 — sign the v3 (`WitnessAttestationV3`) typehash that binds the
 * attestation to `resultCode` (in addition to `epochId`). The witness must
 * have independently computed `resultCode` by running the Layer-7 verifier
 * (`ReceiptVerifierV2.verify`) on the pushed receipt — see
 * `verifyPushedReceiptSemantics` for the implementation. Witnesses on
 * coc-node v0.4+ return v1+v2+v3 sigs during rollout; the contract tries
 * v3 first, then v2 (gated by v2SunsetEpoch), then v1 (gated by
 * v1SunsetEpoch).
 */
async function signWitnessAttestationV3(
  challengeId: string,
  nodeId: string,
  responseBodyHash: string,
  resultCode: number,
  witnessIndex: number,
  epochId: bigint,
): Promise<string> {
  if (!nodeSignerV2) throw new Error("v2 signer not available");
  return nodeSignerV2.eip712.signTypedData(WITNESS_TYPES_V3, {
    challengeId,
    nodeId,
    responseBodyHash,
    resultCode,
    witnessIndex,
    epochId,
  });
}

function signReceipt(challengeId: string, nodeId: string, responseBody: Record<string, unknown>, responseAtMs: number): string {
  const bodyHash = `0x${keccak256Hex(Buffer.from(stableStringify(responseBody), "utf8"))}`;
  const msg = buildReceiptSignMessage(challengeId, nodeId, bodyHash, BigInt(responseAtMs));
  return nodeSigner.sign(msg);
}

function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${props.join(",")}}`;
}

const challenges = new InMemoryStore<Record<string, unknown>>();

// #320: cap the in-memory challenge map to prevent unbounded growth
// from unauthenticated POST /pose/challenge spam. Pre-fix the Map had
// no size cap, no TTL, no LRU; coc-node also has no rate limiter at
// the runtime layer, so an attacker spamming unique challengeIds could
// grow the Map until the process OOMed. 100K entries × ~1 KB JSON each
// is ~100 MB ceiling — generous for legitimate PoSe traffic (challenges
// resolve within seconds) but bounded for adversarial spam. Eviction
// is FIFO via insertion-order Map.keys() — older entries are typically
// already consumed or timed out by the time the cap is hit.
// Logic extracted to runtime/lib/bounded-challenge-store.ts so the
// FIFO + dedup-of-existing-key behaviour is unit-tested without spinning
// up the HTTP server.

function json(res: http.ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// #292: cap body accumulation via runtime/lib/pose-body-reader.ts —
// pre-fix the three POST endpoints (/pose/challenge, /pose/receipt,
// /pose/witness) used `let body = ""; req.on("data", c => body += c)`
// with no size cap and no stream-error handler. The HTTP-side
// pose-http.ts already enforces 1 MB via MAX_POSE_BODY; the shared
// helper mirrors that on the runtime path so any future endpoint added
// here inherits the cap by default.

const server = http.createServer((req, res) => {
  if (!req.url) {
    return json(res, 404, { error: "not found" });
  }

  // #410: HEAD must mirror GET on /health so uptime monitors that
  // prefer HEAD (Prometheus blackbox_exporter, k8s livenessProbe with
  // httpHeaders HEAD) don't fall through to the 404 catch-all and
  // report the node down. Node auto-suppresses the body when
  // Content-Length is set, so the same handler serves both verbs.
  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/health") {
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  if (req.method === "POST" && req.url === "/pose/challenge") {
    // #292: body bounded via readBody (1 MB cap). Pre-fix this was
    // `let body = ""; req.on("data", c => body += c)` with no size
    // check — an attacker streaming a multi-GB body could OOM the
    // process.
    readBoundedBody(req, res, (body) => {
      // #222: wrap JSON.parse — pre-fix a malformed body threw inside
      // the async callback and bubbled to process.on("uncaughtException"),
      // either crashing coc-node or leaking the V8 SyntaxError wording.
      // Unauthenticated DoS / destabilisation vector.
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      // #747 (#667 F4) — validate the challenge. v2 shape gets the full
      // deterministic-derivation + EIP-712 signature check; v1 shape
      // falls through to the legacy non-empty-string check (preserves
      // the #320 hardening) unless the operator has flipped
      // `requireVerified` on. Either way the challenges Map key remains
      // the canonical (lowercased) challengeId so /pose/receipt /
      // /pose/witness lookups stay consistent.
      const validated = validatePoseChallengePayload(payload, {
        chainId: BigInt(chainId),
        verifyingContract,
        requireVerified: poseRequireVerifiedChallenge,
        maxIssuedAtDriftMs: poseChallengeIssuedAtDriftMs,
      });
      if (!validated.ok) {
        return json(res, validated.status, { error: validated.error });
      }
      if (validated.challenge.version === 1) {
        // Legacy length cap retained for v1 (raw string keys could be
        // up to 256 chars — sized for hex/uuid).
        if (validated.challenge.challengeId.length > 256) {
          return json(res, 400, { error: "challengeId too long (max 256 chars)" });
        }
      }
      recordChallengeBounded(challenges, validated.challenge.challengeId, payload);
      return json(res, 200, { accepted: true, version: validated.challenge.version });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/pose/receipt") {
    // #292: body bounded via readBody (1 MB cap). Same DoS class as
    // /pose/challenge — pre-fix used unbounded body accumulation.
    readBoundedBody(req, res, (body) => {
      // #222: parity with /pose/challenge — wrap JSON.parse so a
      // malformed body returns 400 instead of crashing the process.
      let payload: { challengeId?: string; challengeType?: string; payload?: unknown };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      if (!payload.challengeId) {
        return json(res, 400, { error: "missing challengeId" });
      }
      const challenge = challenges.get(payload.challengeId);
      if (!challenge || typeof challenge !== "object") {
        return json(res, 404, { error: "challenge not found" });
      }
      const nodeId = (challenge as any).nodeId ?? "0x0";
      const kind = payload.challengeType ?? (challenge as any).challengeType ?? "U";
      if (kind === "S") {
        const query = ((challenge as any).querySpec ?? {}) as { cid?: string; chunkIndex?: number };
        const cid = query.cid;
        const chunkIndex = Number(query.chunkIndex ?? 0);
        if (!cid) {
          return json(res, 400, { error: "missing cid in challenge querySpec" });
        }
        loadStorageProof(
          { storageDirPath: storageDir, blockstore: storageBlockstore, cache: merkleLeavesCache },
          cid,
          chunkIndex,
        )
          .then(async (proof) => {
            const storageResponseBody = {
                ok: true,
                cid,
                chunkIndex,
                leafHash: proof.leafHash,
                chunkDataHash: proof.leafHash,
                merkleRoot: proof.merkleRoot,
                merklePath: proof.merklePath,
              };
            const storageResponseAtMs = Date.now();
            const isV2 = (challenge as any)?.version === 2;
            // Phase C: for v2 storage receipts, carry tipHash/tipHeight and
            // sign EIP-712 so the agent's v2 verifier can check the
            // freshness window. Without these the agent's verifyV2Receipt
            // rejects with "invalid tipHash". Legacy v1 path stays as is.
            if (isV2 && nodeSignerV2) {
              const tip = await fetchLatestBlock();
              const sig = await signReceiptV2(
                payload.challengeId!, nodeSigner.poseNodeId, storageResponseBody, storageResponseAtMs,
                tip.hash, tip.number,
              );
              return json(res, 200, {
                challengeId: payload.challengeId,
                nodeId: nodeSigner.poseNodeId,
                responseAtMs: storageResponseAtMs,
                responseBody: storageResponseBody,
                responseBodyHash: `0x${keccak256Hex(Buffer.from(stableStringify(storageResponseBody), "utf8"))}`,
                tipHash: tip.hash,
                tipHeight: tip.number.toString(),
                nodeSig: sig,
              });
            }
            return json(res, 200, {
              challengeId: payload.challengeId,
              nodeId: nodeSigner.poseNodeId,
              responseAtMs: storageResponseAtMs,
              responseBody: storageResponseBody,
              nodeSig: signReceipt(payload.challengeId, nodeSigner.poseNodeId, storageResponseBody, storageResponseAtMs),
            });
          })
          .catch((error) => {
            return json(res, 500, { error: `storage proof failed: ${String(error)}` });
          });
        return;
      }

      const responseAtMs = Date.now();
      const minBlockNumber = Number((challenge as any)?.querySpec?.minBlockNumber ?? 0);
      const isV2Challenge = (challenge as any)?.version === 2;
      if (kind === "U") {
        const blockNumber = minBlockNumber > 0 ? minBlockNumber : 1;
        const buildUptimeResponse = async (blockHash: string | null) => {
          const uptimeBody: Record<string, unknown> = { ok: true, blockNumber };
          if (blockHash) uptimeBody.blockHash = blockHash;

          if (isV2Challenge && nodeSignerV2) {
            const tip = await fetchLatestBlock();
            const sig = await signReceiptV2(
              payload.challengeId!, nodeSigner.poseNodeId, uptimeBody, responseAtMs,
              tip.hash, tip.number,
            );
            return json(res, 200, {
              challengeId: payload.challengeId,
              nodeId: nodeSigner.poseNodeId,
              responseAtMs,
              responseBody: uptimeBody,
              responseBodyHash: `0x${keccak256Hex(Buffer.from(stableStringify(uptimeBody), "utf8"))}`,
              tipHash: tip.hash,
              tipHeight: tip.number.toString(),
              nodeSig: sig,
            });
          }
          return json(res, 200, {
            challengeId: payload.challengeId,
            nodeId: nodeSigner.poseNodeId,
            responseAtMs,
            responseBody: uptimeBody,
            nodeSig: signReceipt(payload.challengeId!, nodeSigner.poseNodeId, uptimeBody, responseAtMs),
          });
        };
        fetchBlockHash(blockNumber)
          .then((blockHash) => buildUptimeResponse(blockHash))
          .catch(() => buildUptimeResponse(null));
        return;
      }
      // Only U/S/R are valid PoSe challenge types (U and S already returned
      // above). Reject anything else — pre-fix an unknown type fell through
      // to a fallback that echoed the caller-supplied request field back
      // into the receipt body and the node SIGNED it, turning /pose/receipt
      // into a signing oracle: an unauthenticated caller could register a
      // bogus-type challenge via /pose/challenge and obtain a node-signed
      // receipt over arbitrary attacker-supplied JSON.
      if (kind !== "R") {
        return json(res, 400, { error: `unknown challenge type: ${String(kind)}` });
      }
      const responseBody = buildRelayResponseBody(payload.challengeId, challenge, responseAtMs);
      // Phase C: v2 Relay receipt carries tipHash + EIP-712 signature,
      // same shape as Uptime/Storage. Without these the agent's
      // verifyV2Receipt rejects with "invalid tipHash". Fall back to v1
      // EIP-191 for legacy deployments.
      if (isV2Challenge && nodeSignerV2) {
        void (async () => {
          const tip = await fetchLatestBlock();
          const sig = await signReceiptV2(
            payload.challengeId!, nodeSigner.poseNodeId, responseBody, responseAtMs,
            tip.hash, tip.number,
          );
          json(res, 200, {
            challengeId: payload.challengeId,
            nodeId: nodeSigner.poseNodeId,
            responseAtMs,
            responseBody,
            responseBodyHash: `0x${keccak256Hex(Buffer.from(stableStringify(responseBody), "utf8"))}`,
            tipHash: tip.hash,
            tipHeight: tip.number.toString(),
            nodeSig: sig,
          });
        })();
        return;
      }
      return json(res, 200, {
        challengeId: payload.challengeId,
        nodeId: nodeSigner.poseNodeId,
        responseAtMs,
        responseBody,
        nodeSig: signReceipt(payload.challengeId, nodeSigner.poseNodeId, responseBody, responseAtMs),
      });
    });
    return;
  }

  // v2: Witness attestation endpoint
  if (req.method === "POST" && req.url === "/pose/witness") {
    if (!nodeSignerV2) {
      return json(res, 501, { error: "v2 protocol not enabled" });
    }
    if (!poseWitnessAuth.isAuthorized(req)) {
      return json(res, 401, { error: "unauthorized witness request" });
    }
    // #292: body bounded via readBody (1 MB cap). Same DoS class as
    // /pose/challenge — pre-fix used unbounded body accumulation.
    readBoundedBody(req, res, (body) => {
      // #222: parity with the other two POST endpoints — wrap
      // JSON.parse so a malformed body returns 400 instead of
      // crashing the process via uncaughtException.
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      // #322: validate field types + shapes BEFORE reaching the EIP-712
      // sign path. Pre-fix only `!field` / `=== undefined` checks ran,
      // so any truthy value (objects, arrays, non-hex strings, numbers)
      // flowed to nodeSignerV2.eip712.signTypedData and surfaced via
      // the .catch as 500 "witness signing failed: <leaked V8/ethers
      // TypeError>". Same family as #214 (ethers error leak) / #294
      // (V8 error leak).
      const result = validatePoseWitnessPayload(rawPayload);
      if (!result.ok) {
        return json(res, result.status, { error: result.error });
      }
      const fields = result.fields;

      // #667 (audit follow-up) — Push-verification gate. Three states:
      //   (a) Caller supplied all push fields + reader configured →
      //       run verifier; on failure return 400 (no signature).
      //   (b) Caller supplied push fields but reader is missing →
      //       cannot run verifier; treat as misconfiguration (502).
      //   (c) Caller did NOT supply push fields:
      //       - poseWitnessRequireVerified=true → 400 (strict rollout)
      //       - otherwise → legacy rubber-stamp path (with a debug log
      //         so operators can spot un-migrated callers)
      const hasPushFields = fields.responseBody !== undefined;
      if (hasPushFields) {
        if (!poseWitnessReaderOrNull) {
          return json(res, 502, { error: "witness verification not configured" });
        }
        verifyPushedReceipt(
          {
            challengeId: fields.challengeId,
            nodeId: fields.nodeId,
            responseBodyHash: fields.responseBodyHash,
            responseBody: fields.responseBody!,
            responseAtMs: fields.responseAtMs!,
            nodeSig: fields.nodeSig!,
            tipHash: fields.tipHash!,
            tipHeight: fields.tipHeight!,
          },
          {
            chainId: BigInt(chainId),
            verifyingContract,
            freshnessWindowMs: poseWitnessFreshnessMs,
            contractReader: poseWitnessReaderOrNull,
            // #746 — when the layer-7 toggle is on, run the witness's
            // independent semantic verifier (currently uptime tipHash via
            // local RPC). Returns the `ResultCode` the witness signs into
            // the v3 EIP-712 digest.
            ...(poseWitnessLayer7Enabled
              ? {
                  layer7Verifier: async (input) =>
                    layer7VerifyForWitness({
                      responseBody: input.responseBody,
                      tipHash: input.tipHash,
                      tipHeight: input.tipHeight,
                    }),
                }
              : {}),
          },
        )
          .then(verifyResult => {
            if (!verifyResult.ok) {
              return json(res, verifyResult.status, { error: verifyResult.error });
            }
            // #746 — pass through the resultCode (if the layer-7 verifier ran)
            // so signAndRespond can produce a v3 typehash signature binding it.
            return signAndRespond(verifyResult.resultCode);
          })
          .catch(error => {
            log.error("witness push-verification failed", { error: String(error) });
            return json(res, 500, { error: "witness verification failed" });
          });
        return;
      }
      if (poseWitnessRequireVerified) {
        return json(res, 400, {
          error: "push verification required (responseBody/responseAtMs/nodeSig/tipHash/tipHeight missing)",
        });
      }
      // Legacy rubber-stamp path — preserved for migration window.
      log.warn("witness signing without push verification", {
        challengeId: fields.challengeId,
        nodeId: fields.nodeId,
      });
      return signAndRespond();

      function signAndRespond(resultCode?: number): void {
      const signV1 = signWitnessAttestation(
        fields.challengeId,
        fields.nodeId,
        fields.responseBodyHash,
        fields.witnessIndex,
      );
      // #667 — produce v2 signature too when caller passed `epochId`. The
      // contract's `_validateWitnessQuorumV2` prefers v2 (which binds the
      // signature to `epochId`) and falls back to v1 during rollout. We
      // sign both so a single witness endpoint can serve mixed-version
      // clients during the migration window.
      const signV2 = fields.epochId !== undefined
        ? signWitnessAttestationV2(
            fields.challengeId,
            fields.nodeId,
            fields.responseBodyHash,
            fields.witnessIndex,
            fields.epochId,
          )
        : Promise.resolve<string | null>(null);
      // #746 — produce v3 signature when push-verify yielded a Layer-7
      // semantic result. Without `resultCode` we cannot bind it into the
      // EIP-712 digest, so the v3 path is only emitted when we ran the
      // verifier ourselves (push path) — bookkeeping the caller can
      // distinguish by checking `witnessSigV3` presence.
      const signV3 = (fields.epochId !== undefined && resultCode !== undefined)
        ? signWitnessAttestationV3(
            fields.challengeId,
            fields.nodeId,
            fields.responseBodyHash,
            resultCode,
            fields.witnessIndex,
            fields.epochId,
          )
        : Promise.resolve<string | null>(null);
      Promise.all([signV1, signV2, signV3])
        .then(([witnessSig, witnessSigV2, witnessSigV3]) => {
          return json(res, 200, {
            challengeId: fields.challengeId,
            nodeId: fields.nodeId,
            responseBodyHash: fields.responseBodyHash,
            witnessIndex: fields.witnessIndex,
            attestedAtMs: BigInt(Date.now()).toString(),
            witnessSig,
            ...(witnessSigV2 ? { witnessSigV2 } : {}),
            ...(witnessSigV3 ? { witnessSigV3 } : {}),
            ...(resultCode !== undefined ? { resultCode } : {}),
          });
        })
        .catch((error) => {
          // #322: input is now validated up-front, so anything that
          // throws here is an internal signing failure — keep the
          // String(error) (which goes to ops logs) but don't leak it
          // to the client.
          log.error("witness signing failed", { error: String(error) });
          return json(res, 500, { error: "witness signing failed" });
        });
      }
    });
    return;
  }

  return json(res, 404, { error: "not found" });
});

// #350: server-level slowloris protection — same values p2p.ts has
// had for ages. Bounds headers / total request / keep-alive idle.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(port, bind, () => {
  log.info("listening", { bind, port });
});

function resolveStorageDir(dataDir: string, configured?: string): string {
  if (configured) return configured;
  return join(dataDir, "storage");
}

function buildRelayResponseBody(
  challengeId: string,
  challenge: Record<string, unknown>,
  responseAtMs: number,
): Record<string, unknown> {
  const routeTag = String((challenge.querySpec as Record<string, unknown> | undefined)?.routeTag ?? "l1-l2");
  const relayMsg = `pose:relay:${challengeId}:${routeTag}:${responseAtMs}`;
  const witness = {
    relayer: nodeSigner.nodeId,
    challengeId,
    routeTag,
    responseAtMs,
    signature: nodeSigner.sign(relayMsg),
  };
  return { ok: true, routeTag, witness };
}


const selfRpcUrl = process.env.COC_SELF_RPC_URL || `http://127.0.0.1:${port}`;

async function fetchLatestBlock(): Promise<{ hash: string; number: bigint }> {
  try {
    const rpcUrl = process.env.COC_RPC_URL || "http://127.0.0.1:18780";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
        signal: controller.signal,
      });
      const body = await resp.json() as { result?: { hash?: string; number?: string } };
      const hash = body?.result?.hash ?? "0x" + "0".repeat(64);
      const num = body?.result?.number ? BigInt(body.result.number) : 0n;
      return { hash, number: num };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { hash: "0x" + "0".repeat(64), number: 0n };
  }
}

async function fetchBlockHash(blockNumber: number): Promise<string | null> {
  const TIMEOUT_MS = 3000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const rpcUrl = process.env.COC_RPC_URL || `http://127.0.0.1:18780`;
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: [`0x${blockNumber.toString(16)}`, false],
        }),
        signal: controller.signal,
      });
      const body = await resp.json() as { result?: { hash?: string } };
      const hash = body?.result?.hash;
      if (typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
        return hash;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
