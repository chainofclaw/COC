/**
 * Shared helpers for OpenClaw COC skills v0.2.
 *
 * Each skill (`pose-status`, `chain-stats`, `health`, `upgrade`) imports
 * the same flag-parsing, config-loading, RPC-call, and error-envelope
 * primitives so the operator-facing contract stays uniform across the
 * suite. The spec in `docs/openclaw-skills-v0.2-spec.md` § 0 codifies
 * what's exported here; bumping the schemaVersion requires updating
 * both this module AND the spec in lockstep.
 *
 * pose-status (the original L.2 skeleton) ships a copy of these
 * primitives inline rather than depending on this module — it predates
 * the extraction. A follow-up (Phase L.3) will migrate it; do NOT
 * refactor it speculatively without that explicit follow-up.
 */

import { env, exit, stderr, stdout } from "node:process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const SCHEMA_VERSION = "0.2"
export const DEFAULT_TIMEOUT_MS = 5000

export interface CliFlagsBase {
  node: string
  rpc?: string
  authToken?: string
  json: boolean
  timeoutMs: number
  help: boolean
  /** Skill-specific flags merged in by parseSkillArgs */
  rest: string[]
}

export interface NodeRecord {
  rpc: string
  authToken?: string
}

export interface NodeOpsConfig {
  defaultNode: string
  nodes: Record<string, NodeRecord>
}

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError" }
}

/**
 * Parse the COMMON v0.2 flags. Skill-specific flags (e.g. `--epoch`,
 * `--window`) are returned in `rest` for the caller to handle.
 *
 * Throws UsageError on malformed input; main() turns that into exit 2.
 */
export function parseBaseFlags(args: string[]): CliFlagsBase {
  const out: CliFlagsBase = {
    node: "default",
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
    rest: [],
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    switch (a) {
      case "--help": case "-h": out.help = true; break
      case "--node": out.node = requireValue(args, ++i, a); break
      case "--rpc": out.rpc = requireValue(args, ++i, a); break
      case "--auth-token": out.authToken = requireValue(args, ++i, a); break
      case "--timeout-ms": out.timeoutMs = Number(requireValue(args, ++i, a)); break
      case "--json": out.json = true; break
      default:
        out.rest.push(a)
    }
  }
  return out
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i]
  if (v === undefined || v.startsWith("--")) {
    throw new UsageError(`flag ${flag} requires a value`)
  }
  return v
}

/**
 * Load `~/.coc/nodeops.json`. Returns null if the file is missing or
 * malformed; callers fall back to `127.0.0.1:18780`.
 */
export function loadConfig(): NodeOpsConfig | null {
  const path = join(homedir(), ".coc", "nodeops.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as NodeOpsConfig
  } catch {
    return null
  }
}

export function resolveNode(flags: CliFlagsBase): { rpc: string; authToken?: string } {
  if (flags.rpc) {
    return { rpc: flags.rpc, authToken: flags.authToken ?? env.COC_RPC_AUTH_TOKEN }
  }
  const cfg = loadConfig()
  if (!cfg) {
    return { rpc: "http://127.0.0.1:18780", authToken: flags.authToken ?? env.COC_RPC_AUTH_TOKEN }
  }
  const id = flags.node === "default" ? cfg.defaultNode : flags.node
  const rec = cfg.nodes[id]
  if (!rec) {
    throw new UsageError(`node "${id}" not in ~/.coc/nodeops.json`)
  }
  return { rpc: rec.rpc, authToken: flags.authToken ?? rec.authToken ?? env.COC_RPC_AUTH_TOKEN }
}

/**
 * Single JSON-RPC call. Honors the timeout via AbortController; rethrows
 * the underlying error so callers can map it to skill-specific exit codes.
 */
export async function rpcCall<T = unknown>(
  rpc: string,
  method: string,
  params: unknown[],
  authToken: string | undefined,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { result?: T; error?: { code: number; message: string } }
    if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`)
    return json.result as T
  } finally {
    clearTimeout(timer)
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string; skill: string; remediation?: string }
}

export function emitError(envelope: ErrorEnvelope, json: boolean): void {
  if (json) {
    stdout.write(JSON.stringify(envelope) + "\n")
  } else {
    stderr.write(`${envelope.error.code}: ${envelope.error.message}\n`)
    if (envelope.error.remediation) stderr.write(`  → ${envelope.error.remediation}\n`)
  }
}

/**
 * Map an arbitrary thrown value to the skill v0.2 exit-code convention.
 * Returns the exit code; the caller is responsible for emitError before
 * returning to the OS.
 */
export function classifyError(err: unknown): { code: number; envelope: Omit<ErrorEnvelope["error"], "skill"> } {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ""
  const isTimeout = name === "AbortError"
    || msg.includes("aborted")
    || msg.includes("fetch failed")
    || msg.includes("HTTP")
    || msg.includes("ECONNREFUSED")
  if (isTimeout) {
    return {
      code: 3,
      envelope: {
        code: "RPC_TIMEOUT",
        message: msg,
        remediation: "increase --timeout-ms or check node health",
      },
    }
  }
  if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) {
    return {
      code: 4,
      envelope: {
        code: "AUTH_FAILURE",
        message: msg,
        remediation: "check --auth-token / COC_RPC_AUTH_TOKEN",
      },
    }
  }
  return {
    code: 1,
    envelope: { code: "INTERNAL", message: msg },
  }
}

// Side-effect-free utility re-export so individual skills don't have to
// import `process` at their top level when they only need stdout.
export { exit, stderr, stdout }
