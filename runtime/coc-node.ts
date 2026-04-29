import http from "node:http";
import { join } from "node:path";
import { Wallet } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { InMemoryStore } from "./lib/state.ts";
import { IpfsBlockstore } from "../node/src/ipfs-blockstore.ts";
import { loadStorageProof, MerkleLeavesCache } from "./lib/storage-proof.ts";
import { createNodeSigner, createNodeSignerV2, buildReceiptSignMessage } from "../node/src/crypto/signer.ts";
import { keccak256Hex } from "../services/relayer/keccak256.ts";
import { createLogger } from "../node/src/logger.ts";
import { buildDomain, RECEIPT_TYPES, WITNESS_TYPES } from "../node/src/crypto/eip712-types.ts";

const log = createLogger("coc-node");

const config = await loadConfig();
const bind = process.env.COC_NODE_BIND || config.nodeBind || "127.0.0.1";
const port = Number(process.env.COC_NODE_PORT || config.nodePort || 18780);
const storageDir = resolveStorageDir(config.dataDir, config.storageDir);

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

const nodePrivateKey = process.env.COC_NODE_PK || Wallet.createRandom().privateKey;
const nodeSigner = createNodeSigner(nodePrivateKey);

// v2: EIP-712 signer for PoSe v2 protocol
const useV2 = config.protocolVersion === 2;
const chainId = config.chainId ?? 20241224;
const verifyingContract = config.verifyingContract ?? config.poseManagerV2Address ?? "0x0000000000000000000000000000000000000000";
const nodeSignerV2 = useV2
  ? createNodeSignerV2(nodePrivateKey, buildDomain(BigInt(chainId), verifyingContract))
  : null;

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

function json(res: http.ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    return json(res, 404, { error: "not found" });
  }

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  if (req.method === "POST" && req.url === "/pose/challenge") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as { challengeId?: string };
      if (!payload.challengeId) {
        return json(res, 400, { error: "missing challengeId" });
      }
      challenges.set(payload.challengeId, payload);
      return json(res, 200, { accepted: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/pose/receipt") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as { challengeId?: string; challengeType?: string; payload?: unknown };
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
      const responseBody =
        kind === "R"
          ? buildRelayResponseBody(payload.challengeId, challenge, responseAtMs)
          : { ok: true, echo: payload.payload ?? null };
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
    let body = "";
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as {
        challengeId?: string;
        nodeId?: string;
        responseBodyHash?: string;
        witnessIndex?: number;
      };
      if (!payload.challengeId || !payload.nodeId || !payload.responseBodyHash || payload.witnessIndex === undefined) {
        return json(res, 400, { error: "missing required fields" });
      }
      signWitnessAttestation(
        payload.challengeId,
        payload.nodeId,
        payload.responseBodyHash,
        payload.witnessIndex,
      )
        .then((witnessSig) => {
          return json(res, 200, {
            challengeId: payload.challengeId,
            nodeId: payload.nodeId,
            responseBodyHash: payload.responseBodyHash,
            witnessIndex: payload.witnessIndex,
            attestedAtMs: BigInt(Date.now()).toString(),
            witnessSig,
          });
        })
        .catch((error) => {
          return json(res, 500, { error: `witness signing failed: ${String(error)}` });
        });
    });
    return;
  }

  return json(res, 404, { error: "not found" });
});

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

