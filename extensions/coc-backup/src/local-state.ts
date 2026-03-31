import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { BackupPersistenceState, BackupRecoveryPackage } from "./types.ts"

const META_DIR_NAME = ".coc-backup"
const STATE_FILE_NAME = "state.json"
const RECOVERY_FILE_NAME = "latest-recovery.json"

const DEFAULT_STATE: BackupPersistenceState = {
  version: 1,
  latestAgentId: null,
  lastManifestCid: null,
  incrementalCount: 0,
  lastBackupAt: null,
  lastFullBackupAt: null,
  latestRecoveryPackagePath: null,
  pendingResurrectionRequestId: null,
  pendingCarrierId: null,
}

export function getMetaDir(dataDir: string): string {
  return join(dataDir, META_DIR_NAME)
}

export function getStateFilePath(dataDir: string): string {
  return join(getMetaDir(dataDir), STATE_FILE_NAME)
}

export function getLatestRecoveryPackagePath(dataDir: string): string {
  return join(getMetaDir(dataDir), RECOVERY_FILE_NAME)
}

async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function readBackupState(dataDir: string): Promise<BackupPersistenceState> {
  const state = await readJsonFile<BackupPersistenceState>(getStateFilePath(dataDir))
  if (!state || state.version !== 1) return { ...DEFAULT_STATE }
  return {
    ...DEFAULT_STATE,
    ...state,
  }
}

export async function writeBackupState(dataDir: string, state: BackupPersistenceState): Promise<string> {
  const path = getStateFilePath(dataDir)
  await ensureParentDir(path)
  await writeFile(path, JSON.stringify(state, null, 2))
  return path
}

export async function patchBackupState(
  dataDir: string,
  patch: Partial<BackupPersistenceState>,
): Promise<BackupPersistenceState> {
  const current = await readBackupState(dataDir)
  const next = {
    ...current,
    ...patch,
    version: 1 as const,
  }
  await writeBackupState(dataDir, next)
  return next
}

export async function readLatestRecoveryPackage(dataDir: string): Promise<BackupRecoveryPackage | null> {
  const path = getLatestRecoveryPackagePath(dataDir)
  const pkg = await readJsonFile<BackupRecoveryPackage>(path)
  if (!pkg || pkg.version !== 1) return null
  return pkg
}

export async function writeLatestRecoveryPackage(
  dataDir: string,
  pkg: BackupRecoveryPackage,
): Promise<string> {
  const path = getLatestRecoveryPackagePath(dataDir)
  await ensureParentDir(path)
  await writeFile(path, JSON.stringify(pkg, null, 2))
  return path
}

export async function readRecoveryPackageFromPath(path: string): Promise<BackupRecoveryPackage> {
  const pkg = await readJsonFile<BackupRecoveryPackage>(path)
  if (!pkg || pkg.version !== 1) {
    throw new Error(`Invalid recovery package: ${path}`)
  }
  return pkg
}
