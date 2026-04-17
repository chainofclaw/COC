import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export function resolveCocRoot(): string {
  // From src/shared/ → src/ → coc-nodeops/ → extensions/ → COC/
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "../../../..");
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
