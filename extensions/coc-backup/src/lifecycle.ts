import { readFile } from "node:fs/promises"
import { keccak256, toUtf8Bytes } from "ethers"
import type { CocBackupConfig } from "./config-schema.ts"
import type { SoulClient } from "./soul-client.ts"
import type { IpfsClient } from "./ipfs-client.ts"
import type { BackupScheduler } from "./backup/scheduler.ts"
import type {
  BackupReceipt,
  BackupRecoveryPackage,
  DoctorReport,
  RecommendedAction,
} from "./types.ts"
import {
  getLatestRecoveryPackagePath,
  getStateFilePath,
  readBackupState,
  readLatestRecoveryPackage,
  readRecoveryPackageFromPath,
} from "./local-state.ts"
import { deriveDefaultAgentId, pathExists, resolveHomePath } from "./utils.ts"

interface Logger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

const ZERO_BYTES32 = `0x${"0".repeat(64)}`

export interface RestorePlan {
  manifestCid: string
  targetDir: string
  key: string
  isPassword: boolean
  source: "manifest" | "package" | "latest-local"
  recoveryPackage: BackupRecoveryPackage | null
}

export interface InitFlowOptions {
  agentId?: string
  identityCid?: string
  resurrectionKeyHash?: string
  maxOfflineDuration?: number
}

export interface InitFlowResult {
  agentId: string
  alreadyRegistered: boolean
  registrationTxHash: string | null
  backupReceipt: BackupReceipt
  resurrectionConfigured: boolean
  resurrectionTxHash: string | null
  recoveryPackagePath: string | null
  statePath: string
}

async function resolveIdentityCid(
  config: CocBackupConfig,
  ipfs: IpfsClient,
  fallbackIdentityCid?: string,
): Promise<string> {
  if (fallbackIdentityCid) return fallbackIdentityCid

  const baseDir = resolveHomePath(config.dataDir)
  try {
    const identityData = await readFile(`${baseDir}/IDENTITY.md`)
    return keccak256(toUtf8Bytes(await ipfs.add(identityData)))
  } catch {
    return keccak256(toUtf8Bytes("empty-identity"))
  }
}

function buildRecommendedActions(report: Omit<DoctorReport, "actions">): RecommendedAction[] {
  const actions: RecommendedAction[] = []

  if (!report.local.dataDirExists) {
    actions.push({
      id: "check_data_dir",
      label: "检查数据目录",
      description: "当前 dataDir 不存在或不可访问，需要先确认 Agent 数据目录配置。",
      command: null,
    })
  }

  if (!report.chain.registered) {
    actions.push({
      id: "init",
      label: "执行初始化",
      description: "注册 soul、执行首次全量备份并生成本地恢复包。",
      command: "coc-backup init",
    })
    return actions
  }

  if (report.chain.backupCount === 0) {
    actions.push({
      id: "first_backup",
      label: "执行首次备份",
      description: "当前已注册但没有链上备份，应立即执行全量备份。",
      command: "coc-backup backup --full",
    })
  }

  if (!report.ipfs.reachable) {
    actions.push({
      id: "check_ipfs",
      label: "检查 IPFS",
      description: "IPFS 当前不可达，后续备份与恢复都会受阻。",
      command: null,
    })
  }

  if (report.chain.backupOverdue) {
    actions.push({
      id: "run_backup",
      label: "立即备份",
      description: "最新备份已过期，建议立即触发一次备份。",
      command: "coc-backup backup",
    })
  }

  if (report.restore.blocked) {
    actions.push({
      id: "fix_restore",
      label: "修复恢复材料",
      description: report.restore.reason ?? "恢复链路缺少必要材料。",
      command: report.restore.requiresPassword
        ? "coc-backup restore --latest-local --password <password>"
        : null,
    })
  }

  if (!report.resurrection.configured) {
    actions.push({
      id: "configure_resurrection",
      label: "配置复活",
      description: "建议尽快配置复活密钥和离线阈值，避免只有备份没有复活能力。",
      command: "coc-backup configure-resurrection --key-hash <hash>",
    })
  }

  if (report.resurrection.pendingRequestId && report.resurrection.readiness) {
    const readiness = report.resurrection.readiness
    if (!readiness.carrierConfirmed) {
      actions.push({
        id: "confirm_resurrection",
        label: "确认载体",
        description: "复活请求已创建，但载体尚未确认承载。",
        command: "coc-backup resurrection confirm",
      })
    } else if (readiness.canComplete) {
      actions.push({
        id: "complete_resurrection",
        label: "完成复活",
        description: "复活请求已满足链上条件，可直接完成。",
        command: "coc-backup resurrection complete",
      })
    } else {
      actions.push({
        id: "check_resurrection",
        label: "查看复活状态",
        description: "复活请求存在，但还未满足完成条件。",
        command: "coc-backup resurrection status",
      })
    }
  }

  return actions
}

