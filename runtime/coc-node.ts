import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Wallet } from "ethers";
import { loadConfig } from "./lib/config.ts";
import { InMemoryStore } from "./lib/state.ts";
import { buildMerklePath } from "../node/src/ipfs-merkle.ts";
import type { UnixFsFileMeta } from "../node/src/ipfs-types.ts";
import { createNodeSigner, buildReceiptSignMessage } from "../node/src/crypto/signer.ts";
import { keccak256Hex } from "../services/relayer/keccak256.ts";
import { createLogger } from "../node/src/logger.ts";

const log = createLogger("coc-node");

const config = await loadConfig();
const bind = process.env.COC_NODE_BIND || config.nodeBind || "127.0.0.1";
const port = Number(process.env.COC_NODE_PORT || config.nodePort || 18780);
const storageDir = resolveStorageDir(config.dataDir, config.storageDir);

const nodePrivateKey = process.env.COC_NODE_PK || Wallet.createRandom().privateKey;
const nodeSigner = createNodeSigner(nodePrivateKey);

function signReceipt(challengeId: string, nodeId: string, responseBody: Record<string, unknown>): string {
  const bodyHash = `0x${keccak256Hex(Buffer.from(stableStringify(responseBody), "utf8"))}`;
  const msg = buildReceiptSignMessage(challengeId, nodeId, bodyHash);
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
        loadStorageProof(storageDir, cid, chunkIndex)
          .then((proof) => {
            const storageResponseBody = {
                ok: true,
                cid,
                chunkIndex,
                leafHash: proof.leafHash,
                chunkDataHash: proof.leafHash,
                merkleRoot: proof.merkleRoot,
                merklePath: proof.merklePath,
              };
            return json(res, 200, {
              challengeId: payload.challengeId,
              nodeId: nodeSigner.nodeId,
              responseAtMs: Date.now(),
              responseBody: storageResponseBody,
              nodeSig: signReceipt(payload.challengeId, nodeSigner.nodeId, storageResponseBody),
            });
          })
          .catch((error) => {
            return json(res, 500, { error: `storage proof failed: ${String(error)}` });
          });
        return;
      }

      const responseAtMs = Date.now();
      const minBlockNumber = Number((challenge as any)?.querySpec?.minBlockNumber ?? 0);
      const responseBody =
        kind === "R"
          ? buildRelayResponseBody(payload.challengeId, challenge, responseAtMs)
          : kind === "U"
            ? { ok: true, blockNumber: minBlockNumber > 0 ? minBlockNumber : 1 }
            : { ok: true, echo: payload.payload ?? null };
      return json(res, 200, {
        challengeId: payload.challengeId,
        nodeId: nodeSigner.nodeId,
        responseAtMs,
        responseBody,
        nodeSig: signReceipt(payload.challengeId, nodeSigner.nodeId, responseBody),
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

async function loadStorageProof(storageDirPath: string, cid: string, chunkIndex: number): Promise<{
  leafHash: string;
  merkleRoot: string;
  merklePath: string[];
}> {
  const meta = await readFileMeta(storageDirPath);
  const file = meta[cid];
  if (!file) {
    throw new Error(`file meta not found for cid ${cid}`);
  }
  const leafHash = file.merkleLeaves[chunkIndex];
  if (!leafHash) {
    throw new Error(`invalid chunk index ${chunkIndex}`);
  }
  const merklePath = buildMerklePath(file.merkleLeaves, chunkIndex);
  return {
    leafHash,
    merkleRoot: file.merkleRoot,
    merklePath,
  };
}

async function readFileMeta(storageDirPath: string): Promise<Record<string, UnixFsFileMeta>> {
  try {
    const raw = await readFile(join(storageDirPath, "file-meta.json"), "utf-8");
    return JSON.parse(raw) as Record<string, UnixFsFileMeta>;
  } catch {
    return {};
  }
}
