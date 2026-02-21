import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { resolveDataDir, resolveRuntimeDir } from "../shared/paths.ts";

export type CocProcessKind = "node" | "agent" | "relayer";

export interface CocProcessConfig {
  runtimeDir?: string;
  dataDir: string;
  nodePort: number;
  nodeBind: string;
  agentIntervalMs: number;
  agentBatchSize: number;
  agentSampleSize: number;
  relayerIntervalMs: number;
  nodeUrl: string;
  l1RpcUrl?: string;
  l2RpcUrl?: string;
}

export class CocProcessManager {
  private readonly logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  async start(kind: CocProcessKind, config: CocProcessConfig): Promise<void> {
    const dataDir = resolveDataDir(config.dataDir);
    await mkdir(dataDir, { recursive: true });

    const pidPath = this.pidPath(dataDir, kind);
    const existingPid = await this.readPid(pidPath);
    if (existingPid && this.isRunning(existingPid)) {
      this.logger.warn(`COC ${kind} 已在运行: ${existingPid}`);
      return;
    }

    const runtimeDir = config.runtimeDir?.trim() ? config.runtimeDir.trim() : resolveRuntimeDir();
    const scriptPath = join(runtimeDir, `coc-${kind}.ts`);
    await access(scriptPath);

    const logPath = join(dataDir, `coc-${kind}.log`);
    const env = {
      ...process.env,
      COC_DATA_DIR: dataDir,
      COC_NODE_BIND: config.nodeBind,
      COC_NODE_PORT: String(config.nodePort),
      COC_AGENT_INTERVAL_MS: String(config.agentIntervalMs),
      COC_AGENT_BATCH_SIZE: String(config.agentBatchSize),
      COC_AGENT_SAMPLE_SIZE: String(config.agentSampleSize),
      COC_RELAYER_INTERVAL_MS: String(config.relayerIntervalMs),
      COC_NODE_URL: config.nodeUrl,
      COC_L1_RPC_URL: config.l1RpcUrl ?? "",
      COC_L2_RPC_URL: config.l2RpcUrl ?? ""
    };

    const logHandle = await open(logPath, "a");
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
      env,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      detached: true
    });
    await logHandle.close();

    child.unref();
    await writeFile(pidPath, String(child.pid));

    this.logger.info(`COC ${kind} 已启动: ${child.pid}`);
  }

  async stop(kind: CocProcessKind, dataDir: string): Promise<void> {
    const pidPath = this.pidPath(resolveDataDir(dataDir), kind);
    const pid = await this.readPid(pidPath);
    if (!pid) {
      this.logger.warn(`COC ${kind} 未运行`);
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      await unlink(pidPath);
      this.logger.info(`COC ${kind} 已停止: ${pid}`);
    } catch (error) {
      this.logger.error(`停止失败: ${String(error)}`);
      throw error;
    }
  }

  async status(kind: CocProcessKind, dataDir: string): Promise<{ pid?: number; running: boolean }> {
    const pidPath = this.pidPath(resolveDataDir(dataDir), kind);
    const pid = await this.readPid(pidPath);
    if (!pid) {
      return { running: false };
    }
    return { pid, running: this.isRunning(pid) };
  }

  async readLogs(kind: CocProcessKind, dataDir: string): Promise<string> {
    const logPath = join(resolveDataDir(dataDir), `coc-${kind}.log`);
    try {
      return await readFile(logPath, "utf-8");
    } catch {
      return "";
    }
  }

  private pidPath(dataDir: string, kind: CocProcessKind): string {
    return join(dataDir, `coc-${kind}.pid`);
  }

  private async readPid(path: string): Promise<number | undefined> {
    try {
      const raw = await readFile(path, "utf-8");
      const pid = Number(raw.trim());
      return Number.isFinite(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async openLogStream(path: string) {
    const { createWriteStream } = await import("node:fs");
    return createWriteStream(path, { flags: "a" });
  }
}