export async function buildDoctorReport(
  config: CocBackupConfig,
  soul: SoulClient,
  ipfs: IpfsClient,
): Promise<DoctorReport> {
  const dataDir = resolveHomePath(config.dataDir)
  const statePath = getStateFilePath(dataDir)
  const recoveryPackagePath = getLatestRecoveryPackagePath(dataDir)
  const localState = await readBackupState(dataDir)
  const recoveryPackage = await readLatestRecoveryPackage(dataDir)
  const dataDirExists = await pathExists(dataDir)
  const ipfsReachable = await ipfs.ping()

  let agentId: string | null = null
  let owner: string | null = null
  let backupCount = 0
  let lastBackupAt: number | null = null
  let backupOverdue = false
  let resurrectionConfigured = false
  let offline = false
  let pendingRequest = null
  let pendingReadiness = null

  const onChainAgentId = await soul.getAgentIdForOwner().catch(() => ZERO_BYTES32)
  if (onChainAgentId !== ZERO_BYTES32) {
    agentId = onChainAgentId
    const soulInfo = await soul.getSoul(onChainAgentId)
    owner = soulInfo.owner
    backupCount = soulInfo.backupCount
    lastBackupAt = soulInfo.lastBackupAt > 0 ? soulInfo.lastBackupAt : null
    const overdueThresholdSeconds = Math.max(Math.floor((config.autoBackupIntervalMs * 2) / 1000), 6 * 60 * 60)
    backupOverdue = lastBackupAt !== null && (Math.floor(Date.now() / 1000) - lastBackupAt > overdueThresholdSeconds)

    const resurrectionConfig = await soul.getResurrectionConfig(onChainAgentId)
    resurrectionConfigured = resurrectionConfig.configured
    if (resurrectionConfigured) {
      offline = await soul.isOffline(onChainAgentId)
    }

    if (localState.pendingResurrectionRequestId) {
      try {
        pendingRequest = await soul.getResurrectionRequest(localState.pendingResurrectionRequestId)
        pendingReadiness = await soul.getResurrectionReadiness(localState.pendingResurrectionRequestId)
        if (pendingRequest.executed) {
          pendingRequest = null
          pendingReadiness = null
        }
      } catch {
        pendingRequest = null
        pendingReadiness = null
      }
    }
  }

  const restoreReason =
    backupCount > 0 && !recoveryPackage
      ? "存在链上备份，但本地缺少 latest-recovery.json，无法直接恢复最新快照。"
      : recoveryPackage?.requiresPassword && !config.encryptionPassword
        ? "当前恢复包要求密码解密，但插件配置中缺少 encryptionPassword。"
        : null

  const restoreBlocked = restoreReason !== null
  const restoreAvailable = Boolean(recoveryPackage?.latestManifestCid)

  let state: DoctorReport["state"] = "healthy"
  if (!dataDirExists) {
    state = restoreAvailable && !restoreBlocked ? "restore_ready" : "attention_required"
  } else if (!agentId) {
    state = "unregistered"
  } else if (!ipfsReachable) {
    state = "ipfs_unreachable"
  } else if (backupCount === 0) {
    state = "registered_no_backup"
  } else if (restoreBlocked) {
    state = "restore_blocked"
  } else if (pendingRequest) {
    state = "resurrection_pending"
  } else if (offline) {
    state = "offline"
  } else if (backupOverdue) {
    state = "backup_overdue"
  } else if (!resurrectionConfigured) {
    state = "resurrection_unconfigured"
  }

  const reportWithoutActions: Omit<DoctorReport, "actions"> = {
    state,
    generatedAt: new Date().toISOString(),
    agentId,
    local: {
      dataDir,
      dataDirExists,
      statePath,
      recoveryPackagePath,
    },
    ipfs: {
      reachable: ipfsReachable,
    },
    chain: {
      registered: Boolean(agentId),
      owner,
      backupCount,
      lastBackupAt,
      backupOverdue,
    },
    restore: {
      available: restoreAvailable,
      blocked: restoreBlocked,
      reason: restoreReason,
      latestManifestCid: recoveryPackage?.latestManifestCid ?? null,
      encryptionMode: recoveryPackage?.encryptionMode ?? "unknown",
      requiresPassword: recoveryPackage?.requiresPassword ?? false,
      packagePresent: recoveryPackage !== null,
    },
    resurrection: {
      configured: resurrectionConfigured,
      offline,
      pendingRequestId: pendingRequest?.requestId ?? null,
      request: pendingRequest,
      readiness: pendingReadiness,
    },
  }

  return {
    ...reportWithoutActions,
    actions: buildRecommendedActions(reportWithoutActions),
  }
}

