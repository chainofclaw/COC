import type { Command } from "commander"

export interface PluginLogger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

export interface PluginToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(params: any): Promise<any>
}

export type PluginHookName =
  | "stop"
  | "session_end"
  | "before_compaction"
  | "after_compaction"
  | "gateway_stop"

export interface PluginHookEvent {
  sessionId?: string
  messageCount?: number
  durationMs?: number
  reason?: string
  tokensBeforeCompaction?: number
  tokensAfterCompaction?: number
}

export interface OpenClawPluginApi {
  logger: PluginLogger
  pluginConfig?: unknown
  registerCli(
    handler: (ctx: { program: Command }) => Promise<void> | void,
    options: { commands: string[] },
  ): void
  registerTool(definition: PluginToolDefinition): void
  registerHook?(
    name: PluginHookName,
    handler: (event?: PluginHookEvent) => Promise<void> | void,
  ): void
}
