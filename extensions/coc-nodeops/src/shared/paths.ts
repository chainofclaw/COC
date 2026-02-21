import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export function resolveCocRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "../../../COC");
}

export function resolveRuntimeDir(): string {
  return join(resolveCocRoot(), "runtime");
}

export function resolveDataDir(raw?: string): string {
  if (!raw || raw.trim().length === 0) {
    return join(homedir(), ".clawdbot", "coc");
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}