export async function resolveRestorePlan(
  config: CocBackupConfig,
  options: {
    manifestCid?: string
    packagePath?: string
    latestLocal?: boolean
    targetDir?: string
    password?: string
  },
): Promise<RestorePlan> {
  const sourceCount = [options.manifestCid, options.packagePath, options.latestLocal ? "latest-local" : null]
    .filter(Boolean)
    .length

  if (sourceCount !== 1) {
    throw new Error("Restore requires exactly one source: --manifest-cid, --package, or --latest-local")
  }

  const dataDir = resolveHomePath(config.dataDir)
  const targetDir = resolveHomePath(options.targetDir ?? config.dataDir)
  const isPassword = options.password !== undefined
  const key = options.password ?? config.privateKey

  let recoveryPackage: BackupRecoveryPackage | null = null
  let manifestCid: string
  let source: RestorePlan["source"]

  if (options.packagePath) {
    source = "package"
    recoveryPackage = await readRecoveryPackageFromPath(resolveHomePath(options.packagePath))
    manifestCid = recoveryPackage.latestManifestCid
  } else if (options.latestLocal) {
    source = "latest-local"
    recoveryPackage = await readLatestRecoveryPackage(dataDir)
    if (!recoveryPackage) {
      throw new Error("No local recovery package found. Run a backup first or provide --package.")
    }
    manifestCid = recoveryPackage.latestManifestCid
  } else if (options.manifestCid) {
    source = "manifest"
    manifestCid = options.manifestCid
  } else {
    throw new Error("Missing restore source")
  }

  if (recoveryPackage?.requiresPassword && !isPassword) {
    throw new Error("Restore blocked: this recovery package requires --password")
  }

  return {
    manifestCid,
    targetDir,
    key,
    isPassword,
    source,
    recoveryPackage,
  }
}

export async function runInitFlow(
  config: CocBackupConfig,
  soul: SoulClient,
  ipfs: IpfsClient,
  scheduler: BackupScheduler,
  options: InitFlowOptions = {},
): Promise<InitFlowResult> {
  const dataDir = resolveHomePath(config.dataDir)
  const existingAgentId = await soul.getAgentIdForOwner()
  const desiredAgentId = options.agentId ?? deriveDefaultAgentId(soul.address)
  const alreadyRegistered = existingAgentId !== ZERO_BYTES32

  if (alreadyRegistered && existingAgentId !== desiredAgentId) {
    throw new Error(
      `Wallet already owns soul ${existingAgentId}; refusing to initialize with mismatched agentId ${desiredAgentId}`,
    )
  }

  let registrationTxHash: string | null = null
  const agentId = alreadyRegistered ? existingAgentId : desiredAgentId

  if (!alreadyRegistered) {
    const identityCid = await resolveIdentityCid(config, ipfs, options.identityCid)
    registrationTxHash = await soul.registerSoul(agentId, identityCid)
  }

  const backupReceipt = await scheduler.runBackup(true)
  if (backupReceipt.status === "registration_required") {
    throw new Error("Initialization failed: soul registration is still required")
  }
  if (backupReceipt.status !== "completed") {
    throw new Error(`Initialization failed: unexpected backup status ${backupReceipt.status}`)
  }

  let resurrectionTxHash: string | null = null
  if (options.resurrectionKeyHash) {
    resurrectionTxHash = await soul.configureResurrection(
      agentId,
      options.resurrectionKeyHash,
      options.maxOfflineDuration ?? 86400,
    )
  }

  const latestState = await readBackupState(dataDir)
  return {
    agentId,
    alreadyRegistered,
    registrationTxHash,
    backupReceipt,
    resurrectionConfigured: Boolean(options.resurrectionKeyHash),
    resurrectionTxHash,
    recoveryPackagePath: latestState.latestRecoveryPackagePath,
    statePath: getStateFilePath(dataDir),
  }
}
